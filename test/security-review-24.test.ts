/**
 * Security review 24: Phase 10.1 (subscriptions, the 7-day trial, seats and usage limits).
 * Each test here FAILS on commit c513a80 and shows one finding.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { createClient } from "../src/services/clients";
import { assembleOriginal, getUploadSession, markChunkReceived, newEvidenceId, recordEvidence, startUpload, storeChunk } from "../src/services/evidence";
import { resolveIdentity } from "../src/services/firms";
import { createMatter, listMatterFolders } from "../src/services/matters";
import { getSubscription, pausedReason } from "../src/services/subscription";
import { inviteUser } from "../src/services/users";
import { listCopies, requestCopy } from "../src/services/workingCopies";
import { MasterKeyProvider } from "../src/storage/encryption";
import type { MalwareScanner } from "../src/storage/scanner";
import { EvidenceVault, LocalObjectStore } from "../src/storage/store";
import { EvidenceProcessor } from "../src/worker/processor";
import { parseArgs, setSubscription } from "../scripts/operator/set-subscription";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

let t: TestDatabase;
let db: HuisDb;
let vault: EvidenceVault;
let vaultDir: string;
let dir: string;
let processor: EvidenceProcessor;
const DAY = 86_400_000;

const scanner: MalwareScanner = {
  name: "TestScanner",
  async scan(content) { for await (const _ of content) { /* drain */ } return { status: "clean", detail: "No threats found" }; },
};

function makePdf(lines: string[]): Buffer {
  const content = ["BT", "/F1 14 Tf", "72 720 Td", "18 TL", ...lines.map((l) => `(${l}) Tj T*`), "ET"].join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
  vaultDir = await mkdtemp(path.join(os.tmpdir(), "huis-r24-vault-"));
  dir = await mkdtemp(path.join(os.tmpdir(), "huis-r24-files-"));
  vault = new EvidenceVault(new LocalObjectStore(vaultDir), new MasterKeyProvider(randomBytes(32).toString("base64")));
  processor = new EvidenceProcessor(t.worker, vault, scanner);
});
afterAll(async () => {
  // Put the trial's limits back the way helpers.ts leaves them.
  await t?.drop();
  for (const d of [vaultDir, dir]) if (d) await rm(d, { recursive: true, force: true });
});

const operator = (slug: string, change: Parameters<typeof setSubscription>[2]) =>
  t.admin.connect().then(async (c) => { try { return await setSubscription(c, slug, change); } finally { c.release(); } });

async function uploadBuffer(ctx: RequestContext, matterId: string, content: Buffer, filename: string) {
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
    const portal = await inviteUser(s, { email: `c@${f.slug}.example`, fullName: "Casey Client", role: "client", locationId: f.locationId });
    const matter = await createMatter(s, { title: "Smith v. Acme", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
    return { client, portal, matter };
  });
  return { ...f, ...x, portalCtx: { firmId: f.firmId, userId: x.portal.id } as RequestContext };
}

describe("R24-1: the trial's storage limit can be passed with an archive (contained files are never checked)", () => {
  it("a small, compressible ZIP unpacks to far more than the trial allows", async () => {
    const x = await setup();
    await t.admin.query("UPDATE huis.plans SET storage_limit_bytes = 20000 WHERE code = 'trial'");
    try {
      const zip = path.join(dir, "discovery.zip");
      execFileSync("python3", ["-c", `
import zipfile, sys
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
    for i in range(10):
        z.writestr(f"Production/DEF-{i:06d}.txt", ("Produced document %d about the termination decision. " % i) * 200)
`, zip]);
      const content = await readFile(zip);
      expect(content.length).toBeLessThan(20000); // the upload itself fits the trial
      await uploadBuffer(x.owner, x.matter.id, content, "discovery.zip");
      await processor.drain();
      const sub = await db.withFirm(x.owner, (s) => getSubscription(s));
      // The firm now holds more than its limit: the unpacked files were stored without any check.
      expect(sub.storage.usedBytes).toBeLessThanOrEqual(20000);
    } finally {
      await t.admin.query("UPDATE huis.plans SET storage_limit_bytes = NULL WHERE code = 'trial'");
    }
  }, 120_000);
});

describe("R24-2: clients and co-counsel are told the firm's billing standing", () => {
  it("a client-portal user learns that the firm's subscription payment is overdue", async () => {
    const x = await setup();
    await operator(x.slug, { plan: "professional", seats: 5, paidThrough: new Date(Date.now() - 8 * DAY) });
    // The firm's own staff are told (fine); an outside person should not be.
    expect(await db.withFirm(x.owner, (s) => pausedReason(s))).toMatch(/overdue/);
    expect(await db.withFirm(x.portalCtx, (s) => pausedReason(s))).toBeNull();
  });
});

describe("R24-3: a suspended firm can't sign in at all, though 'you can still open and export your work'", () => {
  it("the owner of a suspended firm can still sign in (to read and export)", async () => {
    const x = await setup();
    await operator(x.slug, { status: "suspended", note: "payment dispute" });
    const msg = (await t.admin.query("SELECT huis.firm_write_block($1) AS r", [x.firmId])).rows[0].r;
    expect(msg).toMatch(/You can still open and export your work/);
    const accounts = await resolveIdentity(db, "microsoft", `subject-${x.slug}`);
    expect(accounts.map((a) => a.firmId)).toContain(x.firmId);
  });
});

describe("R24-4: working copies (produced copies of evidence already received) stop when new work is paused", () => {
  it("a copy requested before the trial ended is never produced, and none can be produced while paused", async () => {
    const x = await setup();
    const pdf = makePdf(["Termination letter about the FMLA request."]);
    const item = await uploadBuffer(x.owner, x.matter.id, pdf, "letter.pdf");
    await processor.drain();
    const discovery = (await db.withFirm(x.owner, (s) => listMatterFolders(s, x.matter.id))).find((f) => f.name === "Discovery")!;
    await db.withFirm(x.owner, (s) => requestCopy(s, item.id, { redact: false, exhibitLabel: "1", folderId: discovery.id }));
    await operator(x.slug, { trialEnds: new Date(Date.now() - DAY), note: "trial over" });
    await processor.drain();
    const copy = (await db.withFirm(x.owner, (s) => listCopies(s, item.id)))[0]!;
    const why = (await t.admin.query("SELECT status, attempts, last_error FROM huis.copy_requests WHERE source_id = $1", [item.id])).rows[0];
    // The migration's own comment says "a working copy" of work already received is finished.
    expect(`${copy.status}: ${why.last_error} (attempts ${why.attempts})`).toBe("done: null (attempts 1)");
  }, 120_000);
});

describe("R24-5: my_firm_subscription fails open when the caller has no role", () => {
  it("refuses when app_role() is null (NULL NOT IN (...) is not true)", async () => {
    const x = await setup();
    await expect(db.withFirm(x.owner, async (s) => {
      // Any context where the user id no longer matches an active user of the firm (app_role() IS NULL).
      await s.client.query("SELECT set_config('app.user_id', $1, true)", [randomUUID()]);
      return (await s.client.query("SELECT plan, seats_used FROM huis.my_firm_subscription()")).rows[0];
    })).rejects.toThrow();
  });
});

describe("R24-6: the operator command accepts impossible dates and is an hour off in summer", () => {
  it("rejects 2026-02-31 instead of turning it into 3 March", () => {
    expect(() => parseArgs(["--firm", "a", "--paid-through", "2026-02-31"])).toThrow();
  });
  it("'the end of that day in Utah' in July is 23:59:59 MDT (05:59:59Z next day)", () => {
    expect(parseArgs(["--firm", "a", "--paid-through", "2026-07-15"]).change.paidThrough?.toISOString()).toBe("2026-07-16T05:59:59.000Z");
  });
});

describe("R24-6: the operator command's dates", () => {
  it("refuses impossible dates and uses Utah's summer time", async () => {
    const { parseDate } = await import("../scripts/operator/set-subscription");
    expect(() => parseDate("2026-02-31", "--paid-through")).toThrow(/not a real date/);
    expect(parseDate("2026-07-15", "--paid-through")!.toISOString()).toBe("2026-07-16T05:59:59.000Z");
    expect(parseDate("2026-12-31", "--paid-through")!.toISOString()).toBe("2027-01-01T06:59:59.000Z");
  });
});
