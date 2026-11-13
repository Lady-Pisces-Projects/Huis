/**
 * Phase 11 part 1: Case Outcome Intelligence — case strength, the holes in the case, and next steps.
 *
 * Fixed, explainable rules over what the firm has confirmed in Case DNA (claims → elements → supporting and
 * contradicting facts → their sources and witnesses), its damages and its contradictions. No AI, no model and no
 * guessing: every number comes with the rule that produced it and the items behind it. These are evidence
 * coverage scores, never a probability of winning (Huis has no validated statistical model; the spec forbids
 * presenting them as one). Only confirmed facts and links count; Huis's suggestions waiting for review don't.
 */

export type Rating = "Very strong" | "Strong" | "Moderate" | "Weak" | "Insufficient information";
export type Severity = "Critical" | "High" | "Medium" | "Low";
export type Impact = "Liability" | "Causation" | "Damages" | "Credibility" | "Admissibility" | "Procedure" | "Discovery" | "Settlement";
export type Confidence = "High" | "Medium" | "Low";

export interface SourceRef { kind: "document" | "email" | "note"; id: string; title: string; quote: string; evidenceId: string | null; noteId: string | null }
export interface FactIn { id: string; label: string; sources: SourceRef[]; witnesses: { id: string; label: string }[] }
export interface ElementIn { id: string; label: string; details: string; supporting: FactIn[]; contradicting: FactIn[]; pendingSuggestions: number }
export interface ClaimIn { id: string; kind: "claim" | "defense"; label: string; details: string; elements: ElementIn[]; authorities: { citation: string; url: string; verified: boolean; stance: string }[] }
export interface DamageIn { id: string; label: string; amount: number | null; sources: number }
export interface MatterIn {
  matterId: string;
  claims: ClaimIn[];
  damages: DamageIn[];
  contradictions: { confirmed: number; potential: number };
  pending: { suggestedFacts: number; suggestedLinks: number; suggestedOther: number };
  evidence: { total: number; unread: number };
}

export interface ScoreLine { points: number; why: string }
export interface ElementResult {
  id: string; label: string; details: string; score: number; lines: ScoreLine[];
  supporting: FactIn[]; contradicting: FactIn[];
  documented: boolean; independentSources: number; witnesses: { id: string; label: string }[]; disputed: boolean;
  /** What would raise this element's score. */
  missing: string[];
}
export interface ClaimResult { id: string; kind: "claim" | "defense"; label: string; details: string; score: number | null; rating: Rating; why: string; elements: ElementResult[]; authorities: ClaimIn["authorities"] }
export interface Category { key: string; label: string; value: number | null; rule: string; why: string }
export interface Gap {
  key: string; severity: Severity; impact: Impact; title: string; detail: string;
  claimId: string | null; elementId: string | null; href: string;
  actions: string[];
}
export interface StrengthReport {
  overall: { score: number | null; rating: Rating; why: string };
  confidence: { level: Confidence; reasons: string[] };
  categories: Category[];
  claims: ClaimResult[];
  defenses: ClaimResult[];
  gaps: Gap[];
  strengths: { text: string; href: string }[];
}

const RULES = {
  supported: 40, documented: 25, twoSources: 15, witness: 10, threeSources: 10, perContradiction: -20, floor: 10,
} as const;
export const SCORE_RULES = RULES;

const pct = (n: number, d: number) => (d === 0 ? null : Math.round((100 * n) / d));
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function independent(facts: FactIn[]): SourceRef[] {
  const seen = new Map<string, SourceRef>();
  for (const f of facts) for (const s of f.sources) seen.set(s.evidenceId ? `e:${s.evidenceId}` : `n:${s.noteId}`, s);
  return [...seen.values()];
}

/** One element: fixed points for each kind of support, less for each confirmed contradicting fact. */
export function scoreElement(e: ElementIn): ElementResult {
  const lines: ScoreLine[] = [];
  const missing: string[] = [];
  const sources = independent(e.supporting);
  const docs = sources.filter((s) => s.kind !== "note");
  const witnesses = [...new Map(e.supporting.flatMap((f) => f.witnesses).map((w) => [w.id, w])).values()];
  let score = 0;
  if (e.supporting.length === 0) {
    lines.push({ points: 0, why: "No confirmed fact supports this element yet." });
    missing.push("A confirmed fact supporting this element, with its source.");
  } else {
    score += RULES.supported;
    lines.push({ points: RULES.supported, why: `${plural(e.supporting.length, "confirmed fact supports", "confirmed facts support")} it.` });
    if (docs.length > 0) {
      score += RULES.documented;
      lines.push({ points: RULES.documented, why: `Cited to ${plural(docs.length, "document or email", "documents or emails")}, not only attorney notes.` });
    } else {
      missing.push(sources.length ? "A document or email (so far only attorney notes)." : "A source for the supporting fact (a document or email).");
    }
    if (sources.length >= 2 && docs.length >= 1) {
      score += RULES.twoSources;
      lines.push({ points: RULES.twoSources, why: `${sources.length} independent sources.` });
    } else if (docs.length >= 1) {
      missing.push("A second, independent source.");
    }
    if (witnesses.length > 0) {
      score += RULES.witness;
      lines.push({ points: RULES.witness, why: `Witness linked: ${witnesses.map((w) => w.label).join(", ")}.` });
    } else {
      missing.push("A witness linked to a supporting fact.");
    }
    if (sources.length >= 3 && docs.length >= 1) {
      score += RULES.threeSources;
      lines.push({ points: RULES.threeSources, why: "Three or more independent sources." });
    }
    if (e.contradicting.length > 0) {
      const cut = Math.max(RULES.perContradiction * e.contradicting.length, RULES.floor - score);
      score += cut;
      lines.push({ points: cut, why: `${plural(e.contradicting.length, "confirmed fact contradicts", "confirmed facts contradict")} it.` });
    }
  }
  return {
    id: e.id, label: e.label, details: e.details, score: Math.max(0, Math.min(100, score)), lines,
    supporting: e.supporting, contradicting: e.contradicting,
    documented: docs.length > 0, independentSources: sources.length, witnesses, disputed: e.contradicting.length > 0, missing,
  };
}

export function rateClaim(c: ClaimIn): ClaimResult {
  const elements = c.elements.map(scoreElement);
  const base = { id: c.id, kind: c.kind, label: c.label, details: c.details, elements, authorities: c.authorities };
  if (elements.length === 0) {
    return { ...base, score: null, rating: "Insufficient information", why: "No elements have been added, so there is nothing to measure the evidence against." };
  }
  const score = Math.round(elements.reduce((a, e) => a + e.score, 0) / elements.length);
  const unsupported = elements.filter((e) => e.score === 0);
  const disputed = elements.filter((e) => e.disputed);
  const thin = elements.filter((e) => e.score > 0 && e.score < RULES.supported + RULES.documented);
  let rating: Rating; let why: string;
  if (unsupported.length) {
    rating = "Weak";
    why = `${plural(unsupported.length, "element has", "elements have")} no confirmed supporting fact: ${unsupported.map((e) => e.label).join("; ")}.`;
  } else if (disputed.length || thin.length) {
    rating = "Moderate";
    why = [
      thin.length ? `${plural(thin.length, "element is", "elements are")} supported only by attorney notes or unsourced facts (${thin.map((e) => e.label).join("; ")})` : "",
      disputed.length ? `${plural(disputed.length, "element has", "elements have")} contradicting facts (${disputed.map((e) => e.label).join("; ")})` : "",
    ].filter(Boolean).join("; ") + ".";
  } else if (elements.every((e) => e.score >= 90)) {
    rating = "Very strong";
    why = "Every element has documents or emails from at least two independent sources and a witness, and nothing confirmed contradicts it.";
  } else {
    rating = "Strong";
    why = "Every element has a confirmed fact cited to a document or email, and nothing confirmed contradicts any of them.";
  }
  return { ...base, score, rating, why };
}

export function ratingFor(score: number | null): Rating {
  if (score === null) return "Insufficient information";
  if (score >= 85) return "Very strong";
  if (score >= 65) return "Strong";
  if (score >= 40) return "Moderate";
  return "Weak";
}

const CAUSATION = /caus|because of|but-for|related to|connection/i;
const DAMAGE = /damage|loss|injur|harm/i;
const ADVERSE = /adverse|terminat|discharg|fired|demot|interfer/i;
const PROTECTED = /protected|leave|opposition|complain|report|participat|entitled|policy/i;
const CONTRACT = /contract|agreement|perform|breach/i;
const DISABILITY = /disab|qualified|accommodat/i;

function impactOf(label: string): Impact {
  if (CAUSATION.test(label)) return "Causation";
  if (DAMAGE.test(label)) return "Damages";
  return "Liability";
}

/** Suggested actions for an element without enough support. Starting points for the attorney, by the element's name. */
export function actionsFor(label: string): string[] {
  const a: string[] = [`Use "Find evidence" on this element to search the Matter's documents and emails for it.`];
  if (CAUSATION.test(label)) a.push(
    "Look for communications by the decision-maker around the date of the adverse action.",
    "Compare the reasons given for the decision over time (letters, emails, HR notes, agency responses).",
    "Request the approval chain and meeting notes for the decision in discovery.",
  );
  else if (DAMAGE.test(label)) a.push("Obtain payroll records, benefits statements and tax returns.", "Document mitigation: job applications and any new employment.");
  else if (ADVERSE.test(label)) a.push("Obtain the termination letter or notice of the action.", "Request the personnel file and separation paperwork.");
  else if (PROTECTED.test(label)) a.push("Gather the leave request, complaint or report, and the employer's response to it.", "Confirm the dates the employer learned of it.");
  else if (CONTRACT.test(label)) a.push("Locate the signed agreement, amendments and the correspondence about performance.");
  else if (DISABILITY.test(label)) a.push("Collect the medical documentation, the job description and performance reviews.");
  else a.push("Request documents on this point in discovery.", "Identify who has first-hand knowledge.");
  return a;
}

const SEVERITY_ORDER: Record<Severity, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };

export function analyze(m: MatterIn): StrengthReport {
  const base = `/matters/${m.matterId}`;
  const claims = m.claims.filter((c) => c.kind === "claim").map(rateClaim);
  const defenses = m.claims.filter((c) => c.kind === "defense").map(rateClaim);
  const gaps: Gap[] = [];
  const strengths: { text: string; href: string }[] = [];

  for (const c of claims) {
    const href = `${base}/dna/${c.id}`;
    if (!c.elements.length) {
      gaps.push({ key: `no-elements:${c.id}`, severity: "High", impact: "Procedure", title: `${c.label}: no elements yet`,
        detail: "Without its elements, Huis can't tell what this claim needs or where the evidence falls short.", claimId: c.id, elementId: null, href,
        actions: ["Add the elements from a template or from the controlling law, then link supporting facts to each."] });
    }
    for (const e of c.elements) {
      const where = { claimId: c.id, elementId: e.id, href };
      if (e.score === 0) {
        gaps.push({ key: `unsupported:${e.id}`, severity: "Critical", impact: impactOf(e.label), title: `${c.label}: nothing yet supports "${e.label}"`,
          detail: "No confirmed fact supports this element. The claim can't succeed without it.", ...where, actions: actionsFor(e.label) });
        continue;
      }
      if (!e.documented) {
        gaps.push({ key: `notes-only:${e.id}`, severity: "High", impact: impactOf(e.label), title: `${c.label}: "${e.label}" has no document or email behind it`,
          detail: "The supporting facts rest only on attorney notes or have no source. A document or email would make it provable.", ...where, actions: actionsFor(e.label) });
      } else if (e.independentSources < 2) {
        gaps.push({ key: `single-source:${e.id}`, severity: "Medium", impact: impactOf(e.label), title: `${c.label}: "${e.label}" rests on a single source`,
          detail: "One document or email supports it. If it is challenged or excluded, nothing else does.", ...where, actions: actionsFor(e.label).slice(0, 3) });
      }
      if (e.disputed) {
        gaps.push({ key: `disputed:${e.id}`, severity: "High", impact: "Credibility", title: `${c.label}: "${e.label}" is contradicted`,
          detail: `${plural(e.contradicting.length, "confirmed fact contradicts", "confirmed facts contradict")} it: ${e.contradicting.map((f) => f.label).slice(0, 3).join("; ")}.`,
          ...where, actions: ["Review the contradicting facts and their sources.", "Prepare how to address them (explanation, impeachment, or other evidence)."] });
      }
      if (!e.witnesses.length) {
        gaps.push({ key: `no-witness:${e.id}`, severity: "Low", impact: "Liability", title: `${c.label}: no witness linked for "${e.label}"`,
          detail: "No person is linked as a witness to the facts supporting it.", ...where,
          actions: ["Identify who has first-hand knowledge and link them to the supporting fact as a witness."] });
      }
      if (e.score >= 90 && !e.disputed) {
        strengths.push({ text: `${c.label}: "${e.label}" is backed by ${e.independentSources} independent sources and ${e.witnesses.map((w) => w.label).join(", ")}.`, href });
      } else if (e.documented && !e.disputed) {
        strengths.push({ text: `${c.label}: "${e.label}" is supported by a document or email.`, href });
      }
    }
  }

  for (const d of defenses) {
    const supported = d.elements.filter((e) => e.score > 0);
    if (d.elements.length && supported.length) {
      const all = supported.length === d.elements.length;
      gaps.push({ key: `defense:${d.id}`, severity: all ? "High" : "Medium", impact: "Liability",
        title: `Defense "${d.label}": ${all ? "every element has support" : `${plural(supported.length, "element has", "elements have")} support`}`,
        detail: "Facts in the Matter support this defense. Expect opposing counsel to rely on them.", claimId: d.id, elementId: null, href: `${base}/dna/${d.id}`,
        actions: ["Review the facts supporting each element of the defense.", "Gather evidence that answers each one."] });
    }
  }

  if (claims.length && !m.damages.length) {
    gaps.push({ key: "no-damages", severity: "High", impact: "Damages", title: "No damages recorded",
      detail: "Case DNA has no damage items, so the harm and its amount aren't documented yet.", claimId: null, elementId: null, href: `${base}/dna`,
      actions: ["Add each kind of damage (lost wages, benefits, other losses) in Case DNA with its amount and source.", ...actionsFor("Damages").slice(1)] });
  }
  for (const d of m.damages) {
    if (d.amount === null || d.sources === 0) {
      gaps.push({ key: `damage-undocumented:${d.id}`, severity: "Medium", impact: "Damages",
        title: `Damages "${d.label}": ${d.amount === null ? "no amount" : ""}${d.amount === null && d.sources === 0 ? " and " : ""}${d.sources === 0 ? "no source" : ""}`,
        detail: "An amount backed by a document is what makes a damages item provable.", claimId: null, elementId: null, href: `${base}/dna/${d.id}`,
        actions: actionsFor("Damages").slice(1) });
    }
  }
  if (m.contradictions.potential) {
    gaps.push({ key: "contradictions", severity: "Medium", impact: "Credibility", title: `${plural(m.contradictions.potential, "potential contradiction is", "potential contradictions are")} undecided`,
      detail: "Huis found statements that may conflict. Deciding them tells you which ones opposing counsel could use.", claimId: null, elementId: null, href: `${base}/contradictions`,
      actions: ["Review each potential contradiction and confirm or reject it."] });
  }
  const pending = m.pending.suggestedFacts + m.pending.suggestedLinks + m.pending.suggestedOther;
  if (pending) {
    gaps.push({ key: "pending-review", severity: "Low", impact: "Discovery", title: `${plural(pending, "suggestion from Huis is", "suggestions from Huis are")} waiting for review`,
      detail: "Suggestions don't count toward the scores until someone confirms them.", claimId: null, elementId: null, href: `${base}/dna`,
      actions: ["Review the suggestions in Case DNA."] });
  }
  gaps.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  // Matter-level categories, each a fixed rule over the claims' elements.
  const els = claims.flatMap((c) => c.elements);
  const causal = els.filter((e) => CAUSATION.test(e.label));
  const dmgDocumented = m.damages.filter((d) => d.amount !== null && d.sources > 0).length;
  const defenseScores = defenses.filter((d) => d.score !== null).map((d) => d.score!);
  const categories: Category[] = [
    { key: "elements", label: "Legal elements", value: pct(els.filter((e) => e.score > 0).length, els.length),
      rule: "Share of claim elements with at least one confirmed supporting fact.", why: `${els.filter((e) => e.score > 0).length} of ${els.length} elements.` },
    { key: "documentation", label: "Documentation", value: pct(els.filter((e) => e.documented).length, els.length),
      rule: "Share of claim elements whose support is cited to a document or email (not only attorney notes).", why: `${els.filter((e) => e.documented).length} of ${els.length} elements.` },
    { key: "witnesses", label: "Witness support", value: pct(els.filter((e) => e.witnesses.length).length, els.length),
      rule: "Share of claim elements with a person linked as a witness to a supporting fact.", why: `${els.filter((e) => e.witnesses.length).length} of ${els.length} elements.` },
    { key: "causation", label: "Causation", value: causal.length ? Math.round(causal.reduce((a, e) => a + e.score, 0) / causal.length) : null,
      rule: "Average score of the elements about causation (named with cause, connection, because of or related to).",
      why: causal.length ? causal.map((e) => `${e.label}: ${e.score}`).join("; ") : "No causation element in the claims." },
    { key: "damages", label: "Damages evidence", value: claims.length ? pct(dmgDocumented, Math.max(m.damages.length, 1)) : null,
      rule: "Share of damage items with both an amount and a source (0 if none are recorded).",
      why: m.damages.length ? `${dmgDocumented} of ${m.damages.length} damage items.` : "No damage items recorded." },
    { key: "credibility", label: "Credibility", value: claims.length ? Math.max(0, 100 - 15 * m.contradictions.confirmed - 5 * m.contradictions.potential - 10 * els.filter((e) => e.disputed).length) : null,
      rule: "100, less 15 per confirmed contradiction, 5 per undecided potential contradiction and 10 per contradicted element.",
      why: `${plural(m.contradictions.confirmed, "confirmed contradiction", "confirmed contradictions")}, ${m.contradictions.potential} undecided, ${plural(els.filter((e) => e.disputed).length, "contradicted element", "contradicted elements")}.` },
    { key: "discovery", label: "Discovery completeness", value: null,
      rule: "Not measured yet: Huis doesn't track discovery requests and responses.", why: "Insufficient information." },
    { key: "defense", label: "Defense exposure", value: defenseScores.length ? Math.round(defenseScores.reduce((a, b) => a + b, 0) / defenseScores.length) : null,
      rule: "Average evidence score of the defenses recorded (higher means more support for the other side).",
      why: defenses.length ? defenses.map((d) => `${d.label}: ${d.score ?? "no elements"}`).join("; ") : "No defenses recorded." },
  ];

  const scored = claims.filter((c) => c.score !== null);
  const overallScore = scored.length ? Math.round(scored.reduce((a, c) => a + c.score!, 0) / scored.length) : null;
  const overall = {
    score: overallScore,
    rating: ratingFor(overallScore),
    why: !claims.length ? "No claims have been added to Case DNA yet."
      : !scored.length ? "None of the claims has elements yet."
      : `Average of ${plural(scored.length, "claim's", "claims'")} evidence scores (${scored.map((c) => `${c.label}: ${c.score}`).join("; ")}). 85 or more is Very strong, 65 Strong, 40 Moderate, below 40 Weak.`,
  };

  // Confidence: how much of the Matter the scores can rest on.
  const reasons: string[] = [];
  if (m.evidence.total === 0) reasons.push("No evidence has been added to the Matter.");
  if (m.evidence.unread) reasons.push(`${plural(m.evidence.unread, "evidence item hasn't", "evidence items haven't")} been read yet (scanning, unreadable or waiting for the Matter Brain).`);
  if (pending) reasons.push(`${plural(pending, "suggestion is", "suggestions are")} waiting for review and not counted.`);
  if (m.contradictions.potential) reasons.push(`${plural(m.contradictions.potential, "potential contradiction is", "potential contradictions are")} undecided.`);
  if (claims.some((c) => !c.elements.length)) reasons.push("Some claims have no elements.");
  let level: Confidence = "High";
  if (m.evidence.total === 0 || !scored.length || pending > 20 || (m.evidence.total > 0 && m.evidence.unread / m.evidence.total > 0.2)) level = "Low";
  else if (reasons.length) level = "Medium";
  if (!reasons.length) reasons.push("All evidence has been read, nothing is waiting for review, and every claim has elements.");

  return { overall, confidence: { level, reasons }, categories, claims, defenses, gaps, strengths: strengths.slice(0, 12) };
}

export const severityRank = (s: Severity) => SEVERITY_ORDER[s];
