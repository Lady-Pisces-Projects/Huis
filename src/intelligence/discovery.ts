/**
 * Phase 11 part 2: "What are we missing?" (discovery gap analysis) and "If I were opposing counsel" (opposition
 * analysis, with how to counter each point).
 *
 * Fixed rules over the same confirmed Case DNA as case strength (src/intelligence/strength.ts), plus the people and
 * organizations in it. No AI and no guessing: every item names the rule and the facts or gaps behind it, and drafts
 * (requests for production, requests for admission) are starting points for the attorney to edit, never filed as is.
 * What Huis can't see (discovery already served and answered, limitations periods) is said plainly, not invented.
 */
import type { ClaimResult, ElementResult, MatterIn, Severity, StrengthReport } from "./strength";
import { actionsFor } from "./strength";

export interface PersonIn {
  id: string; kind: "person" | "organization"; label: string; role: string | null;
  /** Links to counted facts (confirmed both ways). */
  links: { factId: string; relation: "witness_to" | "involves" }[];
  /** Confirmed links to anything else the reader can see (timeline facts, events) — so "linked to nothing" is true. */
  otherLinks?: number;
}

export interface Item { title: string; detail: string; href: string }
export interface Draft { text: string; basis: string; href: string }
export interface Discovery {
  documents: Draft[];
  admissions: Draft[];
  /** More admissions than are drafted (30 at most), and facts phrased as questions that need rewriting first. */
  admissionsTruncated: boolean;
  questionFacts: number;
  depositions: (Item & { reasons: string[] })[];
  witnessGaps: Item[];
  organizations: Item[];
  experts: Item[];
  authentication: Item[];
  notTracked: string[];
}
export interface OppositionPoint {
  key: string; severity: Severity; argument: string; why: string[];
  counter: string[]; evidence: string[]; href: string;
}
export interface Opposition { points: OppositionPoint[]; notChecked: string[] }

const CAUSATION = /\bcaus(e|ed|al|ation)\b|because of|but-for|connection/i;
const ADVERSE = /adverse|terminat|discharg|fired|demot|interfer/i;
const PROTECTED = /protected|leave|opposition|complain|report|participat|entitled/i;
const DAMAGE = /damage|loss|injur|harm/i;
const CONTRACT = /contract|agreement|perform|breach/i;
const DISABILITY = /disab|accommodat/i;
/** Only phrases that fit a search for work (review 36: "applied for FMLA leave" or "HR interviewed Pat" aren't). */
const MITIGATION = /mitigat|job search|job (application|interview)s?|applied (for|to) (a |the |another |several )?(job|position|role|opening)s?|new (job|employment|position)|re-?employ|unemployment (benefits|insurance|compensation)|hired by|started (a new job|work at)/i;
/** Employment claims, by name (the employment wording only fits these). */
const EMPLOYMENT = /fmla|title vii|\bada\b|adea|discriminat|retaliat|wrongful (termination|discharge)|employ|wage|harass/i;
const isDisability = (element: string, claim: string) => DISABILITY.test(element) || (/qualified/i.test(element) && /\bada\b|disab/i.test(claim));
const isCausation = (l: string) => CAUSATION.test(l) && !/^\s*damage/i.test(l);

/** A request for production, by the element's name. A draft for the attorney. */
export function productionRequest(element: string, claim: string): string {
  if (isCausation(element)) return "All documents and communications concerning the decision to take the adverse action, including drafts, approvals, the people consulted and the reasons considered.";
  if (ADVERSE.test(element)) return "The complete personnel file and all documents concerning the adverse action, including notices, separation paperwork and any appeal.";
  if (PROTECTED.test(element)) return "All documents concerning the leave request, complaint or report, and every response to it, including internal discussion of it.";
  if (DAMAGE.test(element)) return EMPLOYMENT.test(claim)
    ? "Payroll, compensation and benefits records for the relevant period, and the policies that set them."
    : "All documents showing the losses claimed and how they were calculated (invoices, orders, financial statements, correspondence about the losses).";
  if (CONTRACT.test(element)) return "The agreement, all amendments, and all correspondence concerning performance under it.";
  if (isDisability(element, claim)) return "The job description, all accommodation requests and responses, and all medical information received about the employee.";
  return `All documents concerning "${element}" (${claim}).`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function discovery(m: MatterIn, r: StrengthReport, people: PersonIn[], suggestedPeople: number): Discovery {
  const base = `/matters/${m.matterId}`;
  const claimHref = (c: ClaimResult) => `${base}/dna/${c.id}`;
  // Every place each fact is used (a fact can support one element and contradict another: review 36).
  type Use = { claim: ClaimResult; element: ElementResult; side: "supports" | "contradicts" };
  const factInfo = new Map<string, Use[]>();
  const use = (id: string, u: Use) => factInfo.set(id, [...(factInfo.get(id) ?? []), u]);
  for (const c of [...r.claims, ...r.defenses]) {
    for (const e of c.elements) {
      for (const f of e.supporting) use(f.id, { claim: c, element: e, side: "supports" });
      for (const f of e.contradicting) use(f.id, { claim: c, element: e, side: "contradicts" });
    }
  }

  // Documents to request: elements of the claims without a document, or with only one. Requests worded the same
  // are merged, and every element they cover is named (review 36).
  const byText = new Map<string, { bases: string[]; href: string }>();
  for (const c of r.claims) for (const e of c.elements) {
    if (e.documentSources >= 2) continue;
    const text = productionRequest(e.label, c.label);
    const entry = byText.get(text) ?? { bases: [], href: claimHref(c) };
    entry.bases.push(`${c.label}: "${e.label}" has ${e.documentSources === 0 ? "no document or email" : "only one document or email"} behind it.`);
    byText.set(text, entry);
  }
  const documents: Draft[] = [...byText.entries()].map(([text, v]) => ({ text, basis: v.bases.join(" "), href: v.href }));

  // Requests for admission: each confirmed supporting fact with a document behind it (once, even if it supports two
  // elements), and that document's authenticity. A fact phrased as a question can't be admitted as written.
  const admissions: Draft[] = [];
  const seenDoc = new Set<string>();
  const seenFact = new Set<string>();
  let questionFacts = 0;
  let admissionsTruncated = false;
  const MAX_ADMISSIONS = 30;
  const statement = (label: string): string | null => {
    const t = label.trim();
    if (/\?["'”’)]*$/.test(t)) return null;
    if (/[.!]["'”’)]+$/.test(t)) return t; // already ends a sentence inside quotes or brackets
    return `${t.replace(/[.\s]+$/, "")}.`;
  };
  for (const c of r.claims) for (const e of c.elements) for (const f of e.supporting) {
    const docs = f.sources.filter((x) => x.kind !== "note");
    if (!docs.length || seenFact.has(f.id)) continue;
    seenFact.add(f.id);
    const sentence = statement(f.label);
    if (!sentence) { questionFacts++; continue; }
    if (admissions.length >= MAX_ADMISSIONS) { admissionsTruncated = true; continue; }
    admissions.push({ text: `Admit that ${sentence}`, basis: `Supports "${e.label}" (${c.label}); source: ${docs[0]!.title}.${e.disputed ? " Note: this element also has contradicting facts." : ""}`, href: claimHref(c) });
    for (const d of docs) {
      if (seenDoc.has(d.evidenceId ?? d.id)) continue;
      if (admissions.length >= MAX_ADMISSIONS) { admissionsTruncated = true; break; }
      seenDoc.add(d.evidenceId ?? d.id);
      admissions.push({ text: `Admit that the document "${d.title}" is a true and correct copy of what it appears to be.`, basis: `Cited for "${e.label}" (${c.label}).`, href: d.evidenceId ? `/evidence/${d.evidenceId}` : claimHref(c) });
    }
  }

  // Deposition targets: people tied to contradicting facts, to the decision (adverse action, causation) or to a defense.
  const depositions: (Item & { reasons: string[] })[] = [];
  for (const p of people.filter((x) => x.kind === "person")) {
    const reasons: string[] = [];
    for (const l of p.links) {
      const role = l.relation === "witness_to" ? "a witness to" : "involved in";
      for (const info of factInfo.get(l.factId) ?? []) {
        if (info.side === "contradicts") reasons.push(`${role} a fact contradicting "${info.element.label}" (${info.claim.label})`);
        else if (info.claim.kind === "defense") reasons.push(`${role} a fact supporting the defense "${info.claim.label}"`);
        else if (isCausation(info.element.label) || ADVERSE.test(info.element.label)) reasons.push(`${role} a fact about "${info.element.label}" (${info.claim.label})`);
      }
    }
    if (reasons.length) depositions.push({ title: p.label, detail: p.role ? `Role: ${p.role}.` : "", href: `${base}/dna/${p.id}`, reasons: [...new Set(reasons)] });
  }
  depositions.sort((a, b) => b.reasons.length - a.reasons.length);

  // Witness gaps: claim elements with no witness, and people in Case DNA linked to nothing yet.
  const witnessGaps: Item[] = [];
  for (const c of r.claims) for (const e of c.elements) {
    if (e.score > 0 && !e.witnesses.length) witnessGaps.push({ title: `${c.label}: "${e.label}"`, detail: "No one is linked as a witness to its supporting facts.", href: claimHref(c) });
  }
  for (const p of people.filter((x) => x.kind === "person" && x.links.length === 0)) {
    witnessGaps.push({ title: p.label, href: `${base}/dna/${p.id}`, detail: (p.otherLinks ?? 0) > 0
      ? "Linked to facts or events, but none behind a claim element: check whether what they know belongs to one."
      : "In Case DNA but not linked to any fact or event yet: find out what they know." });
  }
  if (suggestedPeople) witnessGaps.push({ title: plural(suggestedPeople, "person suggested by Huis", "people suggested by Huis"), detail: "Found in documents or email and not reviewed yet.", href: `${base}/dna` });

  const organizations: Item[] = people.filter((x) => x.kind === "organization").map((o) => ({
    title: o.label, detail: "If it isn't a party, its records need a subpoena (check whether it is).", href: `${base}/dna/${o.id}`,
  }));

  const experts: Item[] = [];
  const dmgTotal = m.damages.reduce((a, d) => a + (d.amount ?? 0), 0);
  if (m.damages.length) experts.push({ title: "Damages", detail: `${plural(m.damages.length, "damage item is", "damage items are")} recorded${dmgTotal ? ` (${dmgTotal.toLocaleString("en-US", { style: "currency", currency: "USD" })} in amounts entered)` : ""}. Lost earnings and benefits are usually proved with an economist or vocational expert.`, href: `${base}/dna` });
  if (r.claims.some((c) => c.elements.some((e) => isDisability(e.label, c.label)))) experts.push({ title: "Medical", detail: "A disability element is in the claims: a treating provider or medical expert may be needed to prove it.", href: `${base}/claims` });

  // Authentication: every document or email the claims rely on, most relied on first.
  const uses = new Map<string, { title: string; href: string; elements: Set<string> }>();
  for (const c of r.claims) for (const e of c.elements) for (const f of e.supporting) for (const s of f.sources) {
    if (s.kind === "note") continue;
    const key = s.evidenceId ?? s.id;
    const u = uses.get(key) ?? { title: `${s.title}${s.kind === "email" ? " (email)" : ""}`, href: s.evidenceId ? `/evidence/${s.evidenceId}` : claimHref(c), elements: new Set<string>() };
    u.elements.add(`${e.label} (${c.label})`);
    uses.set(key, u);
  }
  const authentication: Item[] = [...uses.values()].sort((a, b) => b.elements.size - a.elements.size).map((u) => ({
    title: u.title, detail: `Relied on for ${[...u.elements].join("; ")}. Plan how it comes in: a custodian declaration, a request for admission, or a witness who can identify it.`, href: u.href,
  }));

  return {
    documents, admissions, admissionsTruncated, questionFacts, depositions, witnessGaps, organizations, experts, authentication,
    notTracked: [
      "Discovery already served and answered (interrogatories, requests, responses and objections): Huis doesn't track them yet, so it can't say what is outstanding or overdue.",
      "Whether each person or organization is a party: check before choosing between a request and a subpoena.",
    ],
  };
}

const ORDER: Record<Severity, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };

export function opposition(m: MatterIn, r: StrengthReport): Opposition {
  const base = `/matters/${m.matterId}`;
  const points: OppositionPoint[] = [];
  const els = r.claims.flatMap((c) => c.elements.map((e) => ({ c, e })));

  for (const { c, e } of els) {
    if (e.score === 0) {
      points.push({ key: `unproven:${e.id}`, severity: "Critical", argument: `${c.label} fails: there is no evidence of "${e.label}".`,
        why: ["No confirmed fact supports this element."], counter: ["Develop evidence for the element before relying on the claim."], evidence: actionsFor(e.label, c.label).slice(1), href: `${base}/dna/${c.id}` });
    } else if (!e.documented) {
      points.push({ key: `notes-only:${e.id}`, severity: "High", argument: `"${e.label}" has no document or email behind it: they'll say it can't be proved.`,
        why: ["Its supporting facts are cited only to attorney notes or have no source."],
        counter: ["Find a document or email that records it, or a witness who saw it first-hand."], evidence: actionsFor(e.label, c.label).slice(1), href: `${base}/dna/${c.id}` });
    } else if (e.documentSources === 1) {
      points.push({ key: `single:${e.id}`, severity: "Medium", argument: `"${e.label}" stands on one document: attack it and the element falls.`,
        why: [`Only one document or email supports it (${e.supporting.flatMap((f) => f.sources).find((s) => s.kind !== "note")?.title ?? "source"}).`],
        counter: ["Lay the foundation for that document early (authenticity, business record).", "Find a second, independent source."], evidence: actionsFor(e.label, c.label).slice(1, 3), href: `${base}/dna/${c.id}` });
    }
    if (e.disputed) {
      points.push({ key: `credibility:${e.id}`, severity: "High", argument: `The evidence on "${e.label}" is inconsistent.`,
        why: e.contradicting.map((f) => `Contradicting fact: ${f.label}${f.sources[0] ? ` (${f.sources[0].title})` : ""}.`),
        counter: ["Explain the inconsistency before they do (context, timing, who said what).", "Corroborate your version with documents written at the time."],
        evidence: ["The documents and witnesses behind each contradicting fact."], href: `${base}/dna/${c.id}` });
    }
  }

  for (const d of r.defenses) {
    const supported = d.elements.filter((e) => e.score > 0);
    if (!supported.length) continue;
    points.push({ key: `defense:${d.id}`, severity: supported.length === d.elements.length ? "High" : "Medium",
      argument: `Defense: ${d.label}.`,
      why: supported.map((e) => `"${e.label}" is supported by ${e.supporting.map((f) => f.label).slice(0, 2).join("; ")}.`),
      counter: ["Answer each supported element with your own evidence.", "Look for departures from policy, shifting explanations or comparators treated differently."],
      evidence: supported.map((e) => `Evidence against "${e.label}".`), href: `${base}/dna/${d.id}` });
  }

  const causal = els.filter(({ e }) => isCausation(e.label));
  const supportedDefense = r.defenses.some((d) => d.elements.some((e) => e.score > 0));
  if (causal.length && (causal.some(({ e }) => e.score < 80) || supportedDefense)) {
    points.push({ key: "alternative-cause", severity: causal.some(({ e }) => e.score < 65) ? "High" : "Medium",
      argument: "Something else caused the decision (performance, restructuring, a policy applied to everyone).",
      why: [...causal.map(({ c, e }) => `${c.label}: "${e.label}" scores ${e.score}.`), ...(supportedDefense ? ["A defense recorded in Case DNA has support."] : [])],
      counter: ["Show timing between the protected activity and the decision.", "Show shifting or inconsistent reasons, departures from policy, and how comparable employees were treated."],
      evidence: ["The decision-maker's communications around the decision.", "Comparator records and the policies applied.", "Every reason given for the decision, with dates."], href: `${base}/strength` });
  }

  if (r.claims.length) {
    if (!m.damages.length) {
      points.push({ key: "damages-speculative", severity: "High", argument: "The damages are speculative: none are documented.", why: ["No damage items are recorded in Case DNA."],
        counter: ["Quantify each kind of damage with records."], evidence: ["Payroll and benefits records.", "Tax returns.", "Receipts for out-of-pocket losses."], href: `${base}/dna` });
    } else {
      const undocumented = m.damages.filter((d) => d.amount === null || d.sources === 0);
      if (undocumented.length) points.push({ key: "damages-unsupported", severity: "Medium", argument: "Some damages aren't backed by records.",
        why: undocumented.map((d) => `${d.label}: ${d.amount === null ? "no amount" : "no document"}.`), counter: ["Back each amount with a document."], evidence: ["The records behind each amount."], href: `${base}/dna` });
      const mitigated = m.damages.some((d) => MITIGATION.test(d.label)) || r.claims.some((c) => c.elements.some((e) => e.supporting.some((f) => MITIGATION.test(f.label))));
      const employment = r.claims.some((c) => EMPLOYMENT.test(c.label));
      if (!mitigated) points.push(employment
        ? { key: "mitigation", severity: "Medium", argument: "The client failed to mitigate (didn't look for comparable work).",
            why: ["Nothing in Case DNA records a job search or new employment."], counter: ["Document every effort to find work."],
            evidence: ["Job applications and responses.", "Unemployment records.", "Any new employment and its pay."], href: `${base}/dna` }
        : { key: "mitigation", severity: "Medium", argument: "The client didn't take reasonable steps to limit the losses.",
            why: ["Nothing in Case DNA records steps taken to reduce the losses."], counter: ["Document what was done to limit the losses, and why more wasn't possible."],
            evidence: ["Records of steps taken to reduce the losses (replacement orders, cover purchases, cost savings)."], href: `${base}/dna` });
    }
  }

  points.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  return {
    points,
    notChecked: [
      "Statutes of limitations, administrative exhaustion and other procedural defenses: Huis doesn't check these. Confirm them against the controlling law and the court calendar.",
      "How persuasive any fact is: the rules see whether evidence is there, sourced and corroborated, not how a judge or jury will weigh it.",
    ],
  };
}
