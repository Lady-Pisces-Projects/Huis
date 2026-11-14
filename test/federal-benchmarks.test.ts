import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { benchmark, DISTRICTS_BY_STATE, headerIndex, nosFor, parseDate, parseLine } from "../src/benchmarks/federal";
import { importFile } from "../scripts/operator/import-fjc-idb";
import { federalBenchmarks } from "../src/services/benchmarks";
import { createClient } from "../src/services/clients";
import { addClaimFromTemplate } from "../src/services/dna";
import { acceptInvitation } from "../src/services/firms";
import { addMatterMember, createMatter } from "../src/services/matters";
import { inviteUser } from "../src/services/users";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

/* Phase 11 part 3: federal benchmarks from the FJC Integrated Database (src/benchmarks/federal.ts). No dollar values. */

const HEADER = ["CIRCUIT", "DISTRICT", "OFFICE", "DOCKET", "NOS", "FILEDATE", "TERMDATE", "DISP", "NOJ", "AMTREC", "JUDGMENT", "TAPEYEAR"];
const line = (o: Partial<Record<string, string>>) => HEADER.map((h) => o[h] ?? "").join("\t");

describe("reading the FJC file", () => {
  const idx = headerIndex(HEADER);
  it("reads the codebook's fields, skips pending, missing and old cases, and never keeps dollar fields", () => {
    expect(parseDate("04/18/2024")).toBe("2024-04-18");
    expect(parseDate("2024-04-18")).toBe("2024-04-18");
    expect(parseDate("20240418")).toBe("2024-04-18");
    expect(parseDate("18APR2024")).toBe("2024-04-18");
    expect(parseDate("02/30/2024")).toBeNull();
    const ok = parseLine(line({ DISTRICT: "88", NOS: "751", FILEDATE: "01/02/2022", TERMDATE: "03/04/2023", DISP: "13", JUDGMENT: "-8", AMTREC: "9999", TAPEYEAR: "2023" }).split("\t"), idx, "2016-01-01");
    expect(ok).toEqual({ district: "88", nos: 751, filed: "2022-01-02", terminated: "2023-03-04", disp: 13, judgment: null });
    expect(JSON.stringify(ok)).not.toMatch(/9999/);
    expect(parseLine(line({ DISTRICT: "88", NOS: "751", FILEDATE: "01/02/2022", TERMDATE: "", DISP: "-8", TAPEYEAR: "2099" }).split("\t"), idx, "2016-01-01")).toBe("pending");
    expect(parseLine(line({ DISTRICT: "-8", NOS: "751", FILEDATE: "01/02/2022", TERMDATE: "03/04/2023", DISP: "13", TAPEYEAR: "2023" }).split("\t"), idx, "2016-01-01")).toBe("missing");
    expect(parseLine(line({ DISTRICT: "88", NOS: "751", FILEDATE: "01/02/2012", TERMDATE: "03/04/2013", DISP: "13", TAPEYEAR: "2013" }).split("\t"), idx, "2016-01-01")).toBe("too-old");
    expect(parseLine(line({ DISTRICT: "88", NOS: "751", FILEDATE: "05/02/2022", TERMDATE: "03/04/2022", DISP: "13", TAPEYEAR: "2022" }).split("\t"), idx, "2016-01-01")).toBe("bad-date");
    expect(parseLine(line({ DISTRICT: "7-", NOS: "442", FILEDATE: "01/02/2022", TERMDATE: "03/04/2023", DISP: "7", JUDGMENT: "1", TAPEYEAR: "2023" }).split("\t"), idx, "2016-01-01")).toMatchObject({ district: "7-", judgment: 1 });
    expect(() => headerIndex(["DISTRICT", "NOS"])).toThrow(/missing columns.*FILEDATE/);
  });

  it("maps claims to nature-of-suit codes and states to districts", () => {
    expect(nosFor("FMLA retaliation")?.nos).toBe(751);
    expect(nosFor("ADA failure to accommodate")?.nos).toBe(445);
    expect(nosFor("Title VII race discrimination")?.nos).toBe(442);
    expect(nosFor("FLSA unpaid overtime")?.nos).toBe(710);
    expect(nosFor("Breach of contract (Utah)")?.nos).toBe(190);
    expect(nosFor("Defamation")).toBeNull();
    expect(DISTRICTS_BY_STATE.UT).toEqual(["88"]);
    expect(Object.values(DISTRICTS_BY_STATE).flat()).toHaveLength(94);
  });

  it("shows figures only with 30 or more cases", () => {
    const few = benchmark("federal court in UT", { total: 12, settled: 6, voluntary: 2, dismissed: 1, judgment: 3, trial: 1, forPlaintiff: 1, forDefendant: 2, judgmentKnown: 3, months: { p25: 5, median: 9, p75: 14 }, trialMonths: { median: 20, n: 1 } });
    expect(few.enough).toBe(false);
    expect(few.months).toBeNull();
    expect(few.shares.every((s) => s.value === null)).toBe(true);
    expect(few.why).toMatch(/Only 12 federal cases.*30 or more/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });

describe("loading and using the data", () => {
  it("loads a file in one go, refuses a bad file, and benchmarks a Matter's claims for staff only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fjc-"));
    const rows = [HEADER.join("\t")];
    // 40 FMLA cases nationwide: 10 in Utah. 24 settled, 8 voluntary, 4 jury verdicts (3 for plaintiff), 4 motions (defendant).
    for (let i = 0; i < 40; i++) {
      const disp = i < 24 ? "13" : i < 32 ? "12" : i < 36 ? "7" : "6";
      const judgment = i < 24 ? "-8" : i < 32 ? "-8" : i < 35 ? "1" : "2";
      rows.push(line({ DISTRICT: i < 10 ? "88" : "82", NOS: "751", FILEDATE: "01/01/2023", TERMDATE: i < 20 ? "07/01/2023" : "01/01/2024", DISP: disp, JUDGMENT: judgment, AMTREC: "9999", TAPEYEAR: "2024" }));
    }
    rows.push(line({ DISTRICT: "88", NOS: "751", FILEDATE: "01/01/2025", DISP: "-8", TAPEYEAR: "2099" }));
    writeFileSync(join(dir, "cv.txt"), rows.join("\n"));
    const bad = [HEADER.join("\t"), ...Array.from({ length: 10 }, () => line({ DISTRICT: "88", NOS: "751", FILEDATE: "Jan 1 2023", TERMDATE: "Feb 1 2023", DISP: "13", TAPEYEAR: "2023" }))];
    writeFileSync(join(dir, "bad.txt"), bad.join("\n"));

    const owner = await t.admin.connect();
    try {
      const r = await importFile(owner, join(dir, "cv.txt"), 10, new Date("2026-11-13T00:00:00Z"));
      expect(r).toMatchObject({ rowsRead: 41, rowsKept: 40, from: "2023-07-01", through: "2024-01-01" });
      expect(r.skipped.pending).toBe(1);
      await expect(importFile(owner, join(dir, "bad.txt"), 10, new Date("2026-11-13T00:00:00Z"))).rejects.toThrow(/dates or codes that can't be read/);
      expect((await owner.query("SELECT count(*)::int AS n FROM huis.federal_cases")).rows[0].n).toBe(40); // the failed load changed nothing
      const cols = (await owner.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'huis' AND table_name = 'federal_cases'")).rows.map((x) => x.column_name);
      expect(cols.some((c) => /amt|amount|demand/i.test(c))).toBe(false);
    } finally {
      owner.release();
    }

    const f = await newFirm(t.db);
    const x = await t.db.withFirm(f.owner, async (s) => {
      const client = await createClient(s, { kind: "person", displayName: "Pat Smith", email: "pat@example.com" });
      const matter = await createMatter(s, { title: "Smith v. Acme", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
      const portal = await inviteUser(s, { email: `c@${f.slug}.example`, fullName: "Casey Client", role: "client", locationId: f.locationId });
      await addClaimFromTemplate(s, matter.id, "fmla_retaliation");
      return { matter, portal };
    });
    const b = await t.db.withFirm(f.owner, (s) => federalBenchmarks(s, x.matter.id));
    expect(b.loaded).toMatchObject({ from: "2023-07-01", through: "2024-01-01" });
    const c = b.claims[0]!;
    expect(c.nos).toBe(751);
    expect(c.state!.enough).toBe(false); // 10 Utah cases
    expect(c.national!.enough).toBe(true);
    const pctOf = (label: RegExp) => c.national!.shares.find((s) => label.test(s.label))!;
    expect(pctOf(/^Settled/).value).toBe(60);
    expect(pctOf(/^Ended by a trial/).value).toBe(10);
    expect(pctOf(/for the plaintiff/)).toMatchObject({ n: null, of: 8, value: null }); // only 8 judgments: under 30, not shown (nor the count inside it)
    expect(c.national!.months).toMatchObject({ median: expect.any(Number) });
    expect(JSON.stringify(b)).not.toMatch(/\$|9999|probab/i);

    // The app can read the reference data but never change it; a client can't see benchmarks.
    await expect(t.db.withFirm(f.owner, (s) => s.client.query("DELETE FROM huis.federal_cases"))).rejects.toThrow(/permission/i);
    const portal = (await acceptInvitation(t.db, x.portal.invitationToken, "google", String(10n ** 20n + BigInt(randomBytes(5).readUIntBE(0, 5)))))!;
    await t.db.withFirm(f.owner, (s) => addMatterMember(s, { matterId: x.matter.id, userId: x.portal.id, access: "view", acknowledgePrivilegeWaiverRisk: true }));
    await expect(t.db.withFirm(portal, (s) => federalBenchmarks(s, x.matter.id))).rejects.toThrow();
  });
});
