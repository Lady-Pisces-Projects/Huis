import { findEvents } from "./extract";
import { CLAIM_TEMPLATES } from "./templates";

/**
 * Reads an attorney's description of a new case and suggests, for Case DNA:
 *   - key dates (each sentence with a date becomes a suggested event),
 *   - organizations ("Acme Trucking, Inc.", "Wasatch Bank LLC"),
 *   - people named with a title ("Ms. Rivera", "Dr. Alan Chu", "Officer Grant"),
 *   - the parties in a caption ("Smith v. Acme Corp."),
 *   - possible claims, by the words used ("fired after taking FMLA leave", "rear-ended", "breach of the lease").
 *
 * Fixed, explainable rules (no AI model): every suggestion points to the words it came from, and the attorney
 * confirms or rejects each one. Runs in linear time on a bounded text, and suggests at most MAX_SUGGESTIONS.
 * Automatic work: it never counts as one of the firm's AI questions.
 */
export interface DescriptionSuggestion {
  kind: "event" | "person" | "organization" | "claim";
  label: string;
  /** Position in the text that was read (the note's "title\n\nbody"). */
  start: number;
  end: number;
  date?: string;
}

export const MAX_DESCRIPTION = 5000;
export const MAX_SUGGESTIONS = 40;

const ORG = /\b((?:[A-Z][A-Za-z0-9&'-]*\.?\s+){0,4}[A-Z][A-Za-z0-9&'-]*),?\s+(Inc\.?|Incorporated|LLC|L\.L\.C\.|LLP|L\.P\.|Corp\.?|Corporation|Company|Co\.|Ltd\.?|P\.C\.|PLLC)(?=[\s,.;:)]|$)/g;
const PERSON = /\b(Mr|Mrs|Ms|Miss|Dr|Judge|Officer|Detective|Sgt|Deputy|Trooper)\.?\s+([A-Z][a-z'-]+(?:\s+[A-Z][a-z'-]+)?)/g;
const CAPTION = /\b([A-Z][A-Za-z.'&-]*(?:\s+[A-Z][A-Za-z.'&-]*){0,4})\s+v(?:s)?\.\s+([A-Z][A-Za-z.'&-]*(?:\s+[A-Z][A-Za-z.'&-]*){0,4})/g;

const template = (key: string) => CLAIM_TEMPLATES.find((t) => t.key === key)?.title ?? key;

/** Possible claims, by the words used. Each needs every pattern to appear; the first pattern's words are cited. */
const CLAIM_RULES: { label: string; all: RegExp[] }[] = [
  { label: template("fmla_retaliation"), all: [/\bFMLA\b|family and medical leave/i, /\b(retaliat\w*|fired|terminat\w*|demot\w*|let go)\b/i] },
  { label: template("fmla_interference"), all: [/\bFMLA\b|family and medical leave/i, /\b(denied|refus\w*|interfer\w*|discourag\w*)\b/i] },
  { label: template("title_vii_retaliation"), all: [/\b(complain\w*|report\w*)\b[^.]{0,80}\b(harass\w*|discriminat\w*)/i, /\b(retaliat\w*|fired|terminat\w*|demot\w*)\b/i] },
  { label: template("ada_discrimination"), all: [/\bADA\b|\bdisabilit\w*|\baccommodation\b/i] },
  { label: template("wrongful_termination_public_policy_ut"), all: [/\bwrongful(?:ly)?\s+(?:terminat\w*|discharg\w*|fired)\b/i] },
  { label: template("breach_of_contract_ut"), all: [/\bbreach\w*\b[^.]{0,40}\b(contract|agreement|lease)\b|\b(contract|agreement|lease)\b[^.]{0,40}\bbreach\w*/i] },
  { label: "Negligence (personal injury)", all: [/\b(car accident|crash\w*|collision|rear-ended|slip(?:ped)? and f[ae]ll|tripp?ed|negligen\w*|dog bite)\b/i, /\b(injur\w*|hurt|broken|fractur\w*|whiplash|hospital\w*|surgery)\b/i] },
  { label: "Medical malpractice", all: [/\b(misdiagnos\w*|malpractice|surgical error|wrong-site)\b/i] },
  { label: "Fraud or misrepresentation", all: [/\b(fraud\w*|misrepresent\w*|lied about|deceiv\w*)\b/i] },
  { label: "Divorce or legal separation", all: [/\b(divorce|legal separation|dissolution of marriage)\b/i] },
  { label: "Child custody and parent-time", all: [/\b(custody|parent-time|visitation)\b/i] },
  { label: "Child support or alimony", all: [/\b(child support|alimony|spousal support)\b/i] },
  { label: "Unpaid wages", all: [/\b(unpaid wages|unpaid overtime|wage theft|final paycheck)\b/i] },
];

/** Every claim label the rules can suggest (the database accepts only these; db/migrations/0035_review28.sql). */
export const CLAIM_LABELS = CLAIM_RULES.map((r) => r.label);

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** The text as stored for a case-description note (what the database quotes from). */
export function descriptionNoteText(body: string): { title: string; body: string; text: string } {
  const title = "Case description";
  const b = body.slice(0, MAX_DESCRIPTION);
  return { title, body: b, text: `${title}\n\n${b}` };
}

export function suggestFromDescription(text: string): DescriptionSuggestion[] {
  const t = text.slice(0, MAX_DESCRIPTION + 100);
  const out: DescriptionSuggestion[] = [];
  const seen = new Set<string>();
  const add = (s: DescriptionSuggestion) => {
    const key = `${s.kind}:${s.label.toLowerCase()}${s.date ? `:${s.date}` : ""}`;
    if (seen.has(key) || out.length >= MAX_SUGGESTIONS) return;
    seen.add(key);
    out.push(s);
  };

  for (const r of CLAIM_RULES) {
    const first = r.all[0]!.exec(t);
    if (first && r.all.slice(1).every((re) => re.test(t))) {
      add({ kind: "claim", label: r.label, start: first.index, end: first.index + first[0].length });
    }
  }

  for (const m of t.matchAll(CAPTION)) {
    for (const [name, offset] of [[m[1]!, 0], [m[2]!, m[0].length - m[2]!.length]] as const) {
      const trimmed = name.replace(/[.,]+$/, "");
      const label = clean(trimmed);
      if (label.length >= 2) add({ kind: /\b(Inc|LLC|Corp|Company|Co|Ltd|LLP|Bank|County|City|State)\b/.test(label) ? "organization" : "person",
        label, start: m.index! + offset, end: m.index! + offset + trimmed.length });
    }
  }
  for (const m of t.matchAll(ORG)) {
    // The exact words written ("Acme Trucking, Inc."), without a sentence-ending full stop doubled up.
    const label = clean(m[0]);
    add({ kind: "organization", label, start: m.index!, end: m.index! + m[0].length });
  }
  for (const m of t.matchAll(PERSON)) {
    add({ kind: "person", label: clean(m[0]), start: m.index!, end: m.index! + m[0].length });
  }
  for (const e of findEvents(t)) {
    add({ kind: "event", label: e.label, date: e.date, start: e.start, end: e.end });
  }
  return out;
}
