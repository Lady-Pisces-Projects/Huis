/**
 * Phase 10 part 4: financial evidence analysis by fixed, explainable rules (no AI).
 *
 * Reads the extracted text of a bank statement, ledger, register or spreadsheet export and finds its
 * transactions: a date, a description and an amount (and a running balance when there is one). Then it
 * totals them by month and flags what an attorney should look at, each flag naming the rule that raised it
 * and quoting the exact line it came from. Huis suggests; the attorney decides. Nothing here is stored:
 * it's worked out each time from the document, as the reader.
 */

export interface Transaction {
  /** YYYY-MM-DD */
  date: string;
  description: string;
  /** Cents; money in is positive, money out negative. */
  amount: number;
  /** Running balance after this transaction, in cents, when the document shows one. */
  balance: number | null;
  /** 1-based line number in the document's text, and the line exactly as written. */
  line: number;
  text: string;
  /** Character positions of the line in the document's text (for citing it exactly). */
  start: number;
  end: number;
}

export type FlagRule = "balance" | "statement" | "duplicate" | "round" | "large" | "cash" | "transfer" | "gap";

export const FLAG_LABELS: Record<FlagRule, string> = {
  balance: "Running balance doesn't follow",
  statement: "Opening and closing balances don't add up",
  duplicate: "Possible duplicate",
  round: "Round amount",
  large: "Unusually large",
  cash: "Cash",
  transfer: "Transfer or payment app",
  gap: "Gap in dates",
};

export interface Flag {
  rule: FlagRule;
  /** Why, in plain words, with the numbers. */
  why: string;
  /** The transactions it's about (indexes into transactions). */
  refs: number[];
}

export interface MonthTotal { month: string; moneyIn: number; moneyOut: number; count: number }

export interface Analysis {
  transactions: Transaction[];
  opening: { amount: number; line: number; text: string } | null;
  closing: { amount: number; line: number; text: string } | null;
  totals: { moneyIn: number; moneyOut: number; net: number; count: number; first: string | null; last: string | null };
  months: MonthTotal[];
  flags: Flag[];
  /** True when the document looks financial (enough transactions found). */
  financial: boolean;
  /** Lines that looked like transactions but couldn't be read (e.g. a date with no year). */
  skipped: number;
  /** More transactions than Huis reads in one document. */
  truncated: boolean;
  /** Why Huis couldn't read the document's amounts (a format it doesn't read yet), or null. */
  unreadable: string | null;
}

export const MIN_TRANSACTIONS = 3;
export const MAX_TRANSACTIONS = 5000;
export const MAX_TEXT = 2_000_000;
/** Flags listed per rule (the rest are counted). */
export const MAX_FLAGS_PER_RULE = 200;
/** Rule thresholds, shown on the page so the attorney can judge them. */
export const RULES = {
  roundFrom: 100_000, // $1,000
  largeTimesMedian: 5,
  largeFrom: 50_000, // $500
  duplicateDays: 3,
  gapDays: 31,
};

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const monthNum = (name: string) => MONTHS[name.toLowerCase().slice(0, 3)] ?? null;

function realDate(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
/** Two-digit years: 00–69 are 2000s, 70–99 are 1900s (security review 26, R26-4). */
const fullYear = (y: string) => (y.length === 2 ? (Number(y) < 70 ? 2000 : 1900) + Number(y) : Number(y));

/** A date at the start of a line: 03/15/2026, 3/15/26, 2026-03-15, Mar 15, 2026, 15 Mar 2026, or 03/15 (year from the period). */
const DATE_AT_START = /^\s*(?:(\d{4})-(\d{1,2})-(\d{1,2})|(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?|([A-Za-z]{3,9})\.?\s+(\d{1,2}),?(?:\s+(\d{4}))?|(\d{1,2})\s+([A-Za-z]{3,9})\.?(?:\s+(\d{4}))?)(?=\s|,|$)/;

/** The statement period: its first and last month and year, to give dates without a year the right one. */
interface Period { start: { y: number; m: number | null } | null; end: { y: number; m: number | null } | null }
const PERIOD_LINE = /\b(statement|period|billing cycle|account summary|for the month)\b/i;
const PERIOD_DATE = /(?:\b([A-Za-z]{3,9})\.?\s+\d{1,2},?\s+|\b(\d{1,2})[/.-]\d{1,2}[/.-])?\b((?:19|20)\d{2})\b/g;
function readPeriod(lines: string[]): Period {
  // Only a line that says it's about the statement or its period (not "Thank you for banking with us since 2009").
  for (const line of lines.slice(0, 80)) {
    if (!PERIOD_LINE.test(line) || line.length > 300) continue;
    const found: { y: number; m: number | null }[] = [];
    for (const m of line.matchAll(PERIOD_DATE)) found.push({ y: Number(m[3]), m: m[1] ? monthNum(m[1]) : m[2] ? Number(m[2]) : null });
    if (found.length) {
      const named = [...line.matchAll(/\b([A-Za-z]{3,9})\.?\s+\d{1,2}\b/g)].map((x) => monthNum(x[1]!)).filter((x): x is number => !!x);
      const start = { ...found[0]!, m: found[0]!.m ?? named[0] ?? null };
      const end = { ...found.at(-1)!, m: found.at(-1)!.m ?? named.at(-1) ?? null };
      return { start, end };
    }
  }
  return { start: null, end: null };
}
/** The year for a month on a statement: a period across a year end puts later months in the first year. */
function yearFor(month: number, p: Period): number | null {
  if (!p.end) return null;
  if (p.start && p.start.y !== p.end.y && p.start.m) return month >= p.start.m ? p.start.y : p.end.y;
  return p.end.y;
}

function readDate(m: RegExpExecArray, p: Period, dayFirst: boolean): string | null | "noyear" {
  if (m[1]) return realDate(Number(m[1]), Number(m[2]), Number(m[3]));
  if (m[4]) {
    const [mo, d] = dayFirst ? [Number(m[5]), Number(m[4])] : [Number(m[4]), Number(m[5])];
    if (m[6]) return realDate(fullYear(m[6]), mo, d);
    const y = yearFor(mo, p);
    return y ? realDate(y, mo, d) : "noyear";
  }
  const name = m[7] ?? m[11];
  const day = Number(m[8] ?? m[10]);
  const year = m[9] ?? m[12];
  const mon = name ? monthNum(name) : null;
  if (!mon) return null;
  if (year) return realDate(Number(year), mon, day);
  const y = yearFor(mon, p);
  return y ? realDate(y, mon, day) : "noyear";
}

/**
 * Money with exactly two decimals: -1,234.56  (1,234.56)  1,234.56-  $1,234.56  -$1,234.56  1,234.56 CR / DR.
 * Bounded on both sides, so a long run of digits can't make it backtrack (security review 26, R26-1) and other
 * numbers (1,234.567, 192.168.1.1, 1.234,56) aren't read as amounts (R26-5). A minus sign must touch the number
 * or its $ ("AMAZON - 10.00" is a separator, not a sign; R26-7).
 */
const MONEY = /(?<![\d.,])(\()?(?:\$\s?)?([-−](?=\$?\d))?\$?(\d{1,3}(?:,\d{3})+|\d{1,10})\.(\d{2})(?![\d]|[.,]\d)(\))?(-(?![\d]))?(?:\s?(CR|DR)\b)?/gi;
/** Lines longer than this aren't read (no real statement line is anywhere near it). */
export const MAX_LINE = 4000;
/** Amounts over this ($1 billion) aren't treated as real, so totals always stay exact. */
const MAX_CENTS = 100_000_000_000;

interface Money { cents: number; signed: boolean; index: number; length: number }
function moneyIn(s: string): Money[] {
  const out: Money[] = [];
  for (const m of s.matchAll(MONEY)) {
    let cents = Number(m[3]!.replace(/,/g, "")) * 100 + Number(m[4]);
    if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) continue;
    const neg = (!!m[1] && !!m[5]) || !!m[2] || !!m[6] || (m[7] ?? "").toUpperCase() === "DR";
    const signed = neg || (m[7] ?? "").toUpperCase() === "CR";
    if (neg) cents = -cents;
    out.push({ cents, signed, index: m.index!, length: m[0].length });
  }
  return out;
}
/** A spreadsheet cell: money as above, or a whole number of dollars (bounded too; R26-3). */
function cellMoney(v: string): Money | null {
  const m = moneyIn(v)[0];
  if (m) return m;
  const w = v.replace(/[$,\s]/g, "");
  if (!/^[-−]?\d{1,10}$/.test(w)) return null;
  const cents = Number(w.replace("−", "-")) * 100;
  return Number.isSafeInteger(cents) && Math.abs(cents) <= MAX_CENTS ? { cents, signed: cents < 0, index: 0, length: 0 } : null;
}

/** Splits one CSV (or tab-separated) line, honoring quotes. */
function splitRow(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === sep) { out.push(cur.trim()); cur = ""; } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

const OPENING = /\b(beginning|opening|previous|starting|prior)\s+balance\b/i;
const CLOSING = /\b(ending|closing|new|current)\s+balance\b/i;
/** Section headings that say which way the money in it went, or that what follows are balances, not transactions. */
const OUT_SECTION = /^\s*(withdrawals?|debits?|checks?( paid)?|payments( and other debits)?|fees( charged)?|purchases|electronic withdrawals|other withdrawals|atm (and|&) debit card withdrawals)\b[^\d]*$/i;
const IN_SECTION = /^\s*(deposits?( and (other )?(additions|credits))?|credits?|additions|other credits|electronic deposits)\b[^\d]*$/i;
const BALANCE_SECTION = /^\s*(daily (ending |ledger )?balances?|balance summary|daily balance summary)\b[^\d]*$/i;
/** Comma-decimal amounts (1.234,56): a format Huis doesn't read yet. */
const COMMA_DECIMAL = /(?<![\d.,])\d{1,3}(?:\.\d{3})*,\d{2}(?![\d])/g;

/** Finds the transactions in a document's text. */
export function parseTransactions(text: string): Pick<Analysis, "transactions" | "opening" | "closing" | "skipped" | "truncated" | "unreadable"> {
  const src = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
  const transactions: Transaction[] = [];
  let opening: Analysis["opening"] = null;
  let closing: Analysis["closing"] = null;
  let skipped = 0;
  let truncated = text.length > MAX_TEXT;
  const lines = src.split("\n");
  const period = readPeriod(lines);
  // Day-first dates (15/03/2026): if any line's date can only be day/month, the whole document is (R26-5).
  let dayFirst = false;
  for (const l of lines) {
    const m = /^\s*(\d{1,2})[/.-](\d{1,2})(?:[/.-]\d{2,4})?\s/.exec(l);
    if (m && Number(m[1]) > 12 && Number(m[2]) <= 12) { dayFirst = true; break; }
  }

  // A spreadsheet export: a header row naming date and amount (or debit/credit) columns, before any transaction.
  let csv: { sep: string; date: number; desc: number; amount: number; debit: number; credit: number; balance: number } | null = null;
  let section: "in" | "out" | "balances" | null = null;

  let pos = 0;
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n]!;
    const start = pos;
    pos += raw.length + 1;
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    if (line.length > MAX_LINE) { skipped++; continue; }

    // Only before the first transaction, and only a real header row (3+ short cells; R26-6).
    if (!csv && transactions.length === 0) {
      const sep = line.includes("\t") ? "\t" : line.includes(",") ? "," : null;
      if (sep) {
        const cols = splitRow(line, sep).map((c) => c.toLowerCase());
        if (cols.length >= 3 && cols.every((c) => c.length <= 30)) {
          const find = (re: RegExp) => cols.findIndex((c) => re.test(c));
          const date = find(/^((transaction|posting|post|posted|value) )?date$/);
          const amount = find(/^(transaction )?amount( \(\w+\))?$/);
          const debit = find(/^(debits?|withdrawals?|money out|paid out)( \(\w+\))?$/);
          const credit = find(/^(credits?|deposits?|money in|paid in)( \(\w+\))?$/);
          if (date >= 0 && (amount >= 0 || debit >= 0 || credit >= 0)) {
            csv = { sep, date, desc: find(/^(description|details|memo|payee|name|narrative|transaction)$/), amount, debit, credit, balance: find(/balance/) };
            continue;
          }
        }
      }
    }

    if (!csv) {
      if (OUT_SECTION.test(line)) { section = "out"; continue; }
      if (IN_SECTION.test(line)) { section = "in"; continue; }
      if (BALANCE_SECTION.test(line)) { section = "balances"; continue; }
    }

    if (OPENING.test(line) && !DATE_AT_START.test(line)) {
      const m = moneyIn(line).at(-1);
      if (m && !opening) opening = { amount: m.cents, line: n + 1, text: line.trim() };
      continue;
    }
    if (CLOSING.test(line) && !DATE_AT_START.test(line)) {
      const m = moneyIn(line).at(-1);
      if (m) closing = { amount: m.cents, line: n + 1, text: line.trim() };
      continue;
    }

    if (transactions.length >= MAX_TRANSACTIONS) { truncated = true; break; }

    if (csv) {
      const cols = splitRow(line, csv.sep);
      const dm = DATE_AT_START.exec(cols[csv.date] ?? "");
      if (!dm) continue;
      const date = readDate(dm, period, dayFirst);
      if (date === "noyear" || date === null) { skipped++; continue; }
      const cell = (i: number) => (i >= 0 ? cellMoney(cols[i] ?? "") : null);
      let amount: number | null = null;
      if (csv.amount >= 0) amount = cell(csv.amount)?.cents ?? null;
      else {
        const d = cell(csv.debit);
        const c = cell(csv.credit);
        if (d && d.cents !== 0) amount = -Math.abs(d.cents);
        else if (c && c.cents !== 0) amount = Math.abs(c.cents);
      }
      if (amount === null) { skipped++; continue; }
      const bal = cell(csv.balance);
      transactions.push({
        date, description: (csv.desc >= 0 ? cols[csv.desc] ?? "" : cols.filter((_, i) => i !== csv!.date).join(" ")).slice(0, 300),
        amount, balance: bal ? bal.cents : null, line: n + 1, text: line.trim().slice(0, 500), start, end: start + line.length,
      });
      continue;
    }

    const dm = DATE_AT_START.exec(line);
    if (!dm) continue;
    const rest = line.slice(dm[0].length);
    const money = moneyIn(rest);
    if (money.length === 0) continue;
    // A date with one amount in a "daily balance" section is a balance, not a transaction (R26-8).
    if (section === "balances" && money.length === 1) continue;
    const date = readDate(dm, period, dayFirst);
    if (date === "noyear" || date === null) { skipped++; continue; }
    // One amount: the transaction. Two or more: the last is the running balance, the one before it the amount.
    const amt = money.length >= 2 ? money[money.length - 2]! : money[0]!;
    const bal = money.length >= 2 ? money[money.length - 1]! : null;
    const description = rest.slice(0, amt.index).replace(/\s+/g, " ").trim().slice(0, 300);
    let amount = amt.cents;
    // Unsigned amounts under a "Withdrawals" (or "Deposits") heading go that way (R26-12).
    if (!amt.signed && section === "out") amount = -Math.abs(amount);
    transactions.push({
      date, description, amount, balance: bal ? bal.cents : null,
      line: n + 1, text: line.trim().slice(0, 500), start, end: start + line.length,
      ...(amt.signed || section ? {} : { unsigned: true }),
    } as Transaction);
  }

  // Unsigned amounts with a running balance: the balance says which way the money went. With no opening balance,
  // the first one stays as written.
  const list = transactions as (Transaction & { unsigned?: boolean })[];
  let prev: number | null = opening?.amount ?? null;
  for (let i = 0; i < list.length; i++) {
    const t = list[i]!;
    if (t.unsigned && t.balance !== null) {
      if (prev !== null) {
        if (prev - Math.abs(t.amount) === t.balance) t.amount = -Math.abs(t.amount);
        else if (prev + Math.abs(t.amount) === t.balance) t.amount = Math.abs(t.amount);
      }
    }
    delete t.unsigned;
    prev = t.balance ?? (prev === null ? null : prev + t.amount);
  }

  // Comma-decimal amounts (European style) aren't read: say so rather than guess (R26-5).
  let unreadable: string | null = null;
  if (transactions.length < MIN_TRANSACTIONS && (src.slice(0, 200_000).match(COMMA_DECIMAL)?.length ?? 0) >= MIN_TRANSACTIONS) {
    unreadable = "Amounts here use a comma for cents (1.234,56). Huis reads US-style amounts (1,234.56) only for now.";
  }
  return { transactions, opening, closing, skipped, truncated, unreadable };
}

const dollars = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\b\d{4,}\b/g, "").trim();
const CASH = /\b(atm|cash withdrawal|cash wd|withdrawal|cash)\b/i;
const TRANSFER = /\b(zelle|venmo|paypal|cash ?app|wire|transfer|xfer|trnsfr)\b/i;

/** Totals, months and flags for a list of transactions (in document order). */
export function analyzeTransactions(p: ReturnType<typeof parseTransactions>): Analysis {
  const tx = p.transactions;
  const flags: Flag[] = [];
  const moneyIn = tx.filter((t) => t.amount > 0).reduce((a, t) => a + t.amount, 0);
  const moneyOut = tx.filter((t) => t.amount < 0).reduce((a, t) => a + t.amount, 0);
  const sorted = [...tx.keys()].sort((a, b) => (tx[a]!.date < tx[b]!.date ? -1 : tx[a]!.date > tx[b]!.date ? 1 : a - b));

  const byMonth = new Map<string, MonthTotal>();
  for (const t of tx) {
    const m = t.date.slice(0, 7);
    const row = byMonth.get(m) ?? { month: m, moneyIn: 0, moneyOut: 0, count: 0 };
    if (t.amount > 0) row.moneyIn += t.amount; else row.moneyOut += t.amount;
    row.count++;
    byMonth.set(m, row);
  }

  // Running balance: each balance should be the one before plus this amount.
  let prev: number | null = p.opening?.amount ?? null;
  tx.forEach((t, i) => {
    if (t.balance !== null && prev !== null && prev + t.amount !== t.balance) {
      flags.push({ rule: "balance", refs: [i], why: `The balance before was ${dollars(prev)}; with ${dollars(t.amount)} it should be ${dollars(prev + t.amount)}, but the document shows ${dollars(t.balance)} (a difference of ${dollars(t.balance - prev - t.amount)}).` });
    }
    prev = t.balance ?? (prev === null ? null : prev + t.amount);
  });

  if (p.opening && p.closing && tx.length) {
    const expected = p.opening.amount + moneyIn + moneyOut;
    if (expected !== p.closing.amount) {
      flags.push({ rule: "statement", refs: [], why: `Opening balance ${dollars(p.opening.amount)} (line ${p.opening.line}) plus the ${tx.length} transactions found (${dollars(moneyIn + moneyOut)}) is ${dollars(expected)}, but the closing balance is ${dollars(p.closing.amount)} (line ${p.closing.line}). Transactions may be missing or misread.` });
    }
  }

  // Duplicates: same amount and description within a few days, or same amount on the same day. Each transaction
  // is matched only with the nearest earlier one with the same amount, found through a map keyed by amount, so a
  // large ledger stays fast (security review 26, R26-2).
  const dayNo = tx.map((t) => Math.round(Date.parse(`${t.date}T00:00:00Z`) / 86_400_000));
  const byAmount = new Map<number, number[]>();
  for (const i of sorted) {
    const tb = tx[i]!;
    if (tb.amount === 0) continue;
    const earlier = byAmount.get(tb.amount) ?? [];
    for (let k = earlier.length - 1; k >= 0; k--) {
      const j = earlier[k]!;
      const gap = dayNo[i]! - dayNo[j]!;
      if (gap > RULES.duplicateDays) break;
      const ta = tx[j]!;
      const sameDesc = norm(ta.description) !== "" && norm(ta.description) === norm(tb.description);
      if (!sameDesc && gap !== 0) continue;
      flags.push({ rule: "duplicate", refs: [j, i], why: `${dollars(ta.amount)} ${sameDesc ? "to the same payee" : "on the same day"} on lines ${ta.line} and ${tb.line}${gap === 0 ? "" : `, ${gap} day(s) apart`}.` });
      break;
    }
    earlier.push(i);
    // Only the last few days matter.
    while (earlier.length && dayNo[i]! - dayNo[earlier[0]!]! > RULES.duplicateDays) earlier.shift();
    if (earlier.length > 50) earlier.splice(0, earlier.length - 50);
    byAmount.set(tb.amount, earlier);
  }

  const abs = tx.map((t) => Math.abs(t.amount)).sort((a, b) => a - b);
  const median = abs.length ? abs[Math.floor((abs.length - 1) / 2)]! : 0;
  tx.forEach((t, i) => {
    const a = Math.abs(t.amount);
    if (a >= RULES.roundFrom && a % 10_000 === 0) {
      flags.push({ rule: "round", refs: [i], why: `${dollars(t.amount)} is a whole hundred dollars (round amounts of $1,000 or more are worth a look).` });
    }
    if (tx.length >= 5 && a >= RULES.largeFrom && median > 0 && a >= RULES.largeTimesMedian * median) {
      flags.push({ rule: "large", refs: [i], why: `${dollars(t.amount)} is ${Math.round(a / median)} times the typical (median) transaction of ${dollars(median)}.` });
    }
    if (t.amount < 0 && CASH.test(t.description)) flags.push({ rule: "cash", refs: [i], why: `"${t.description}" reads as cash taken out (${dollars(t.amount)}).` });
    if (TRANSFER.test(t.description)) flags.push({ rule: "transfer", refs: [i], why: `"${t.description}" reads as a transfer or payment-app movement (${dollars(t.amount)}).` });
  });

  for (let k = 1; k < sorted.length; k++) {
    const a = tx[sorted[k - 1]!]!, b = tx[sorted[k]!]!;
    const d = days(a.date, b.date);
    if (d > RULES.gapDays) flags.push({ rule: "gap", refs: [sorted[k - 1]!, sorted[k]!], why: `No transactions for ${d} days, between ${a.date} (line ${a.line}) and ${b.date} (line ${b.line}). A statement or page may be missing.` });
  }

  // At most MAX_FLAGS_PER_RULE of each kind are listed; the rest are counted.
  const kept: Flag[] = [];
  const counts = new Map<FlagRule, number>();
  for (const f of flags) {
    const n = (counts.get(f.rule) ?? 0) + 1;
    counts.set(f.rule, n);
    if (n <= MAX_FLAGS_PER_RULE) kept.push(f);
  }
  for (const [rule, n] of counts) {
    if (n > MAX_FLAGS_PER_RULE) kept.push({ rule, refs: [], why: `…and ${n - MAX_FLAGS_PER_RULE} more like this (only the first ${MAX_FLAGS_PER_RULE} are listed).` });
  }

  return {
    ...p,
    flags: kept,
    totals: { moneyIn, moneyOut, net: moneyIn + moneyOut, count: tx.length, first: sorted.length ? tx[sorted[0]!]!.date : null, last: sorted.length ? tx[sorted.at(-1)!]!.date : null },
    months: [...byMonth.values()].sort((a, b) => (a.month < b.month ? -1 : 1)),
    financial: tx.length >= MIN_TRANSACTIONS,
  };
}

export function analyzeText(text: string): Analysis {
  return analyzeTransactions(parseTransactions(text));
}
