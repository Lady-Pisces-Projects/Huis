/*
 * Phase 11 part 3: federal benchmarks from the FJC Integrated Database (civil), with no dollar values.
 * Field meanings are quoted in docs/source/fjc-civil-codebook.md. Pure functions: parsing a data-file line, mapping
 * claims to nature-of-suit codes and states to districts, and turning counts into a labelled benchmark.
 */

/** District codes by state, from the codebook's DISTRICT list. */
export const DISTRICTS_BY_STATE: Record<string, string[]> = {
  ME: ["00"], MA: ["01"], NH: ["02"], RI: ["03"], PR: ["04"], CT: ["05"], NY: ["06", "07", "08", "09"], VT: ["10"], DE: ["11"],
  NJ: ["12"], PA: ["13", "14", "15"], MD: ["16"], NC: ["17", "18", "19"], SC: ["20"], VA: ["22", "23"], WV: ["24", "25"],
  AL: ["26", "27", "28"], FL: ["29", "3A", "3C"], GA: ["3E", "3G", "3J"], LA: ["3L", "3N", "36"], MS: ["37", "38"],
  TX: ["39", "40", "41", "42"], KY: ["43", "44"], MI: ["45", "46"], OH: ["47", "48"], TN: ["49", "50", "51"],
  IL: ["52", "53", "54"], IN: ["55", "56"], WI: ["57", "58"], AR: ["60", "61"], IA: ["62", "63"], MN: ["64"], MO: ["65", "66"],
  NE: ["67"], ND: ["68"], SD: ["69"], AK: ["7-"], AZ: ["70"], CA: ["71", "72", "73", "74"], HI: ["75"], ID: ["76"], MT: ["77"],
  NV: ["78"], OR: ["79"], WA: ["80", "81"], CO: ["82"], KS: ["83"], NM: ["84"], OK: ["85", "86", "87"], UT: ["88"], WY: ["89"],
  DC: ["90"], VI: ["91"], GU: ["93"], MP: ["94"],
};

/**
 * Nature-of-suit codes (checked against the uscourts.gov list) and the claim names that map to each. First match wins.
 * Claim names are free text, so wording that belongs to another case type returns no match rather than a wrong one
 * (review 38): the page then says no federal case type matches.
 */
export const NOS_RULES: { nos: number; title: string; match: RegExp }[] = [
  { nos: 791, title: "Employee Retirement Income Security Act", match: /\berisa\b/i },
  { nos: 751, title: "Family and Medical Leave Act", match: /\bfmla\b|family and medical leave/i },
  // "ADA" only as the capitalised acronym, so the name Ada (Ada County) doesn't match.
  { nos: 445, title: "Americans With Disabilities – Employment", match: /\bADA\b|\b[Aa]mericans [Ww]ith [Dd]isabilities|\b[Dd]isability [Dd]iscriminat|\b[Ff]ailure [Tt]o [Aa]ccommodate|AMERICANS WITH DISABILITIES|DISABILITY DISCRIMINAT|FAILURE TO ACCOMMODATE/ },
  { nos: 710, title: "Fair Labor Standards Act (Non-Union)", match: /\bflsa\b|fair labor standards|overtime|minimum wage|unpaid wages?/i },
  { nos: 442, title: "Civil Rights – Employment", match: /title vii|\badea\b|age discrimination|discriminat|retaliat|harass|hostile work/i },
  { nos: 190, title: "Other Contract", match: /contract/i },
  { nos: 360, title: "Other Personal Injury", match: /personal injury|negligen/i },
];
/** Wording that belongs to a case type Huis doesn't map: no benchmark rather than the wrong one. */
const NO_MATCH = /fair housing|housing discriminat|title iii|public accommodation|misrepresent|malpractice|\bfraud|section 1983|§ ?1983|voting/i;

export function nosFor(claimLabel: string): { nos: number; title: string } | null {
  if (NO_MATCH.test(claimLabel)) return null;
  const r = NOS_RULES.find((x) => x.match.test(claimLabel));
  return r ? { nos: r.nos, title: r.title } : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Parsing the FJC tab-delimited file

export interface FederalCaseRow { district: string; nos: number; filed: string; terminated: string; disp: number; judgment: number | null }
export const REQUIRED_COLUMNS = ["DISTRICT", "NOS", "FILEDATE", "TERMDATE", "DISP", "JUDGMENT", "TAPEYEAR"] as const;
export type Skip = "pending" | "missing" | "bad-date" | "bad-value" | "too-old";

const MONTHS: Record<string, number> = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

/** Accepts the date shapes the file may use (MM/DD/YYYY, YYYY-MM-DD, YYYYMMDD, 01JAN2020); returns YYYY-MM-DD or null. */
export function parseDate(raw: string): string | null {
  const v = raw.trim().replace(/^"|"$/g, "").split(/[ T]/)[0]!;
  let y: number, m: number, d: number;
  let r: RegExpExecArray | null;
  if ((r = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v))) { m = +r[1]!; d = +r[2]!; y = +r[3]!; }
  else if ((r = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v))) { y = +r[1]!; m = +r[2]!; d = +r[3]!; }
  else if ((r = /^(\d{4})(\d{2})(\d{2})$/.exec(v))) { y = +r[1]!; m = +r[2]!; d = +r[3]!; }
  else if ((r = /^(\d{1,2})([A-Za-z]{3})(\d{4})$/.exec(v)) && MONTHS[r[2]!.toUpperCase()]) { d = +r[1]!; m = MONTHS[r[2]!.toUpperCase()]!; y = +r[3]!; }
  else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (y < 1900 || y > 2100 || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

export function headerIndex(header: string[]): Record<(typeof REQUIRED_COLUMNS)[number], number> {
  const up = header.map((h) => h.trim().replace(/^"|"$/g, "").toUpperCase());
  const missing = REQUIRED_COLUMNS.filter((c) => !up.includes(c));
  if (missing.length) throw new Error(`The file is missing columns the codebook names: ${missing.join(", ")}. Is it the FJC civil file?`);
  return Object.fromEntries(REQUIRED_COLUMNS.map((c) => [c, up.indexOf(c)])) as Record<(typeof REQUIRED_COLUMNS)[number], number>;
}

/** One data line → a row, or the reason it's skipped (pending, missing values, bad dates, or terminated before `since`). */
export function parseLine(cols: string[], idx: ReturnType<typeof headerIndex>, since: string): FederalCaseRow | Skip {
  const get = (c: (typeof REQUIRED_COLUMNS)[number]) => (cols[idx[c]] ?? "").trim().replace(/^"|"$/g, "");
  if (get("TAPEYEAR") === "2099") return "pending"; // codebook: "2099 on pending case records"
  const districtRaw = get("DISTRICT").toUpperCase();
  const district = /^\d$/.test(districtRaw) ? `0${districtRaw}` : districtRaw;
  const nos = Number(get("NOS")), disp = Number(get("DISP")), j = Number(get("JUDGMENT"));
  if (!district || district === "-8" || get("DISP") === "" || disp === -8 || get("NOS") === "") return "missing";
  if (!/^[0-9A-Z][0-9A-Z-]$/.test(district) || !Number.isInteger(nos) || nos < 100 || nos > 999 || !Number.isInteger(disp) || disp < 0 || disp > 20) return "bad-value";
  const filed = parseDate(get("FILEDATE")), terminated = parseDate(get("TERMDATE"));
  if (!filed || !terminated || terminated < filed) return "bad-date";
  if (terminated < since) return "too-old";
  return { district, nos, filed, terminated, disp, judgment: Number.isInteger(j) && j >= 1 && j <= 4 ? j : null };
}

// ---------------------------------------------------------------------------------------------------------------
// Benchmarks

/** Disposition groups from the codebook's DISP codes. Transfers, remands, bankruptcy stays and statistical closings are left out. */
export const DISP_GROUPS = {
  settled: [13],
  voluntary: [12],
  dismissed: [2, 3, 14],
  judgment: [4, 5, 6, 7, 8, 9, 15, 17, 19, 20],
  trial: [7, 8, 9],
  counted: [2, 3, 4, 5, 6, 7, 8, 9, 12, 13, 14, 15, 17, 19, 20],
};
export const MIN_CASES = 30;

export interface Counts {
  total: number; settled: number; voluntary: number; dismissed: number; judgment: number; trial: number;
  forPlaintiff: number; forDefendant: number; judgmentKnown: number;
  months: { p25: number; median: number; p75: number } | null;
  trialMonths: { median: number; n: number } | null;
}
/** `n` is withheld (null) when the figure is refused, so the refused share can't be worked out from it (review 38). */
export interface Share { label: string; value: number | null; n: number | null; of: number; note?: string }
export interface Benchmark { scope: string; total: number; enough: boolean; shares: Share[]; months: Counts["months"]; trialMonths: Counts["trialMonths"]; why: string }

const share = (label: string, n: number, of: number, note?: string): Share => (of >= MIN_CASES
  ? { label, n, of, value: Math.round((1000 * n) / of) / 10, note }
  : { label, n: null, of, value: null, note });

export function benchmark(scope: string, c: Counts): Benchmark {
  const enough = c.total >= MIN_CASES;
  return {
    scope, total: c.total, enough,
    shares: [
      share("Settled (dismissed after settlement)", c.settled, c.total),
      share("Voluntarily dismissed", c.voluntary, c.total),
      share("Dismissed (want of prosecution, lack of jurisdiction, other)", c.dismissed, c.total),
      share("Ended by a judgment", c.judgment, c.total),
      share("Ended by a trial (jury verdict, directed verdict or court trial)", c.trial, c.total),
      share("Judgments for the plaintiff", c.forPlaintiff, c.judgmentKnown, "of judgments where the winning side is recorded"),
      share("Judgments for the defendant", c.forDefendant, c.judgmentKnown, "of judgments where the winning side is recorded"),
    ],
    months: enough ? c.months : null,
    trialMonths: c.trialMonths && c.trialMonths.n >= MIN_CASES ? c.trialMonths : null,
    why: enough
      ? `${c.total.toLocaleString("en-US")} federal cases of this type ended in ${scope} in the period covered.`
      : `Only ${c.total} federal case${c.total === 1 ? "" : "s"} of this type ended in ${scope} in the period covered; Huis shows figures only with ${MIN_CASES} or more.`,
  };
}

export const NOT_SHOWN = [
  "No dollar amounts. Settlement amounts aren't in the federal data, and the FJC advises against analysing its amount-received field.",
  "Federal court only: state court cases aren't included.",
  "A case's nature-of-suit code is chosen when it's filed and may not match your claim exactly; a case with several claims has one code.",
  "These describe how past cases ended. They are not a prediction for this Matter.",
];
