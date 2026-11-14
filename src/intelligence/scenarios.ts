/*
 * Phase 11 part 4: What-If Analysis and Trial Readiness, from the same fixed rules as case strength (no AI, no
 * probability, no dollar values). A what-if never changes Case DNA: it re-runs the rules on a copy of the confirmed
 * evidence with the attorney's assumptions applied, and shows what moves and why.
 */
import type { PersonIn } from "./discovery";
import { analyze, type ClaimIn, type ElementResult, type FactIn, type Gap, type MatterIn, type Rating, type StrengthReport } from "./strength";

export type ChangeKind = "add-document" | "add-witness" | "lose-fact" | "lose-witness";
export interface Change { kind: ChangeKind; id: string }
export const MAX_CHANGES = 20;

const LABEL: Record<ChangeKind, string> = {
  "add-document": "Suppose a new document or email supports",
  "add-witness": "Suppose a witness confirms",
  "lose-fact": "Suppose this fact is excluded, rebutted or can't be proved",
  "lose-witness": "Suppose this witness becomes unavailable",
};

/** Parses `kind:uuid` strings (from the page's form). Unknown kinds, malformed ids and duplicates are dropped. */
export function parseChanges(raw: string[] | string | undefined): Change[] {
  const list = (Array.isArray(raw) ? raw : raw ? [raw] : []).slice(0, 200);
  const seen = new Set<string>();
  const out: Change[] = [];
  for (const r of list) {
    const m = /^(add-document|add-witness|lose-fact|lose-witness):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(String(r));
    if (!m || seen.has(m[0]!)) continue;
    seen.add(m[0]!);
    out.push({ kind: m[1] as ChangeKind, id: m[2]! });
  }
  return out;
}

export interface WhatIfInput {
  elements: { id: string; label: string; claim: string }[];
  facts: { id: string; label: string; uses: string[] }[];
  witnesses: { id: string; label: string; facts: number }[];
}

/** What the attorney can change: claim elements, confirmed facts used by an element, and linked witnesses. */
export function whatIfOptions(m: MatterIn): WhatIfInput {
  const elements: WhatIfInput["elements"] = [];
  const facts = new Map<string, { id: string; label: string; uses: string[] }>();
  const witnesses = new Map<string, { id: string; label: string; facts: Set<string> }>();
  for (const c of m.claims) for (const e of c.elements) {
    elements.push({ id: e.id, label: e.label, claim: c.label });
    for (const [side, list] of [["supports", e.supporting], ["contradicts", e.contradicting]] as const) for (const f of list) {
      const entry = facts.get(f.id) ?? { id: f.id, label: f.label, uses: [] };
      entry.uses.push(`${side} "${e.label}" (${c.label})`);
      facts.set(f.id, entry);
      for (const w of f.witnesses) {
        const we = witnesses.get(w.id) ?? { id: w.id, label: w.label, facts: new Set<string>() };
        we.facts.add(f.id);
        witnesses.set(w.id, we);
      }
    }
  }
  return {
    elements,
    facts: [...facts.values()],
    witnesses: [...witnesses.values()].map((w) => ({ id: w.id, label: w.label, facts: w.facts.size })),
  };
}

/** Applies the assumptions to a copy of the Matter's confirmed evidence. Throws on a change that doesn't fit this Matter. */
export function applyChanges(m: MatterIn, changes: Change[]): MatterIn {
  if (changes.length > MAX_CHANGES) throw new RangeError(`Test at most ${MAX_CHANGES} assumptions at a time.`);
  const opts = whatIfOptions(m);
  const elementIds = new Set(opts.elements.map((e) => e.id));
  const factIds = new Set(opts.facts.map((f) => f.id));
  const witnessIds = new Set(opts.witnesses.map((w) => w.id));
  for (const c of changes) {
    const ok = c.kind === "lose-fact" ? factIds.has(c.id) : c.kind === "lose-witness" ? witnessIds.has(c.id) : elementIds.has(c.id);
    if (!ok) throw new RangeError("One of the assumptions doesn't belong to this Matter's claims any more.");
  }
  const lostFacts = new Set(changes.filter((c) => c.kind === "lose-fact").map((c) => c.id));
  const lostWitnesses = new Set(changes.filter((c) => c.kind === "lose-witness").map((c) => c.id));
  const keep = (f: FactIn): FactIn | null => (lostFacts.has(f.id) ? null : { ...f, witnesses: f.witnesses.filter((w) => !lostWitnesses.has(w.id)) });
  const claims: ClaimIn[] = m.claims.map((c) => ({
    ...c,
    elements: c.elements.map((e) => {
      const supporting = e.supporting.map(keep).filter((f): f is FactIn => f !== null);
      const contradicting = e.contradicting.map(keep).filter((f): f is FactIn => f !== null);
      changes.forEach((ch, i) => {
        if (ch.id !== e.id) return;
        // Hypothetical facts get ids that can't collide with real ones, and each added document is independent.
        if (ch.kind === "add-document") {
          supporting.push({ id: `what-if-${i}`, label: "Hypothetical document or email", witnesses: [],
            sources: [{ kind: "document", id: `what-if-doc-${i}`, title: "Hypothetical document", quote: "", evidenceId: `what-if-doc-${i}`, noteId: null }] });
        } else if (ch.kind === "add-witness") {
          supporting.push({ id: `what-if-${i}`, label: "Hypothetical witness testimony", sources: [], witnesses: [{ id: `what-if-witness-${i}`, label: "Hypothetical witness" }] });
        }
      });
      return { ...e, supporting, contradicting };
    }),
  }));
  return { ...m, claims };
}

export interface ElementDelta { id: string; label: string; claim: string; before: number; after: number; why: string[] }
export interface ClaimDelta { id: string; label: string; kind: "claim" | "defense"; before: { score: number | null; rating: Rating }; after: { score: number | null; rating: Rating } }
export interface WhatIf {
  assumptions: string[];
  before: StrengthReport["overall"];
  after: StrengthReport["overall"];
  claims: ClaimDelta[];
  elements: ElementDelta[];
  gapsClosed: Gap[];
  gapsOpened: Gap[];
  notChecked: string[];
}

const describe = (m: MatterIn, c: Change): string => {
  const o = whatIfOptions(m);
  const name = c.kind === "lose-fact" ? o.facts.find((f) => f.id === c.id)?.label
    : c.kind === "lose-witness" ? o.witnesses.find((w) => w.id === c.id)?.label
      : (() => { const e = o.elements.find((x) => x.id === c.id); return e ? `"${e.label}" (${e.claim})` : undefined; })();
  return `${LABEL[c.kind]}: ${name ?? "?"}`;
};

/** Re-runs the rules with the assumptions and reports what moved. Only real changes are listed. */
export function whatIf(m: MatterIn, changes: Change[]): WhatIf {
  const base = analyze(m);
  const next = analyze(applyChanges(m, changes));
  const allBefore = [...base.claims, ...base.defenses];
  const allAfter = new Map([...next.claims, ...next.defenses].map((c) => [c.id, c]));
  const claims: ClaimDelta[] = [];
  const elements: ElementDelta[] = [];
  for (const c of allBefore) {
    const a = allAfter.get(c.id)!;
    if (c.score !== a.score || c.rating !== a.rating) claims.push({ id: c.id, label: c.label, kind: c.kind, before: { score: c.score, rating: c.rating }, after: { score: a.score, rating: a.rating } });
    const afterEls = new Map(a.elements.map((e) => [e.id, e]));
    for (const e of c.elements) {
      const ae = afterEls.get(e.id) as ElementResult;
      if (e.score !== ae.score) elements.push({ id: e.id, label: e.label, claim: c.label, before: e.score, after: ae.score, why: ae.lines.map((l) => `${l.points > 0 ? "+" : ""}${l.points}: ${l.why}`) });
    }
  }
  const beforeKeys = new Set(base.gaps.map((g) => g.key));
  const afterKeys = new Set(next.gaps.map((g) => g.key));
  return {
    assumptions: changes.map((c) => describe(m, c)),
    before: base.overall,
    after: next.overall,
    claims,
    elements,
    gapsClosed: base.gaps.filter((g) => !afterKeys.has(g.key)),
    gapsOpened: next.gaps.filter((g) => !beforeKeys.has(g.key)),
    notChecked: [
      "Whether the assumed evidence exists, is admissible, or would be believed: a hypothetical document counts like a real one.",
      "Damages and the defense's evidence aren't changed by these assumptions unless a fact you remove is used there.",
      "Nothing here is saved or changes Case DNA.",
    ],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Trial readiness

export interface ReadinessCategory { key: string; label: string; value: number | null; rule: string; why: string }
export interface Readiness {
  score: number | null;
  why: string;
  weakest: ReadinessCategory | null;
  categories: ReadinessCategory[];
  confidence: StrengthReport["confidence"];
}

const pct = (n: number, d: number) => Math.round((100 * n) / d);
const EXPERT_ROLE = /\bexpert\b/i;
const MEDICAL = /disab|accommodat/i;
const isDisabilityClaim = (claim: string) => /\bada\b|disab/i.test(claim);

/**
 * Trial readiness: only what Huis can measure from confirmed Case DNA. A category it can't measure is shown as
 * "not measured", never estimated, and the overall figure is the average of the measured ones.
 */
export function readiness(m: MatterIn, report: StrengthReport, people: PersonIn[]): Readiness {
  const els = report.claims.flatMap((c) => c.elements.map((e) => ({ c, e })));
  const cats: ReadinessCategory[] = [];

  cats.push({ key: "discovery", label: "Discovery", value: null, rule: "Not measured.",
    why: "Huis doesn't track discovery requests, responses or deadlines yet, so it can't say how complete discovery is. See \"What are we missing?\" for gaps." });

  const witnessed = els.filter(({ e }) => e.supporting.length > 0);
  cats.push(witnessed.length
    ? { key: "witnesses", label: "Witnesses", value: pct(witnessed.filter(({ e }) => e.witnesses.length > 0).length, witnessed.length),
        rule: "Supported claim elements with a witness linked to a supporting fact.",
        why: `${witnessed.filter(({ e }) => e.witnesses.length > 0).length} of ${witnessed.length} supported elements have a witness. Whether witnesses are prepared isn't tracked.` }
    : { key: "witnesses", label: "Witnesses", value: null, rule: "Supported claim elements with a witness linked to a supporting fact.", why: "No claim element is supported yet." });

  cats.push(els.length
    ? { key: "exhibits", label: "Exhibits", value: pct(els.filter(({ e }) => e.documentSources > 0).length, els.length),
        rule: "Claim elements with at least one document or email behind them.",
        why: `${els.filter(({ e }) => e.documentSources > 0).length} of ${els.length} elements have a document or email.${m.evidence.unread ? ` ${m.evidence.unread} uploaded item${m.evidence.unread === 1 ? " hasn't" : "s haven't"} been read yet.` : ""}` }
    : { key: "exhibits", label: "Exhibits", value: null, rule: "Claim elements with at least one document or email behind them.", why: "No claim elements yet." });

  const researched = els.filter(({ c, e }) => e.authorities.some((a) => a.verified) || c.authorities.some((a) => a.verified));
  cats.push(els.length
    ? { key: "research", label: "Legal research", value: pct(researched.length, els.length),
        rule: "Claim elements with a verified authority cited on the element or its claim.",
        why: `${researched.length} of ${els.length} elements have a verified authority. Unverified citations don't count.` }
    : { key: "research", label: "Legal research", value: null, rule: "Claim elements with a verified authority cited on the element or its claim.", why: "No claim elements yet." });

  const areas: string[] = [];
  if (m.damages.some((d) => (d.amount ?? 0) > 0)) areas.push("damages");
  if (report.claims.some((c) => c.elements.some((e) => MEDICAL.test(e.label) || (/qualified/i.test(e.label) && isDisabilityClaim(c.label))))) areas.push("medical");
  const experts = people.filter((p) => p.kind === "person" && p.role && EXPERT_ROLE.test(p.role));
  cats.push(areas.length
    ? { key: "experts", label: "Expert support", value: Math.min(100, pct(experts.length, areas.length)),
        rule: "People in Case DNA whose role names an expert, against the expert areas the rules flag (damages, medical).",
        why: `Areas flagged: ${areas.join(", ")}. ${experts.length ? `Experts in Case DNA: ${experts.map((p) => p.label).join(", ")}.` : "No one in Case DNA has an expert role."} Huis can't tell which area an expert covers or whether they're retained.` }
    : { key: "experts", label: "Expert support", value: null, rule: "People in Case DNA whose role names an expert, against the expert areas the rules flag (damages, medical).", why: "The rules flag no expert need (no damages amounts, no medical element)." });

  cats.push(m.damages.length
    ? { key: "damages", label: "Damages documentation", value: pct(m.damages.filter((d) => d.amount !== null && d.sources > 0).length, m.damages.length),
        rule: "Damage items with an amount and a document or email behind them.",
        why: `${m.damages.filter((d) => d.amount !== null && d.sources > 0).length} of ${m.damages.length} damage items have an amount and a document or email.` }
    : { key: "damages", label: "Damages documentation", value: 0, rule: "Damage items with an amount and a document or email behind them.", why: "No damages are recorded in Case DNA." });

  const measured = cats.filter((c) => c.value !== null);
  if (!measured.length || !els.length) {
    return { score: null, weakest: null, categories: cats, confidence: report.confidence,
      why: "Not enough is recorded to measure: add claims with their elements in Case DNA." };
  }
  const score = Math.round(measured.reduce((a, c) => a + c.value!, 0) / measured.length);
  const weakest = [...measured].sort((a, b) => a.value! - b.value!)[0]!;
  return {
    score, weakest, categories: cats, confidence: report.confidence,
    why: `Average of the ${measured.length} categories Huis can measure${cats.length > measured.length ? ` (${cats.filter((c) => c.value === null).map((c) => c.label).join(", ")} not measured)` : ""}.`,
  };
}
