import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { benchmark, nosFor } from "../src/benchmarks/federal";
import { importFile } from "../scripts/operator/import-fjc-idb";
import { federalBenchmarks } from "../src/services/benchmarks";
import { createClient } from "../src/services/clients";
import { addClaimFromTemplate } from "../src/services/dna";
import { createMatter } from "../src/services/matters";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

/*
 * Independent security and correctness review 38: Phase 11 part 3, federal benchmarks from the FJC Integrated
 * Database (civil), no dollar values (commits 0f25759 and 01a5afb vs main).
 *
 * Reviewed: migration 0047, src/benchmarks/federal.ts (district map, NOS mapping, parsing, benchmark, DISP groups,
 * 30-case rule), src/services/benchmarks.ts, scripts/operator/import-fjc-idb.ts, the benchmarks page, docs, and every
 * code mapping against docs/source/fjc-civil-codebook-1988-forward-2023-10-25.pdf.
 *
 * Each test below fails on the reviewed code and passes once the finding is fixed.
 *   R38-1  NOS rule order / word match: ERISA disability claims and "Ada" (a name, Ada County) map to ADA employment (445).
 *   R38-2  NOS rules too broad: negligent misrepresentation -> personal injury, Fair Housing -> employment, ADA Title III -> employment.
 *   R38-3  Under-30 shares still expose their numerator ("3 of 8"), so the refused figure can be read off the page.
 *   R38-4  The "cases that ended from / to" dates shift a day on a server east of UTC (pg date -> local Date -> toISOString).
 *   R38-5  Two imports at once leave the table holding both loads (DELETE doesn't lock out a concurrent load).
 *   R38-6  The importer's 5% refusal covers only unreadable dates: a file whose districts/NOS/DISP don't parse loads a fraction silently.
 */

const HEADER = ["CIRCUIT", "DISTRICT", "OFFICE", "DOCKET", "NOS", "FILEDATE", "TERMDATE", "DISP", "NOJ", "AMTREC", "JUDGMENT", "TAPEYEAR"];
const line = (o: Partial<Record<string, string>>) => HEADER.map((h) => o[h] ?? "").join("\t");
const TODAY = new Date("2026-11-13T00:00:00Z");
const dir = mkdtempSync(join(tmpdir(), "fjc-r38-"));

function goodFile(name: string, n = 40, extra: string[] = []): string {
  const rows = [HEADER.join("\t")];
  for (let i = 0; i < n; i++) {
    rows.push(line({ DISTRICT: i < 10 ? "88" : "82", NOS: "751", FILEDATE: "01/01/2023", TERMDATE: "07/01/2023", DISP: "13", JUDGMENT: "-8", TAPEYEAR: "2024" }));
  }
  rows.push(...extra);
  const p = join(dir, name);
  writeFileSync(p, rows.join("\n"));
  return p;
}

describe("R38-1: claim names that aren't the ADA map to ADA employment", () => {
  it("R38-1a: an ERISA disability-benefits claim maps to ERISA (791), not ADA employment (445)", () => {
    expect(nosFor("ERISA long-term disability benefits")?.nos).toBe(791);
    expect(nosFor("Denial of disability benefits under ERISA")?.nos).toBe(791);
  });
  it("R38-1b: the name Ada (Ada County, a person) is not the Americans with Disabilities Act", () => {
    expect(nosFor("Breach of contract with Ada County")?.nos).toBe(190);
    expect(nosFor("Negligence (Ada Park injury)")?.nos).not.toBe(445);
  });
});

describe("R38-2: generic words send claims to the wrong federal case type", () => {
  it("R38-2: negligent misrepresentation isn't personal injury; Fair Housing isn't employment; ADA Title III isn't employment", () => {
    expect(nosFor("Negligent misrepresentation")?.nos).not.toBe(360);
    expect(nosFor("Fair Housing Act discrimination")?.nos).not.toBe(442);
    expect(nosFor("ADA Title III public accommodation")?.nos).not.toBe(445);
  });
});

describe("R38-3: a share refused for having under 30 cases still shows its numerator", () => {
  it("R38-3: a refused share doesn't carry the count that lets the reader work out the figure", () => {
    const b = benchmark("federal courts nationwide", {
      total: 40, settled: 24, voluntary: 8, dismissed: 0, judgment: 8, trial: 4, forPlaintiff: 3, forDefendant: 5, judgmentKnown: 8,
      months: { p25: 6, median: 9, p75: 12 }, trialMonths: null,
    });
    const refused = b.shares.filter((s) => s.value === null);
    expect(refused.length).toBe(2);
    // The page prints `${n} of ${of}` next to "Fewer than 30": "3 of 8" is the refused 37.5%.
    for (const s of refused) expect(s.n ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });

const count = async () => (await t.admin.query("SELECT count(*)::int AS n FROM huis.federal_cases")).rows[0].n as number;

describe("database findings", () => {
  it("R38-4: the period loaded is shown with the right dates on a server east of UTC", async () => {
    const owner = await t.admin.connect();
    try { await importFile(owner, goodFile("tz.txt"), 10, TODAY); } finally { owner.release(); }
    const f = await newFirm(t.db);
    const matterId = await t.db.withFirm(f.owner, async (s) => {
      const client = await createClient(s, { kind: "person", displayName: "Pat Smith", email: "pat@example.com" });
      const m = await createMatter(s, { title: "Smith v. Acme", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
      await addClaimFromTemplate(s, m.id, "fmla_retaliation");
      return m.id;
    });
    const tz = process.env.TZ;
    process.env.TZ = "Asia/Tokyo";
    try {
      const b = await t.db.withFirm(f.owner, (s) => federalBenchmarks(s, matterId));
      expect(b.loaded).toMatchObject({ from: "2023-07-01", through: "2023-07-01" });
    } finally {
      if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
    }
  });

  it("R38-5: an import that runs while another is loading leaves one load, not both", async () => {
    const file = goodFile("concurrent.txt");
    const a = await t.admin.connect();
    const b = await t.admin.connect();
    try {
      await importFile(b, file, 10, TODAY);
      expect((await b.query("SELECT count(*)::int AS n FROM huis.federal_cases")).rows[0].n).toBe(40);
      // Load A is in progress (old rows deleted, its rows inserted, not yet committed)...
      await a.query("BEGIN");
      await a.query("DELETE FROM huis.federal_cases");
      await a.query(`INSERT INTO huis.federal_cases (district, nos, filed, terminated, disp, judgment)
                     SELECT '88', 751, '2023-01-01', '2023-07-01', 13, NULL FROM generate_series(1, 40)`);
      // ...when load B starts. It waits on A's row locks; A then commits.
      const pending = importFile(b, file, 10, TODAY);
      await new Promise((r) => setTimeout(r, 500));
      await a.query("COMMIT");
      await pending;
    } finally {
      a.release();
      b.release();
    }
    expect(await count()).toBe(40); // today: 80, both loads, every count doubled
  });

  it("R38-6: a file where most cases have unreadable codes is refused, not loaded in part", async () => {
    const owner = await t.admin.connect();
    try {
      await importFile(owner, goodFile("base.txt"), 10, TODAY);
      expect(await count()).toBe(40);
      // 60 of 100 ended cases have a district the codebook doesn't use (three digits): only 40% would load.
      const extra = Array.from({ length: 60 }, () => line({ DISTRICT: "088", NOS: "751", FILEDATE: "01/01/2023", TERMDATE: "07/01/2023", DISP: "13", TAPEYEAR: "2024" }));
      await expect(importFile(owner, goodFile("mostly-bad.txt", 40, extra), 10, TODAY)).rejects.toThrow();
    } finally {
      owner.release();
    }
  });
});
