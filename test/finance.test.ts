import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { NotFoundError, PermissionDeniedError } from "../src/errors";
import { analyzeText, MAX_TRANSACTIONS } from "../src/finance/analyze";
import { createClient } from "../src/services/clients";
import { assembleOriginal, getUploadSession, markChunkReceived, newEvidenceId, recordEvidence, startUpload, storeChunk } from "../src/services/evidence";
import { documentFinancials, matterFinancials } from "../src/services/finance";
import { addMatterMember, createMatter } from "../src/services/matters";
import { inviteUser } from "../src/services/users";
import { MasterKeyProvider } from "../src/storage/encryption";
import type { MalwareScanner } from "../src/storage/scanner";
import { EvidenceVault, LocalObjectStore } from "../src/storage/store";
import { EvidenceProcessor } from "../src/worker/processor";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

const STATEMENT = `First Example Bank — Statement period March 1 - March 31, 2026
Beginning Balance                               $2,500.00
03/02 Payroll deposit ACME CORP           1,850.00     4,350.00
03/05 Rent payment                        1,200.00     3,150.00
03/06 ATM withdrawal Main St                200.00     2,950.00
03/09 Zelle to J. Doe                     5,000.00    -2,050.00
03/10 Coffee shop                            4.50    -2,054.50
03/10 Coffee shop                            4.50    -2,059.00
03/20 Grocery store                          85.25    -2,144.25
Ending Balance                                  -$2,144.25
`;

describe("reading transactions (fixed rules)", () => {
  it("reads a bank statement: dates (year from the period), descriptions, signs from the running balance, totals", () => {
    const a = analyzeText(STATEMENT);
    expect(a.financial).toBe(true);
    expect(a.transactions.map((t) => [t.date, t.description, t.amount, t.balance, t.line])).toEqual([
      ["2026-03-02", "Payroll deposit ACME CORP", 185000, 435000, 3],
      ["2026-03-05", "Rent payment", -120000, 315000, 4],
      ["2026-03-06", "ATM withdrawal Main St", -20000, 295000, 5],
      ["2026-03-09", "Zelle to J. Doe", -500000, -205000, 6],
      ["2026-03-10", "Coffee shop", -450, -205450, 7],
      ["2026-03-10", "Coffee shop", -450, -205900, 8],
      ["2026-03-20", "Grocery store", -8525, -214425, 9],
    ]);
    expect(a.totals).toMatchObject({ moneyIn: 185000, moneyOut: -649425, net: -464425, count: 7, first: "2026-03-02", last: "2026-03-20" });
    expect(a.opening?.amount).toBe(250000);
    expect(a.closing?.amount).toBe(-214425);
    // Exact positions: the line can be cited as written.
    const t = a.transactions[3]!;
    expect(STATEMENT.slice(t.start, t.end)).toBe("03/09 Zelle to J. Doe                     5,000.00    -2,050.00");
  });

  it("flags by named rules, each saying why with the numbers", () => {
    const a = analyzeText(STATEMENT);
    const rules = a.flags.map((f) => f.rule);
    expect(rules).toEqual(expect.arrayContaining(["duplicate", "round", "large", "cash", "transfer"]));
    expect(rules).not.toContain("balance"); // the balances follow
    expect(rules).not.toContain("statement"); // opening + transactions = closing
    expect(a.flags.find((f) => f.rule === "duplicate")!.why).toMatch(/lines 7 and 8/);
    // A broken running balance and a closing balance that doesn't add up.
    const broken = analyzeText(STATEMENT.replace("2,950.00", "2,900.00").replace("-$2,144.25", "-$2,000.00"));
    expect(broken.flags.find((f) => f.rule === "balance")!.why).toMatch(/but the document shows \$2,900\.00/);
    expect(broken.flags.some((f) => f.rule === "statement")).toBe(true);
  });

  it("reads spreadsheet exports (debit and credit columns, quoted fields) and flags gaps in dates", () => {
    const a = analyzeText(`Date,Description,Debit,Credit,Balance
2026-01-02,"Opening deposit, cash",,"1,000.00",1000.00
2026-01-03,Wire to Example Ltd,900.00,,100.00
2026-03-15,Paycheck,,500.00,600.00
`);
    expect(a.transactions.map((t) => [t.description, t.amount])).toEqual([["Opening deposit, cash", 100000], ["Wire to Example Ltd", -90000], ["Paycheck", 50000]]);
    expect(a.flags.some((f) => f.rule === "gap" && /71 days/.test(f.why))).toBe(true);
  });

  it("doesn't treat ordinary text as financial, and refuses impossible dates", () => {
    expect(analyzeText("We met on 03/15/2026 and paid 12.00 for parking.\nShe called 03/16/2026 about the 40.00 fee.").financial).toBe(false);
    const a = analyzeText("02/30/2026 Bad day 10.00\n13/01/2026 Bad month 10.00\n02/28/2026 Good 10.00");
    expect(a.transactions.map((t) => t.date)).toEqual(["2026-02-28"]);
    expect(analyzeText("03/02 Deposit 10.00\n03/03 Deposit 10.00\n03/04 Deposit 10.00").skipped).toBe(3); // no year anywhere
  });

  it("stays within its limits on hostile input", () => {
    const many = Array.from({ length: MAX_TRANSACTIONS + 50 }, (_, i) => `01/0${(i % 9) + 1}/2026 Item ${i} 1.00`).join("\n");
    const a = analyzeText(many);
    expect(a.transactions.length).toBe(MAX_TRANSACTIONS);
    expect(a.truncated).toBe(true);
    const t0 = Date.now();
    analyzeText(`01/01/2026 ${"9".repeat(200_000)}.00\n`.repeat(3));
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe("financial analysis in a Matter", () => {
  let t: TestDatabase;
  let db: HuisDb;
  let vault: EvidenceVault;
  let vaultDir: string;
  let processor: EvidenceProcessor;
  const scanner: MalwareScanner = { name: "test", async scan(stream) { for await (const _ of stream) { /* drain */ } return { status: "clean", detail: "ok" }; } };

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
    vaultDir = await mkdtemp(path.join(os.tmpdir(), "huis-fin-vault-"));
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

  async function setup() {
    const f = await newFirm(db);
    const x = await db.withFirm(f.owner, async (s) => {
      const client = await createClient(s, { kind: "person", displayName: "Pat Smith" });
      const para = await inviteUser(s, { email: `p@${f.slug}.example`, fullName: "Pat Para", role: "paralegal", locationId: f.locationId });
      const portal = await inviteUser(s, { email: `c@${f.slug}.example`, fullName: "Casey Client", role: "client", locationId: f.locationId });
      const matter = await createMatter(s, { title: "Smith v. Smith", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
      const walled = await createMatter(s, { title: "Walled", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT", restricted: true });
      return { para, portal, matter, walled };
    });
    await db.withFirm(f.owner, (s) => addMatterMember(s, { matterId: x.matter.id, userId: x.portal.id, access: "view", acknowledgePrivilegeWaiverRisk: true }));
    const ctx = (id: string): RequestContext => ({ firmId: f.firmId, userId: id });
    return { ...f, ...x, paraCtx: ctx(x.para.id), portalCtx: ctx(x.portal.id) };
  }

  it("finds the Matter's financial documents, totals them, and spots the same transaction in two statements", async () => {
    const x = await setup();
    const a = await upload(x.owner, x.matter.id, "march.txt", STATEMENT);
    const b = await upload(x.owner, x.matter.id, "march-copy.txt", STATEMENT);
    await upload(x.owner, x.matter.id, "letter.txt", "Dear Pat, the hearing is on 04/02/2026. Fee 50.00.");
    await upload(x.owner, x.walled.id, "walled.txt", STATEMENT);
    await processor.drain();
    const f = await db.withFirm(x.paraCtx, (s) => matterFinancials(s, x.matter.id));
    expect(f.documents.map((d) => d.evidenceId).sort()).toEqual([a.id, b.id].sort());
    expect(f.totals.count).toBe(14);
    expect(f.overlaps).toHaveLength(6); // the two identical coffee purchases are one shared entry
    expect(f.overlaps[0]!.documents).toHaveLength(2);
    const d = await db.withFirm(x.paraCtx, (s) => documentFinancials(s, a.id));
    expect(d.totals.count).toBe(7);
    // Opening a document's analysis is opening the document (chain of custody), and the summary is audited.
    const custody = (await t.admin.query("SELECT count(*)::int AS n FROM huis.evidence_custody_events WHERE evidence_id = $1 AND event = 'viewed'", [a.id])).rows[0].n;
    expect(custody).toBeGreaterThanOrEqual(1);
    const audit = (await t.admin.query("SELECT metadata FROM huis.audit_events WHERE firm_id = $1 AND action = 'matter.financial_viewed'", [x.firmId])).rows;
    expect(audit[0].metadata).toEqual({ documents: 2 });
  });

  it("is firm staff only: clients, walls and other firms get nothing", async () => {
    const x = await setup();
    const a = await upload(x.owner, x.matter.id, "march.txt", STATEMENT);
    const w = await upload(x.owner, x.walled.id, "walled.txt", STATEMENT);
    await processor.drain();
    await expect(db.withFirm(x.portalCtx, (s) => matterFinancials(s, x.matter.id))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(db.withFirm(x.portalCtx, (s) => documentFinancials(s, a.id))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(db.withFirm(x.paraCtx, (s) => matterFinancials(s, x.walled.id))).rejects.toBeInstanceOf(NotFoundError);
    await expect(db.withFirm(x.paraCtx, (s) => documentFinancials(s, w.id))).rejects.toBeInstanceOf(NotFoundError);
    const other = await newFirm(db);
    await expect(db.withFirm(other.owner, (s) => documentFinancials(s, a.id))).rejects.toBeInstanceOf(NotFoundError);
  });
});
