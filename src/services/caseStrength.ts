import { z } from "zod";
import type { FirmSession } from "../db/tenant";
import { PermissionDeniedError, UserFacingError } from "../errors";
import { analyze, type ClaimIn, type DamageIn, type FactIn, type Gap, type MatterIn, type SourceRef, type StrengthReport } from "../intelligence/strength";
import { INTERNAL_ROLES } from "../security/permissions";
import { recordAudit } from "./audit";
import { claimsMatrix } from "./authorities";
import { getContradictions } from "./contradictions";
import { citationsFor, claimView } from "./dna";
import { getMatter } from "./matters";

/**
 * Phase 11 part 1: Case Outcome Intelligence for one Matter (src/intelligence/strength.ts has the rules).
 *
 * Worked out each time it's read, as the reader, under row-level security: only what this person can see counts
 * (an item behind an ethical wall they're outside of isn't counted, and the page says so). Firm staff only:
 * clients and other outside people never see it (it is attorney work product). Uses no AI and isn't counted as an
 * AI question.
 */
export const MAX_CLAIMS = 200;

function reader(s: FirmSession) {
  if (!INTERNAL_ROLES.has(s.actor.role)) throw new PermissionDeniedError("see Case Outcome Intelligence");
}

export interface GapReview { gapKey: string; decision: "set_aside" | "context"; note: string; by: string; at: Date }
export interface CaseStrength extends StrengthReport {
  reviews: Map<string, GapReview>;
  /** Open gaps (not set aside), most severe first: the attorney priority list is the first few. */
  open: Gap[];
  setAside: (Gap & { review: GapReview })[];
  truncated: boolean;
}

export async function caseStrength(s: FirmSession, matterId: string): Promise<CaseStrength> {
  reader(s);
  await getMatter(s, matterId);

  const claimRows = (await s.client.query<{ id: string }>(
    `SELECT id FROM huis.dna_nodes WHERE matter_id = $1 AND status = 'confirmed' AND kind IN ('claim', 'defense')
      ORDER BY created_at, id LIMIT ${MAX_CLAIMS + 1}`, [matterId])).rows;
  const matrix = await claimsMatrix(s, matterId);
  const authoritiesOf = new Map(matrix.map((c) => [c.id, c.authorities]));

  const views = [];
  for (const c of claimRows.slice(0, MAX_CLAIMS)) views.push(await claimView(s, c.id));

  // Witnesses per fact (people linked by "witness to" or "involves", confirmed both ways).
  const factIds = [...new Set(views.flatMap((v) => v.elements.flatMap((e) => [...e.supporting, ...e.contradicting].map((f) => f.id))))];
  const witnessesOf = new Map<string, { id: string; label: string }[]>();
  if (factIds.length) {
    const { rows } = await s.client.query<{ fact_id: string; id: string; label: string }>(
      `SELECT CASE WHEN l.from_id = ANY($1::uuid[]) THEN l.from_id ELSE l.to_id END AS fact_id, p.id, p.label
         FROM huis.dna_links l JOIN huis.dna_nodes p ON p.id = CASE WHEN l.from_id = ANY($1::uuid[]) THEN l.to_id ELSE l.from_id END
        WHERE (l.from_id = ANY($1::uuid[]) OR l.to_id = ANY($1::uuid[])) AND l.relation IN ('witness_to', 'involves')
          AND l.status = 'confirmed' AND p.kind = 'person' AND p.status = 'confirmed'`, [factIds]);
    for (const r of rows) witnessesOf.set(r.fact_id, [...(witnessesOf.get(r.fact_id) ?? []), { id: r.id, label: r.label }]);
  }

  const fact = (f: { id: string; label: string; citations: { id: string; evidenceId: string | null; noteId: string | null; quote: string; sourceTitle: string; isEmail: boolean }[] }): FactIn => ({
    id: f.id, label: f.label, witnesses: witnessesOf.get(f.id) ?? [],
    sources: f.citations.map((c): SourceRef => ({
      kind: c.noteId ? "note" : c.isEmail ? "email" : "document", id: c.id, title: c.sourceTitle, quote: c.quote, evidenceId: c.evidenceId, noteId: c.noteId,
    })),
  });
  const counts = (st: string, lst: string) => st === "confirmed" && lst === "confirmed";
  const claims: ClaimIn[] = views.map((v) => ({
    id: v.claim.id, kind: v.claim.kind as "claim" | "defense", label: v.claim.label, details: v.claim.details,
    authorities: (authoritiesOf.get(v.claim.id) ?? []).map((a) => ({ citation: a.authority.citation, url: a.authority.url, verified: a.authority.verified !== null, stance: a.stance })),
    elements: v.elements.map((e) => ({
      id: e.element.id, label: e.element.label, details: e.element.details,
      supporting: e.supporting.filter((f) => counts(f.status, f.linkStatus)).map(fact),
      contradicting: e.contradicting.filter((f) => counts(f.status, f.linkStatus)).map(fact),
      pendingSuggestions: [...e.supporting, ...e.contradicting].filter((f) => !counts(f.status, f.linkStatus)).length,
    })),
  }));

  // Damages: confirmed damage items, their amounts and sources.
  const dmg = (await s.client.query<{ id: string; label: string; amount: string | null }>(
    "SELECT id, label, amount FROM huis.dna_nodes WHERE matter_id = $1 AND kind = 'damage' AND status = 'confirmed' ORDER BY created_at LIMIT 500", [matterId])).rows;
  const dmgCites = await citationsFor(s, dmg.map((d) => d.id));
  const damages: DamageIn[] = dmg.map((d) => ({ id: d.id, label: d.label, amount: d.amount === null ? null : Number(d.amount), sources: (dmgCites.get(d.id) ?? []).length }));

  const p = (await s.client.query<{ facts: number; links: number; other: number; total: number; unread: number }>(
    `SELECT (SELECT count(*)::int FROM huis.dna_nodes WHERE matter_id = $1 AND status = 'suggested' AND kind IN ('fact', 'damage')) AS facts,
            (SELECT count(*)::int FROM huis.dna_links WHERE matter_id = $1 AND status = 'suggested') AS links,
            (SELECT count(*)::int FROM huis.dna_nodes WHERE matter_id = $1 AND status = 'suggested' AND kind NOT IN ('fact', 'damage')) AS other,
            (SELECT count(*)::int FROM huis.evidence_items WHERE matter_id = $1 AND status <> 'infected') AS total,
            (SELECT count(*)::int FROM huis.evidence_items WHERE matter_id = $1 AND status <> 'infected'
               AND (status <> 'clean' OR coalesce(extraction_status::text, '') NOT IN ('done', 'partial'))) AS unread`, [matterId])).rows[0]!;
  const con = await getContradictions(s, matterId);

  const input: MatterIn = {
    matterId, claims, damages,
    contradictions: { confirmed: con.confirmed.length, potential: con.potential.length },
    pending: { suggestedFacts: p.facts, suggestedLinks: p.links, suggestedOther: p.other },
    evidence: { total: p.total, unread: p.unread },
  };
  const report = analyze(input);

  const reviews = new Map<string, GapReview>();
  for (const r of (await s.client.query(
    `SELECT g.gap_key, g.decision, g.note, g.decided_at, coalesce(u.full_name, 'Former user') AS by
       FROM huis.case_gap_reviews g LEFT JOIN huis.users u ON u.id = g.decided_by WHERE g.matter_id = $1`, [matterId])).rows) {
    reviews.set(r.gap_key, { gapKey: r.gap_key, decision: r.decision, note: r.note, by: r.by, at: r.decided_at });
  }
  const open = report.gaps.filter((g) => reviews.get(g.key)?.decision !== "set_aside");
  const setAside = report.gaps.filter((g) => reviews.get(g.key)?.decision === "set_aside").map((g) => ({ ...g, review: reviews.get(g.key)! }));
  return { ...report, reviews, open, setAside, truncated: claimRows.length > MAX_CLAIMS };
}

const reviewInput = z.object({
  gapKey: z.string().regex(/^[a-z-]+(:[0-9a-f-]{36})?$/).max(200),
  decision: z.enum(["set_aside", "context", "reopen"]),
  note: z.string().trim().max(2000).optional().default(""),
});

/** An attorney's answer to a gap: set it aside (with why), add context, or put it back. Audited. */
export async function reviewGap(s: FirmSession, matterId: string, input: unknown): Promise<void> {
  reader(s);
  if (s.actor.role === "read_only") throw new PermissionDeniedError("review gaps");
  await getMatter(s, matterId);
  const v = reviewInput.parse(input);
  if (v.decision === "reopen") {
    await s.client.query("DELETE FROM huis.case_gap_reviews WHERE matter_id = $1 AND gap_key = $2", [matterId, v.gapKey]);
  } else {
    if (!v.note) throw new UserFacingError(v.decision === "set_aside" ? "Say why it's being set aside." : "Add the context.");
    await s.client.query(
      `INSERT INTO huis.case_gap_reviews (firm_id, matter_id, gap_key, decision, note, decided_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (matter_id, gap_key) DO UPDATE SET decision = EXCLUDED.decision, note = EXCLUDED.note, decided_by = EXCLUDED.decided_by, decided_at = now()`,
      [s.actor.firmId, matterId, v.gapKey, v.decision, v.note, s.actor.userId]);
  }
  await recordAudit(s, "case_strength.gap_reviewed", { targetType: "matter", targetId: matterId, matterId, metadata: { gap: v.gapKey, decision: v.decision } });
}
