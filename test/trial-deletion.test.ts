import { mkdtemp, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deletionNotice, TrialDeletionWorker, type EmailMessage, type EmailSender } from "../src/billing/trialDeletion";
import type { RequestContext } from "../src/db/tenant";
import { addNote } from "../src/services/brain";
import { addExpense, addTime, createDraftInvoice, issueInvoice } from "../src/services/billing";
import { createClient } from "../src/services/clients";
import { addNode } from "../src/services/dna";
import { assembleOriginal, getUploadSession, markChunkReceived, newEvidenceId, recordEvidence, startUpload, storeChunk } from "../src/services/evidence";
import { signInAccounts, signUpFirm } from "../src/services/firms";
import { createMatter } from "../src/services/matters";
import { askInConversation, createConversation } from "../src/services/workspace";
import { MasterKeyProvider } from "../src/storage/encryption";
import { EvidenceVault, LocalObjectStore } from "../src/storage/store";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

/*
 * Phase 10 part 2b: an unpaid trial's data is deleted 30 days after the trial ends, only after three warning
 * emails (db/migrations/0041_trial_deletion.sql, src/billing/trialDeletion.ts).
 */
let t: TestDatabase;
let storageDir: string;
let vault: EvidenceVault;
beforeAll(async () => {
  t = await createTestDatabase();
  storageDir = await mkdtemp(path.join(os.tmpdir(), "huis-deletion-"));
  vault = new EvidenceVault(new LocalObjectStore(storageDir), new MasterKeyProvider(randomBytes(32).toString("base64")));
});
afterAll(async () => { await t?.drop(); });

class FakeEmail implements EmailSender {
  readonly name = "fake";
  sent: EmailMessage[] = [];
  fail = false;
  async send(m: EmailMessage) { if (this.fail) throw new Error("boom"); this.sent.push(m); }
}

async function asHuis(sql: string, params: unknown[] = []) {
  const c = await t.admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE huis_security");
    const r = await c.query(sql, params);
    await c.query("COMMIT");
    return r;
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
}

/** Moves a firm's trial end into the past (the trial ended `days` ago). */
const endTrial = (firmId: string, days: number) =>
  asHuis("UPDATE huis.firms SET trial_ends_at = now() - make_interval(hours => $2) WHERE id = $1", [firmId, Math.round(days * 24)]);

/** Marks this firm's warnings as sent `daysAgo` days ago (as if the worker had sent them on time). */
async function warnedAgo(firmId: string, d14: number, d7: number, d1: number) {
  await t.worker.query("SELECT huis.worker_queue_deletion_notices()");
  await t.admin.query(`UPDATE huis.firm_deletion_notices SET status = 'sent',
      sent_at = now() - make_interval(days => CASE days_before WHEN 14 THEN $2 WHEN 7 THEN $3 ELSE 0 END)
                      - CASE WHEN days_before = 1 THEN make_interval(hours => $4 * 24) ELSE interval '0' END
    WHERE firm_id = $1`, [firmId, d14, d7, d1]);
}

async function upload(who: RequestContext, matterId: string, filename: string, content: Buffer) {
  const session = await t.db.withFirm(who, (s) => startUpload(s, { matterId, filename, totalSize: content.length }));
  for (let i = 0; i < session.chunkCount; i++) {
    await storeChunk(vault, session, i, content.subarray(i * session.chunkSize, (i + 1) * session.chunkSize));
    await t.db.withFirm(who, (s) => markChunkReceived(s, session.id, i));
  }
  const fresh = await t.db.withFirm(who, (s) => getUploadSession(s, session.id));
  const id = newEvidenceId();
  const stored = await assembleOriginal(vault, fresh, id);
  return t.db.withFirm(who, (s) => recordEvidence(s, fresh, id, stored));
}

/** A trial firm with a bit of everything: client, Matter, evidence file, notes, AI questions, Case DNA, time,
 * expenses, an issued invoice (normally undeletable), audit events and a Google identity. */
async function richTrialFirm() {
  const slug = `del-${randomBytes(4).toString("hex")}`;
  const googleSub = String(10n ** 20n + BigInt(randomBytes(6).readUIntBE(0, 6)));
  await signInAccounts(t.db, "google", googleSub, "");
  const f = await signUpFirm(t.db, { firmName: `Trial ${slug}`, slug, stateCode: "UT", ownerEmail: `owner@${slug}.example`, ownerName: "Tess Trial", authProvider: "google", authSubject: googleSub });
  const owner = { firmId: f.firmId, userId: f.ownerUserId };
  const matterId = await t.db.withFirm(owner, async (s) => {
    const client = await createClient(s, { kind: "person", displayName: "Pat Client", email: "pat@example.com" });
    const m = await createMatter(s, { title: "Client v. Acme", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
    return m.id;
  });
  await upload(owner, matterId, "letter.txt", Buffer.from("Confidential: the termination letter."));
  const today = new Date().toISOString().slice(0, 10);
  await t.db.withFirm(owner, async (s) => {
    await addNote(s, matterId, { title: "Call", body: "Privileged: client explained the timeline." });
    const c = await createConversation(s, matterId, { title: "Notice", category: "strategy" });
    await askInConversation(s, c, "When did HR learn about the leave?");
    await addNode(s, matterId, { kind: "event", label: "Termination meeting", eventDate: "2026-04-23", categories: ["employment"] });
    await addTime(s, matterId, { workDate: today, duration: "1.0", description: "Review letter", rate: "250" });
    await addExpense(s, matterId, { incurredOn: today, description: "Filing fee", amount: "100" });
    const inv = await createDraftInvoice(s, matterId);
    await issueInvoice(s, inv, { issuedOn: today, dueOn: today });
  });
  return { ...f, owner, matterId, googleSub, slug };
}

async function firmRowCounts(firmId: string): Promise<Record<string, number>> {
  const tables = (await t.admin.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'huis' AND c.relkind IN ('r','p') AND c.relname NOT IN ('firm_deletions', 'platform_audit')
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'firm_id' AND NOT a.attisdropped)`)).rows;
  const out: Record<string, number> = {};
  for (const { relname } of tables) {
    const n = Number((await t.admin.query(`SELECT count(*) FROM huis.${relname} WHERE firm_id = $1`, [firmId])).rows[0].count);
    if (n > 0) out[relname] = n;
  }
  const f = Number((await t.admin.query("SELECT count(*) FROM huis.firms WHERE id = $1", [firmId])).rows[0].count);
  if (f > 0) out.firms = f;
  return out;
}

const worker = (email: EmailSender | null, enabled = true) => new TrialDeletionWorker(t.worker, vault, email, "https://app.huislaw.ai", enabled, 0);

describe("warnings", () => {
  it("go to the firm's owners 14, 7 and 1 days before, once each, and say nothing from any Matter", async () => {
    const f = await newFirm(t.db);
    await endTrial(f.firmId, 17); // deletion date in 13 days: only the 14-day warning is due
    const email = new FakeEmail();
    const w = worker(email);
    expect(await w.queueDue(true)).toBe(1);
    while (await w.sendOnce()) { /* send */ }
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]!.to).toMatch(/@/);
    expect(email.sent[0]!.subject).toContain("will be deleted on");
    expect(email.sent[0]!.text).toContain("/subscription");
    expect(await w.queueDue(true)).toBe(0); // not again
    // A new deletion date (the trial end moved) means a new set of warnings, from the 14-day one: half a day
    // left, so all three are due now, and the deletion itself then waits until the 14-day one is 13 days old.
    await endTrial(f.firmId, 29.5);
    expect(await w.queueDue(true)).toBe(3);
    while (await w.sendOnce()) { /* send */ }
  });

  it("wait for an email service; a firm that pays in the meantime gets none and is never deleted", async () => {
    const f = await newFirm(t.db);
    await endTrial(f.firmId, 25);
    const w = worker(null);
    await w.queueDue(true);
    while (await w.sendOnce()) { /* nothing sent */ }
    const st = await t.admin.query("SELECT status FROM huis.firm_deletion_notices WHERE firm_id = $1", [f.firmId]);
    expect(st.rows.every((r) => r.status === "waiting_for_provider")).toBe(true);
    await t.admin.query("SELECT huis.operator_set_subscription($1, 'professional', 5, NULL, now() + interval '30 days', 'active', 'paid')", [f.firmId]);
    const ownerEmail = (await t.admin.query("SELECT email FROM huis.users WHERE firm_id = $1 AND role = 'firm_owner'", [f.firmId])).rows[0].email;
    const email = new FakeEmail();
    const w2 = worker(email);
    await w2.queueDue(true);
    while (await w2.sendOnce()) { /* stale warnings dropped */ }
    expect(email.sent.filter((m) => m.to === ownerEmail)).toHaveLength(0);
    expect((await t.admin.query("SELECT count(*) FROM huis.firm_deletion_notices WHERE firm_id = $1", [f.firmId])).rows[0].count).toBe("0");
  });

  it("the email names the firm and the date in the firm's time zone, with no line breaks smuggled into the subject", () => {
    const m = deletionNotice({ email: "o@x.example", firm_name: "Smith\r\nBcc: evil@x.example Law", delete_after: new Date("2026-12-20T05:00:00Z"), time_zone: "America/Denver", days_before: 7 }, "https://app.huislaw.ai/");
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.subject).toContain("December 19, 2026");
    expect(m.text).toContain("https://app.huislaw.ai/subscription");
  });
});

describe("deleting", () => {
  it("never deletes without all three warnings sent in time, even long after the date", async () => {
    const f = await newFirm(t.db);
    await endTrial(f.firmId, 60);
    const w = worker(new FakeEmail());
    expect(await w.deleteOnce()).toBe(false);
    // Warnings queued late (all at once, just now): the deletion waits ~14 days, never early.
    await w.queueDue(true);
    while (await w.sendOnce()) { /* send all three now */ }
    expect(await w.deleteOnce()).toBe(false);
    expect(await firmRowCounts(f.firmId)).toHaveProperty("firms", 1);
    // The 14-day warning only 10 days ago: still not.
    await t.admin.query("UPDATE huis.firm_deletion_notices SET sent_at = now() - interval '10 days' WHERE firm_id = $1", [f.firmId]);
    expect(await w.deleteOnce()).toBe(false);
  });

  it("does nothing at all while turned off", async () => {
    const f = await newFirm(t.db);
    await endTrial(f.firmId, 31);
    await warnedAgo(f.firmId, 15, 8, 2);
    expect(await worker(new FakeEmail(), false).runOnce()).toBe(false);
    expect(await firmRowCounts(f.firmId)).toHaveProperty("firms", 1);
  });

  it("deletes every row and file of an unpaid trial, leaves a nameless tombstone, and touches no other firm", async () => {
    const other = await richTrialFirm(); // a second firm whose trial is still running
    const f = await richTrialFirm();
    const before = await firmRowCounts(f.firmId);
    expect(Object.keys(before).length).toBeGreaterThan(15);
    expect(before).toHaveProperty("invoices");
    expect(before).toHaveProperty("audit_events");
    expect((await readdir(path.join(storageDir, "firm", f.firmId))).length).toBeGreaterThan(0);
    const otherBefore = await firmRowCounts(other.firmId);

    await endTrial(f.firmId, 31);
    await warnedAgo(f.firmId, 15, 8, 2);
    const w = worker(new FakeEmail());
    expect(await w.deleteOnce()).toBe(true); // rows (of this or another due firm from the tests above)
    while (await w.deleteOnce()) { /* the rest, then the files */ }

    expect(await firmRowCounts(f.firmId)).toEqual({});
    await expect(stat(path.join(storageDir, "firm", f.firmId))).rejects.toThrow();
    expect((await t.admin.query("SELECT count(*) FROM huis.identity_orgs WHERE subject = $1", [f.googleSub])).rows[0].count).toBe("0");
    const tomb = (await t.admin.query("SELECT * FROM huis.firm_deletions WHERE firm_id = $1", [f.firmId])).rows[0];
    expect(tomb.files_deleted_at).not.toBeNull();
    expect(Object.keys(tomb.warned).sort()).toEqual(["1", "14", "7"]);
    expect(JSON.stringify(tomb)).not.toContain(f.slug);

    expect(await firmRowCounts(other.firmId)).toEqual(otherBefore);
    expect((await readdir(path.join(storageDir, "firm", other.firmId))).length).toBeGreaterThan(0);
  });

  it("is checked again at the moment of deletion: a firm that just paid, or that Huis suspended, is kept", async () => {
    const paid = await newFirm(t.db);
    await endTrial(paid.firmId, 31);
    await warnedAgo(paid.firmId, 15, 8, 2);
    await t.admin.query("SELECT huis.operator_set_subscription($1, 'professional', 5, NULL, now() + interval '30 days', 'active', 'paid')", [paid.firmId]);
    expect((await t.worker.query("SELECT huis.worker_delete_firm($1) AS p", [paid.firmId])).rows[0].p).toBeNull();
    expect(await firmRowCounts(paid.firmId)).toHaveProperty("firms", 1);

    const held = await newFirm(t.db);
    await endTrial(held.firmId, 31);
    await warnedAgo(held.firmId, 15, 8, 2);
    await asHuis("UPDATE huis.firms SET status = 'suspended' WHERE id = $1", [held.firmId]);
    expect((await t.worker.query("SELECT huis.worker_delete_firm($1) AS p", [held.firmId])).rows[0].p).toBeNull();
  });

  it("a firm that ever paid is never deleted, even back on the trial", async () => {
    const f = await newFirm(t.db);
    await t.admin.query("SELECT huis.operator_set_subscription($1, 'professional', 5, NULL, now() + interval '30 days', 'active', 'paid')", [f.firmId]);
    await t.admin.query("SELECT huis.operator_set_subscription($1, 'trial', NULL, now() - interval '40 days', NULL, 'active', 'back')", [f.firmId]);
    await t.worker.query("SELECT huis.worker_queue_deletion_notices()");
    expect((await t.admin.query("SELECT count(*) FROM huis.firm_deletion_notices WHERE firm_id = $1", [f.firmId])).rows[0].count).toBe("0");
    expect((await t.worker.query("SELECT huis.worker_delete_firm($1) AS p", [f.firmId])).rows[0].p).toBeNull();
  });
});

describe("who can do it", () => {
  it("only the worker; the app can't call it, can't fake a deletion in progress, and issued invoices stay undeletable", async () => {
    const f = await richTrialFirm();
    await expect(t.db.withFirm(f.owner, (s) => s.client.query("SELECT huis.worker_delete_firm($1)", [f.firmId]))).rejects.toThrow();
    await expect(t.db.withFirm(f.owner, (s) => s.client.query("SELECT huis.worker_queue_deletion_notices()"))).rejects.toThrow();
    await expect(t.db.withFirm(f.owner, (s) => s.client.query("INSERT INTO huis.firm_deletion_in_progress VALUES ($1, txid_current())", [f.firmId]))).rejects.toThrow();
    await t.db.withFirm(f.owner, (s) => s.client.query("DELETE FROM huis.invoices WHERE status <> 'draft'")).catch(() => undefined);
    expect((await t.admin.query("SELECT count(*) FROM huis.invoices WHERE firm_id = $1 AND status <> 'draft'", [f.firmId])).rows[0].count).toBe("1");
    // Even as huis_security, without the worker's in-progress row for this transaction, the guards hold.
    await expect(asHuis("DELETE FROM huis.audit_events WHERE firm_id = $1", [f.firmId])).rejects.toThrow(/append-only/);
    await expect(asHuis("DELETE FROM huis.invoices WHERE firm_id = $1 AND status <> 'draft'", [f.firmId])).rejects.toThrow(/issued invoice/);
    await expect(t.db.withFirm(f.owner, (s) => s.client.query("SELECT * FROM huis.firm_deletions"))).rejects.toThrow();
    // The billing and admin-portal logins can't either.
    await expect(t.admin.query("SET ROLE huis_platform; SELECT huis.worker_delete_firm($1)", [randomUUID()]).finally(() => t.admin.query("RESET ROLE"))).rejects.toThrow();
  });
});
