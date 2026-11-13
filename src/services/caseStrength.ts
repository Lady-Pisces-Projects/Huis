import { z } from "zod";
import type { FirmSession } from "../db/tenant";
import { PermissionDeniedError, UserFacingError } from "../errors";
import { analyze, type ClaimIn, type DamageIn, type FactIn, type Gap, type MatterIn, type SourceRef, type StrengthReport } from "../intelligence/strength";
import { INTERNAL_ROLES } from "../security/permissions";
import { discovery, opposition, type Discovery, type Opposition, type PersonIn } from "../intelligence/discovery";
import { recordAudit } from "./audit";
import { authoritiesByNode } from "./authorities";
import { getContradictions } from "./contradictions";
import { citationsFor } from "./dna";
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
  const report = await analyzeMatterStrength(s, matterId);
  const { reviews } = await gapReviews(s, matterId);
  const open = report.gaps.filter((g) => reviews.get(g.key)?.decision !== "set_aside");
  const setAside = report.gaps.filter((g) => reviews.get(g.key)?.decision === "set_aside").map((g) => ({ ...g, review: reviews.get(g.key)! }));
  return { ...report, reviews, open, setAside };
}

type NodeRow = { id: string; kind: string; label: string; details: string };

/**
 * Everything the rules need, in a fixed number of queries whatever the Matter's size (security review 34: no
 * query per claim). The same rules as Case DNA's claim view: confirmed elements with a confirmed "element of"
 * link; facts that aren't rejected, counted only when the fact and its link are both confirmed.
 */
async function gather(s: FirmSession, matterId: string): Promise<{ input: MatterIn; truncated: boolean; people: PersonIn[]; suggestedPeople: number }> {
  const claimRows = (await s.client.query<NodeRow>(
    `SELECT id, kind, label, details FROM huis.dna_nodes WHERE matter_id = $1 AND status = 'confirmed' AND kind IN ('claim', 'defense')
      ORDER BY created_at, id LIMIT ${MAX_CLAIMS + 1}`, [matterId])).rows;
  const claimList = claimRows.slice(0, MAX_CLAIMS);
  const claimIds = claimList.map((c) => c.id);

  const elementRows = claimIds.length ? (await s.client.query<NodeRow & { claim_id: string }>(
    `SELECT l.to_id AS claim_id, e.id, e.kind, e.label, e.details
       FROM huis.dna_links l JOIN huis.dna_nodes e ON e.id = l.from_id
      WHERE l.to_id = ANY($1::uuid[]) AND l.relation = 'element_of' AND l.status = 'confirmed' AND e.kind = 'element' AND e.status = 'confirmed'
      ORDER BY e.created_at, e.label LIMIT 5000`, [claimIds])).rows : [];
  const elementIds = elementRows.map((e) => e.id);

  const factRows = elementIds.length ? (await s.client.query<NodeRow & { element_id: string; relation: string; status: string; link_status: string }>(
    `SELECT l.to_id AS element_id, l.relation, l.status AS link_status, f.id, f.kind, f.label, f.details, f.status
       FROM huis.dna_links l JOIN huis.dna_nodes f ON f.id = l.from_id
      WHERE l.to_id = ANY($1::uuid[]) AND l.relation IN ('supports', 'contradicts') AND l.status <> 'rejected' AND f.status <> 'rejected'
      ORDER BY f.event_date NULLS LAST, f.created_at LIMIT 20000`, [elementIds])).rows : [];
  const counted = factRows.filter((f) => f.status === "confirmed" && f.link_status === "confirmed");
  const factIds = [...new Set(counted.map((f) => f.id))];
  const cites = await citationsFor(s, factIds, 50_000);

  // Witnesses: people linked to a counted fact as "witness to" (a person merely involved isn't a witness: review 34).
  const witnessesOf = new Map<string, { id: string; label: string }[]>();
  if (factIds.length) {
    const { rows } = await s.client.query<{ fact_id: string; id: string; label: string }>(
      `SELECT CASE WHEN l.from_id = ANY($1::uuid[]) THEN l.from_id ELSE l.to_id END AS fact_id, p.id, p.label
         FROM huis.dna_links l JOIN huis.dna_nodes p ON p.id = CASE WHEN l.from_id = ANY($1::uuid[]) THEN l.to_id ELSE l.from_id END
        WHERE (l.from_id = ANY($1::uuid[]) OR l.to_id = ANY($1::uuid[])) AND l.relation = 'witness_to'
          AND l.status = 'confirmed' AND p.kind = 'person' AND p.status = 'confirmed' LIMIT 20000`, [factIds]);
    for (const r of rows) {
      const list = witnessesOf.get(r.fact_id) ?? [];
      if (!list.some((w) => w.id === r.id)) list.push({ id: r.id, label: r.label });
      witnessesOf.set(r.fact_id, list);
    }
  }

  // People and organizations in Case DNA, with their links to counted facts (for discovery and opposition, part 2).
  const peopleRows = (await s.client.query<{ id: string; kind: "person" | "organization"; label: string; role: string | null }>(
    `SELECT id, kind, label, role FROM huis.dna_nodes WHERE matter_id = $1 AND status = 'confirmed' AND kind IN ('person', 'organization')
      ORDER BY label LIMIT 2000`, [matterId])).rows;
  const personLinks = new Map<string, { factId: string; relation: "witness_to" | "involves" }[]>();
  if (factIds.length && peopleRows.length) {
    const { rows } = await s.client.query<{ person_id: string; fact_id: string; relation: "witness_to" | "involves" }>(
      `SELECT CASE WHEN l.from_id = ANY($1::uuid[]) THEN l.to_id ELSE l.from_id END AS person_id,
              CASE WHEN l.from_id = ANY($1::uuid[]) THEN l.from_id ELSE l.to_id END AS fact_id, l.relation
         FROM huis.dna_links l
        WHERE (l.from_id = ANY($1::uuid[]) OR l.to_id = ANY($1::uuid[])) AND l.relation IN ('witness_to', 'involves')
          AND l.status = 'confirmed' AND (l.from_id = ANY($2::uuid[]) OR l.to_id = ANY($2::uuid[])) LIMIT 20000`,
      [factIds, peopleRows.map((r) => r.id)]);
    for (const r of rows) personLinks.set(r.person_id, [...(personLinks.get(r.person_id) ?? []), { factId: r.fact_id, relation: r.relation }]);
  }
  const people: PersonIn[] = peopleRows.map((r) => ({ ...r, links: personLinks.get(r.id) ?? [] }));

  const authorities = await authoritiesByNode(s, matterId);
  const refs = (id: string) => (authorities.get(id) ?? []).map((a) => ({ citation: a.authority.citation, url: a.authority.url, verified: a.authority.verified !== null, stance: a.stance }));
  const fact = (f: NodeRow): FactIn => ({
    id: f.id, label: f.label, witnesses: witnessesOf.get(f.id) ?? [],
    sources: (cites.get(f.id) ?? []).map((c): SourceRef => ({
      kind: c.noteId ? "note" : c.isEmail ? "email" : "document", id: c.id, title: c.sourceTitle, quote: c.quote, evidenceId: c.evidenceId, noteId: c.noteId,
    })),
  });
  const claims: ClaimIn[] = claimList.map((c) => ({
    id: c.id, kind: c.kind as "claim" | "defense", label: c.label, details: c.details, authorities: refs(c.id),
    elements: elementRows.filter((e) => e.claim_id === c.id).map((e) => {
      const mine = factRows.filter((f) => f.element_id === e.id);
      const ok = (f: (typeof factRows)[number]) => f.status === "confirmed" && f.link_status === "confirmed";
      return {
        id: e.id, label: e.label, details: e.details, authorities: refs(e.id),
        supporting: mine.filter((f) => f.relation === "supports" && ok(f)).map(fact),
        contradicting: mine.filter((f) => f.relation === "contradicts" && ok(f)).map(fact),
        pendingSuggestions: mine.filter((f) => !ok(f)).length,
      };
    }),
  }));

  // Damages: confirmed items; "sourced" means cited to a document or email (an attorney note isn't: review 34).
  const dmg = (await s.client.query<{ id: string; label: string; amount: string | null }>(
    "SELECT id, label, amount FROM huis.dna_nodes WHERE matter_id = $1 AND kind = 'damage' AND status = 'confirmed' ORDER BY created_at LIMIT 500", [matterId])).rows;
  const dmgCites = await citationsFor(s, dmg.map((d) => d.id));
  const damages: DamageIn[] = dmg.map((d) => ({
    id: d.id, label: d.label, amount: d.amount === null ? null : Number(d.amount),
    sources: (dmgCites.get(d.id) ?? []).filter((c) => c.evidenceId).length,
  }));

  const p = (await s.client.query<{ facts: number; links: number; other: number; total: number; unread: number }>(
    `SELECT (SELECT count(*)::int FROM huis.dna_nodes WHERE matter_id = $1 AND status = 'suggested' AND kind IN ('fact', 'damage')) AS facts,
            (SELECT count(*)::int FROM huis.dna_links WHERE matter_id = $1 AND status = 'suggested') AS links,
            (SELECT count(*)::int FROM huis.dna_nodes WHERE matter_id = $1 AND status = 'suggested' AND kind NOT IN ('fact', 'damage')) AS other,
            (SELECT count(*)::int FROM huis.evidence_items WHERE matter_id = $1 AND status <> 'infected') AS total,
            (SELECT count(*)::int FROM huis.evidence_items WHERE matter_id = $1 AND status <> 'infected'
               AND (status <> 'clean' OR coalesce(extraction_status::text, '') NOT IN ('done', 'partial'))) AS unread`, [matterId])).rows[0]!;
  const con = await getContradictions(s, matterId);
  return {
    input: {
      matterId, claims, damages,
      contradictions: { confirmed: con.confirmed.length, potential: con.potential.length },
      pending: { suggestedFacts: p.facts, suggestedLinks: p.links, suggestedOther: p.other },
      evidence: { total: p.total, unread: p.unread },
    },
    truncated: claimRows.length > MAX_CLAIMS,
    people,
    suggestedPeople: (await s.client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM huis.dna_nodes WHERE matter_id = $1 AND status = 'suggested' AND kind IN ('person', 'organization')", [matterId])).rows[0]!.n,
  };
}

/** Part 2: "What are we missing?" and "If I were opposing counsel", from the same confirmed Case DNA. */
export async function discoveryAndOpposition(s: FirmSession, matterId: string): Promise<{ discovery: Discovery; opposition: Opposition; truncated: boolean }> {
  reader(s);
  await getMatter(s, matterId);
  const g = await gather(s, matterId);
  const report = analyze(g.input);
  return { discovery: discovery(g.input, report, g.people, g.suggestedPeople), opposition: opposition(g.input, report), truncated: g.truncated };
}

async function analyzeMatterStrength(s: FirmSession, matterId: string): Promise<StrengthReport & { truncated: boolean }> {
  const { input, truncated } = await gather(s, matterId);
  return { ...analyze(input), truncated };
}

async function gapReviews(s: FirmSession, matterId: string) {
  const reviews = new Map<string, GapReview>();
  for (const r of (await s.client.query(
    `SELECT g.gap_key, g.decision, g.note, g.decided_at, coalesce(u.full_name, 'Former user') AS by
       FROM huis.case_gap_reviews g LEFT JOIN huis.users u ON u.id = g.decided_by WHERE g.matter_id = $1 ORDER BY g.decided_at DESC LIMIT 1000`, [matterId])).rows) {
    reviews.set(r.gap_key, { gapKey: r.gap_key, decision: r.decision, note: r.note, by: r.by, at: r.decided_at });
  }
  return { reviews };
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
  // Only a gap the current analysis of this Matter shows (security review 34: no made-up keys).
  const current = (await analyzeMatterStrength(s, matterId)).gaps.some((g) => g.key === v.gapKey);
  const existing = (await s.client.query("SELECT 1 FROM huis.case_gap_reviews WHERE matter_id = $1 AND gap_key = $2", [matterId, v.gapKey])).rowCount;
  if (!current && !(v.decision === "reopen" && existing)) throw new UserFacingError("That gap isn't in this Matter's analysis any more.");
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
