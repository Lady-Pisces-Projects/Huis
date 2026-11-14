/**
 * Huis staff only: load the FJC Integrated Database civil file for federal benchmarks (Phase 11 part 3).
 *
 * Runs with the database owner's connection (HUIS_MIGRATION_DATABASE_URL); the app can read the data but never write
 * it. Download cv88on.zip from https://www.fjc.gov/node/13146, unzip it, then:
 *
 *   npx tsx scripts/operator/import-fjc-idb.ts --file cv88on.txt [--years 10]
 *
 * Keeps cases that ended in the last N years (default 10), and only district, nature of suit, dates, disposition and
 * judgment. Dollar fields are not imported. Replaces the previous load in one transaction, and refuses the file if
 * more than 5% of the ended cases have dates it can't read (a sign the format isn't what the codebook describes).
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import pg from "pg";
import { headerIndex, parseLine, type FederalCaseRow, type Skip } from "../../src/benchmarks/federal";

export interface ImportResult { rowsRead: number; rowsKept: number; skipped: Record<Skip, number>; from: string | null; through: string | null }

async function sha256(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

export async function importFile(db: pg.ClientBase, path: string, years = 10, today = new Date()): Promise<ImportResult> {
  if (!Number.isInteger(years) || years < 1 || years > 40) throw new Error("--years must be between 1 and 40.");
  const since = new Date(Date.UTC(today.getUTCFullYear() - years, today.getUTCMonth(), today.getUTCDate())).toISOString().slice(0, 10);
  const digest = await sha256(path);
  let idx: ReturnType<typeof headerIndex> | null = null;
  const skipped: Record<Skip, number> = { pending: 0, missing: 0, "bad-date": 0, "bad-value": 0, "too-old": 0 };
  let rowsRead = 0, rowsKept = 0;
  let from: string | null = null, through: string | null = null;
  let batch: FederalCaseRow[] = [];
  const flush = async () => {
    if (!batch.length) return;
    await db.query(
      `INSERT INTO huis.federal_cases (district, nos, filed, terminated, disp, judgment)
       SELECT * FROM unnest($1::text[], $2::smallint[], $3::date[], $4::date[], $5::smallint[], $6::smallint[])`,
      [batch.map((r) => r.district), batch.map((r) => r.nos), batch.map((r) => r.filed), batch.map((r) => r.terminated), batch.map((r) => r.disp), batch.map((r) => r.judgment)]);
    batch = [];
  };
  await db.query("BEGIN");
  try {
    await db.query("DELETE FROM huis.federal_cases");
    // Opened only now: lines read before the loop starts would be lost.
    const lines = createInterface({ input: createReadStream(path, { encoding: "latin1" }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const cols = line.split("\t");
      if (!idx) { idx = headerIndex(cols); continue; }
      rowsRead++;
      const r = parseLine(cols, idx, since);
      if (typeof r === "string") { skipped[r]++; continue; }
      rowsKept++;
      if (!from || r.terminated < from) from = r.terminated;
      if (!through || r.terminated > through) through = r.terminated;
      batch.push(r);
      if (batch.length >= 5000) await flush();
    }
    await flush();
    if (!idx) throw new Error("The file is empty.");
    const ended = rowsRead - skipped.pending;
    if (ended > 0 && skipped["bad-date"] / ended > 0.05) {
      throw new Error(`${skipped["bad-date"]} of ${ended} ended cases have dates that can't be read. Check the file's date format against the codebook; nothing was loaded.`);
    }
    if (!rowsKept) throw new Error("No cases were kept; nothing was loaded.");
    await db.query(
      "INSERT INTO huis.federal_imports (file_name, sha256, rows_read, rows_kept, terminated_from, terminated_through) VALUES ($1, $2, $3, $4, $5, $6)",
      [basename(path).slice(0, 300), digest, rowsRead, rowsKept, from, through]);
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
  return { rowsRead, rowsKept, skipped, from, through };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const file = opt("--file");
  if (!file) throw new Error("Usage: npx tsx scripts/operator/import-fjc-idb.ts --file cv88on.txt [--years 10]");
  const url = process.env.HUIS_MIGRATION_DATABASE_URL;
  if (!url) throw new Error("HUIS_MIGRATION_DATABASE_URL isn't set.");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const r = await importFile(client, file, opt("--years") ? Number(opt("--years")) : 10);
    console.log(`Loaded ${r.rowsKept.toLocaleString("en-US")} of ${r.rowsRead.toLocaleString("en-US")} cases (ended ${r.from} to ${r.through}). Skipped:`, r.skipped);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && /import-fjc-idb/.test(process.argv[1])) {
  main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
}
