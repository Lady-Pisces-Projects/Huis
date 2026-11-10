/**
 * Security review 26: Phase 10.4 financial evidence analysis (commit fde6f98).
 * Each test is expected to FAIL against fde6f98 and pass once the finding is fixed.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { analyzeText } from "../src/finance/analyze";
import { createClient } from "../src/services/clients";
import { assembleOriginal, getUploadSession, markChunkReceived, newEvidenceId, recordEvidence, startUpload, storeChunk } from "../src/services/evidence";
import { documentFinancials, matterFinancials } from "../src/services/finance";
import { createMatter } from "../src/services/matters";
import { inviteUser } from "../src/services/users";
import { MasterKeyProvider } from "../src/storage/encryption";
import type { MalwareScanner } from "../src/storage/scanner";
import { EvidenceVault, LocalObjectStore } from "../src/storage/store";
import { EvidenceProcessor } from "../src/worker/processor";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

const rows = (s: string) => analyzeText(s).transactions.map((t) => [t.date, t.description, t.amount, t.balance]);

describe("R26-1: MONEY regex is quadratic on a long digit run (event-loop DoS from one uploaded document)", () => {
  it("a 60,000-digit run without a decimal point is read in well under a second", () => {
    // fde6f98: ~3 s for 60k digits, ~21 s for 160k; a 2 MB line (MAX_TEXT) is close to an hour, per view.
    const t0 = Date.now();
    analyzeText(`Opening balance ${"9".repeat(60_000)}\n`);
    expect(Date.now() - t0).toBeLessThan(500);
  }, 60_000);
});

describe("R26-2: duplicate rule is O(n^2) with Date.parse in the inner loop", () => {
  it("5,000 transactions on one day with distinct amounts are analysed in well under a second", () => {
    const s = Array.from({ length: 5000 }, (_, i) => `01/01/2026 Item ${i}.${String(i % 100).padStart(2, "0")}`).join("\n");
    const t0 = Date.now();
    expect(analyzeText(s).transactions).toHaveLength(5000);
    expect(Date.now() - t0).toBeLessThan(1000); // fde6f98: ~5 s per document; x200 documents per summary view
  }, 60_000);
});

describe("R26-3: CSV whole-number cells are not bounded (Infinity / NaN / unsafe integers in totals)", () => {
  it("keeps every amount and total a safe integer", () => {
    const a = analyzeText(`Date,Description,Amount\n2026-03-01,Pay,${"9".repeat(400)}\n2026-03-02,Rent,-${"9".repeat(400)}\n2026-03-03,Coffee,-4.50\n2026-03-04,Big,99999999999999999999\n`);
    for (const t of a.transactions) expect(Number.isSafeInteger(t.amount)).toBe(true);
    expect(Number.isSafeInteger(a.totals.net)).toBe(true); // fde6f98: net is NaN (Infinity + -Infinity)
  });
});

describe("R26-4: dates silently get the wrong year", () => {
  it("a statement spanning December-January puts January in the next year", () => {
    const r = rows("Statement period Dec 15, 2025 through Jan 14, 2026\n12/20 A 10.00\n01/05 B 20.00\n01/10 C 30.00");
    expect(r.map((x) => x[0])).toEqual(["2025-12-20", "2026-01-05", "2026-01-10"]); // fde6f98: 2025-01-05, 2025-01-10 + a false 'gap' flag
  });
  it("the year hint is not taken from unrelated prose containing 'for'", () => {
    const r = rows("Thank you for banking with us since 2009.\nStatement period March 1 - March 31, 2026\n03/05 A 10.00\n03/06 B 20.00\n03/07 C 30.00");
    expect(r.map((x) => x[0])).toEqual(["2026-03-05", "2026-03-06", "2026-03-07"]); // fde6f98: 2009-03-0x
  });
  it("two-digit year 99 is not 2099", () => {
    expect(rows("03/01/99 A 10.00\n03/02/99 B 20.00\n03/03/99 C 30.00")[0]![0]).toBe("1999-03-01");
  });
});

describe("R26-5: MONEY has no digit boundaries, so other numbers are read as wrong amounts", () => {
  it("European amounts are not silently read as cents-off US amounts", () => {
    const a = analyzeText("Kontoauszug 2026\n03.04.2026 Miete 1.234,56 2.000,00\n04.04.2026 Lohn 2.500,00 4.500,00\n05.04.2026 Kaffee 4,50 4.495,50");
    // fde6f98: Miete = $1.23 with balance $2.00, Lohn = $2.50 ... and the document counts as financial.
    expect(a.transactions.some((t) => t.amount === 123 || t.amount === 250)).toBe(false);
  });
  it("three-decimal numbers and IP-like references are not amounts", () => {
    expect(rows("Statement period 2026\n03/01/2026 A 1,234.567\n03/02/2026 B 20.00\n03/03/2026 C 30.00")[0]![2]).not.toBe(123456);
    const r = rows("Statement period 2026\n03/01/2026 Payment ref 192.168.1.1 10.00\n03/02/2026 B 20.00\n03/03/2026 C 30.00");
    expect(r[0]![2]).toBe(1000); // fde6f98: amount $192.16, balance $10.00
  });
});

describe("R26-6: a prose line mentioning 'Date, amount' switches a text statement into CSV mode", () => {
  it("keeps reading the text statement's transactions", () => {
    const r = rows("Statement period 2026\n03/01/2026 A 10.00\n03/02/2026 B 20.00\nDate, amount and balance are shown below\n03/03/2026 C 30.00\n03/04/2026 D 30.00");
    expect(r).toHaveLength(4); // fde6f98: 2 — C and D silently dropped (not even counted as skipped)
  });
});

describe("R26-7: a ' - ' separator in the description is read as a minus sign and overrides the running balance", () => {
  it("does not flag a correct running balance", () => {
    const a = analyzeText("Statement period 2026\nBeginning balance 100.00\n03/01/2026 AMAZON MKTPLACE - 10.00 110.00\n03/02/2026 Deposit 20.00 130.00\n03/03/2026 Deposit 30.00 160.00\nEnding balance 160.00");
    expect(a.transactions[0]!.amount).toBe(1000);
    expect(a.flags.map((f) => f.rule)).not.toContain("balance"); // fde6f98: false 'balance' and 'statement' flags
  });
});

describe("R26-8: a date + balance-only line (daily ending balance section) is counted as a transaction", () => {
  it("is not added to money in", () => {
    const a = analyzeText("Statement period 2026\nBeginning balance 100.00\n03/01/2026 A 10.00 110.00\n03/03/2026 B 20.00 130.00\nEnding balance 130.00\nDaily ending balance\n03/01 110.00\n03/03 130.00\n03/04 130.00");
    expect(a.totals.moneyIn).toBe(3000); // fde6f98: 40,000 cents (each daily balance read as a deposit)
  });
});

describe("R26-9: documentFinancials serves the text of an item that is no longer 'clean'", () => {
  let t: TestDatabase;
  let db: HuisDb;
  let vault: EvidenceVault;
  let vaultDir: string;
  let processor: EvidenceProcessor;
  const scanner: MalwareScanner = { name: "test", async scan(stream) { for await (const _ of stream) { /* drain */ } return { status: "clean", detail: "ok" }; } };

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
    vaultDir = await mkdtemp(path.join(os.tmpdir(), "huis-r26-vault-"));
    vault = new EvidenceVault(new LocalObjectStore(vaultDir), new MasterKeyProvider(randomBytes(32).toString("base64")));
    processor = new EvidenceProcessor(t.worker, vault, scanner);
  });
  afterAll(async () => {
    await t?.drop();
    if (vaultDir) await rm(vaultDir, { recursive: true, force: true });
  });

  async function upload(ctx: RequestContext, matterId: string, filename: string, text: string) {
    const content = Buffer.from(text);
    const session = await db.withFirm(ctx, (s) => startUpload(s, { matterId, filename, totalSize: content.length }));
    for (let i = 0; i < session.chunkCount; i++) {
      await storeChunk(vault, session, i, content.subarray(i * session.chunkSize, (i + 1) * session.chunkSize));
      await db.withFirm(ctx, (s) => markChunkReceived(s, session.id, i));
    }
    const fresh = await db.withFirm(ctx, (s) => getUploadSession(s, session.id));
    const id = newEvidenceId();
    const stored = await assembleOriginal(vault, fresh, id);
    return db.withFirm(ctx, (s) => recordEvidence(s, fresh, id, stored));
  }

  it("a quarantined item (e.g. a container later found to hold a threat) is not analysed or 'viewed'", async () => {
    const f = await newFirm(db);
    const x = await db.withFirm(f.owner, async (s) => {
      const client = await createClient(s, { kind: "person", displayName: "Pat Smith" });
      const para = await inviteUser(s, { email: `p@${f.slug}.example`, fullName: "Pat Para", role: "paralegal", locationId: f.locationId });
      const matter = await createMatter(s, { title: "Smith v. Smith", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
      return { para, matter };
    });
    const para: RequestContext = { firmId: f.firmId, userId: x.para.id };
    const item = await upload(f.owner, x.matter.id, "march.txt",
      "Statement period March 2026\n03/02/2026 Deposit 1,850.00\n03/05/2026 Rent 1,200.00\n03/06/2026 ATM 200.00\n");
    await processor.drain();
    // What scan_complete does to an ancestor when something inside it turns out infected (0006, F-quarantine).
    // (Set directly, with Huis's own rules off for this one statement, as in test/analysis.test.ts.)
    await t.admin.query(`SET session_replication_role = replica; UPDATE huis.evidence_items SET status = 'infected', scan_detail = 'Quarantined' WHERE id = '${item.id}'; SET session_replication_role = origin;`);
    // The summary already skips it (status = 'clean'), as do the viewer and compare pages ...
    expect((await db.withFirm(para, (s) => matterFinancials(s, x.matter.id))).documents).toHaveLength(0);
    // ... but the per-document analysis reads and shows its text, and records a custody 'viewed' event.
    const d = await db.withFirm(para, (s) => documentFinancials(s, item.id)).catch((e: unknown) => e);
    const shown = !(d instanceof Error) && (d as { transactions: unknown[] }).transactions.length > 0;
    expect(shown).toBe(false);
  });
});
