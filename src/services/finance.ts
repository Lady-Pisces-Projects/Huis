import { z } from "zod";
import type { FirmSession } from "../db/tenant";
import { NotFoundError, PermissionDeniedError } from "../errors";
import { analyzeText, type Analysis, type FlagRule, MAX_TEXT, MIN_TRANSACTIONS } from "../finance/analyze";
import { INTERNAL_ROLES } from "../security/permissions";
import { recordAudit } from "./audit";
import { getEvidence, getEvidenceText } from "./evidence";
import { getMatter } from "./matters";

/**
 * Phase 10 part 4: financial evidence analysis (decision #30 b), by fixed rules — see src/finance/analyze.ts.
 *
 * Work product for firm staff who can see the Matter (ethical walls apply); clients and other outside users
 * never see it. It's worked out from the documents each time, as the reader: only evidence the reader can
 * see, and nothing about the analysis is stored. Opening one document's analysis is opening the document
 * (chain of custody and audit log, as in the viewer); the Matter summary is recorded once in the audit log.
 */
const uuid = z.uuid();
/** How many of a Matter's documents the summary reads (newest first). */
export const MAX_DOCUMENTS = 200;

function staff(s: FirmSession) {
  if (!INTERNAL_ROLES.has(s.actor.role)) throw new PermissionDeniedError("see financial analysis");
}

export interface FinancialDocument {
  evidenceId: string;
  filename: string;
  count: number;
  first: string | null;
  last: string | null;
  moneyIn: number;
  moneyOut: number;
  flags: Partial<Record<FlagRule, number>>;
}

export interface MatterFinancials {
  documents: FinancialDocument[];
  /** Documents read (with text) and whether there were more than the limit. */
  read: number;
  more: boolean;
  /** exact: false when the sums are too large to add up exactly (only on absurd input). */
  totals: { moneyIn: number; moneyOut: number; count: number; first: string | null; last: string | null; exact: boolean };
  months: { month: string; moneyIn: number; moneyOut: number; count: number }[];
  /** The same transaction (date, amount, description) in two documents: overlapping statements, or a copy. */
  overlaps: { date: string; amount: number; description: string; documents: { evidenceId: string; filename: string; line: number }[] }[];
}

/** The Matter's documents that read as financial (statements, ledgers, registers), with totals and flags. */
export async function matterFinancials(s: FirmSession, matterId: string): Promise<MatterFinancials> {
  staff(s);
  await getMatter(s, matterId);
  // Row-level security limits this to evidence the reader can see; clean items only.
  // Only as much text as the parser reads (security review 26, R26-11), and whether there are more documents
  // from a separate check rather than fetching an extra one.
  const { rows } = await s.client.query<{ id: string; original_filename: string; content: string }>(
    `SELECT i.id, i.original_filename, left(t.content, $3) AS content FROM huis.evidence_items i JOIN huis.evidence_text t ON t.evidence_id = i.id
      WHERE i.matter_id = $1 AND i.status = 'clean' AND t.char_count > 0
      ORDER BY i.uploaded_at DESC, i.id LIMIT $2`, [matterId, MAX_DOCUMENTS, MAX_TEXT]);
  const more = rows.length === MAX_DOCUMENTS && ((await s.client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM huis.evidence_items i JOIN huis.evidence_text t ON t.evidence_id = i.id
      WHERE i.matter_id = $1 AND i.status = 'clean' AND t.char_count > 0`, [matterId])).rows[0]?.n ?? 0) > MAX_DOCUMENTS;
  const documents: FinancialDocument[] = [];
  const months = new Map<string, { month: string; moneyIn: number; moneyOut: number; count: number }>();
  const byKey = new Map<string, MatterFinancials["overlaps"][number]>();
  const totals = { moneyIn: 0, moneyOut: 0, count: 0, first: null as string | null, last: null as string | null };
  for (const r of rows) {
    const a = analyzeText(r.content);
    if (!a.financial) continue;
    const flags: FinancialDocument["flags"] = {};
    for (const f of a.flags) flags[f.rule] = (flags[f.rule] ?? 0) + 1;
    documents.push({ evidenceId: r.id, filename: r.original_filename, count: a.totals.count, first: a.totals.first, last: a.totals.last,
      moneyIn: a.totals.moneyIn, moneyOut: a.totals.moneyOut, flags });
    totals.moneyIn += a.totals.moneyIn;
    totals.moneyOut += a.totals.moneyOut;
    totals.count += a.totals.count;
    if (a.totals.first && (!totals.first || a.totals.first < totals.first)) totals.first = a.totals.first;
    if (a.totals.last && (!totals.last || a.totals.last > totals.last)) totals.last = a.totals.last;
    for (const m of a.months) {
      const row = months.get(m.month) ?? { month: m.month, moneyIn: 0, moneyOut: 0, count: 0 };
      row.moneyIn += m.moneyIn; row.moneyOut += m.moneyOut; row.count += m.count;
      months.set(m.month, row);
    }
    for (const t of a.transactions) {
      const key = `${t.date}|${t.amount}|${t.description.toLowerCase().replace(/\s+/g, " ")}`;
      const o = byKey.get(key) ?? { date: t.date, amount: t.amount, description: t.description, documents: [] };
      if (!o.documents.some((d) => d.evidenceId === r.id)) o.documents.push({ evidenceId: r.id, filename: r.original_filename, line: t.line });
      byKey.set(key, o);
    }
  }
  await recordAudit(s, "matter.financial_viewed", { targetType: "matter", targetId: matterId, matterId, metadata: { documents: documents.length } });
  return {
    documents, read: rows.length, more, totals: { ...totals, exact: Number.isSafeInteger(totals.moneyIn) && Number.isSafeInteger(totals.moneyOut) },
    months: [...months.values()].sort((a, b) => (a.month < b.month ? -1 : 1)),
    overlaps: [...byKey.values()].filter((o) => o.documents.length > 1).slice(0, 200),
  };
}

export interface DocumentFinancials extends Analysis {
  evidenceId: string;
  matterId: string;
  filename: string;
  /** The document had no readable text yet (still being read, or a scan without text). */
  noText: boolean;
}

/**
 * One document's transactions, totals and flags (opening it, as in the viewer). Only a clean item (R26-9), and
 * only in the Matter it's asked for, checked before the text is read so no view is recorded otherwise (R26-10).
 */
export async function documentFinancials(s: FirmSession, evidenceId: string, matterId?: string): Promise<DocumentFinancials> {
  staff(s);
  if (!uuid.safeParse(evidenceId).success) throw new NotFoundError("Evidence");
  const item = await getEvidence(s, evidenceId);
  if (item.status !== "clean" || (matterId !== undefined && item.matterId !== matterId)) throw new NotFoundError("Evidence");
  const text = await getEvidenceText(s, evidenceId);
  const a = analyzeText(text?.content ?? "");
  return { ...a, evidenceId, matterId: item.matterId, filename: item.originalFilename, noText: !text };
}

export { MIN_TRANSACTIONS };
