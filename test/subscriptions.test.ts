import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { PermissionDeniedError, UserFacingError } from "../src/errors";
import { askMatter } from "../src/services/brain";
import { createClient } from "../src/services/clients";
import { assembleOriginal, getUploadSession, markChunkReceived, newEvidenceId, recordEvidence, startUpload, storeChunk } from "../src/services/evidence";
import { prepareMatterExport } from "../src/services/matterExport";
import { createMatter, listMatters } from "../src/services/matters";
import { getSubscription, pausedReason } from "../src/services/subscription";
import { disableUser, inviteUser } from "../src/services/users";
import { MasterKeyProvider } from "../src/storage/encryption";
import { EvidenceVault, LocalObjectStore } from "../src/storage/store";
import { parseArgs, setSubscription } from "../scripts/operator/set-subscription";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

let t: TestDatabase;
let db: HuisDb;
let vault: EvidenceVault;
let vaultDir: string;

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
  // The trial's limits, small enough to reach in a test (helpers.ts lifts them for every other test).
  await t.admin.query("UPDATE huis.plans SET seat_limit = 3, storage_limit_bytes = 1000, ai_questions_per_month = 2 WHERE code = 'trial'");
  vaultDir = await mkdtemp(path.join(os.tmpdir(), "huis-sub-vault-"));
  vault = new EvidenceVault(new LocalObjectStore(vaultDir), new MasterKeyProvider(randomBytes(32).toString("base64")));
});
afterAll(async () => {
  await t?.drop();
  if (vaultDir) await rm(vaultDir, { recursive: true, force: true });
});

const DAY = 86_400_000;
const operator = (slug: string, change: Parameters<typeof setSubscription>[2]) =>
  t.admin.connect().then(async (c) => { try { return await setSubscription(c, slug, change); } finally { c.release(); } });

async function upload(ctx: RequestContext, matterId: string, bytes: number) {
  const content = Buffer.alloc(bytes, "a");
  const session = await db.withFirm(ctx, (s) => startUpload(s, { matterId, filename: `f${bytes}.txt`, totalSize: content.length }));
  for (let i = 0; i < session.chunkCount; i++) {
    await storeChunk(vault, session, i, content.subarray(i * session.chunkSize, (i + 1) * session.chunkSize));
    await db.withFirm(ctx, (s) => markChunkReceived(s, session.id, i));
  }
  const fresh = await db.withFirm(ctx, (s) => getUploadSession(s, session.id));
  const id = newEvidenceId();
  const stored = await assembleOriginal(vault, fresh, id);
  return { fresh, id, stored, record: () => db.withFirm(ctx, (s) => recordEvidence(s, fresh, id, stored)) };
}

async function setup() {
  const f = await newFirm(db);
  const x = await db.withFirm(f.owner, async (s) => {
    const client = await createClient(s, { kind: "person", displayName: "Pat Smith" });
    const para = await inviteUser(s, { email: `p@${f.slug}.example`, fullName: "Pat Para", role: "paralegal", locationId: f.locationId });
    const billing = await inviteUser(s, { email: `b@${f.slug}.example`, fullName: "Bo Billing", role: "billing_admin", locationId: f.locationId });
    const matter = await createMatter(s, { title: "Smith v. Acme", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
    return { client, para, billing, matter };
  });
  const ctx = (id: string): RequestContext => ({ firmId: f.firmId, userId: id });
  return { ...f, ...x, paraCtx: ctx(x.para.id), billingCtx: ctx(x.billing.id) };
}

describe("seats", () => {
  it("attorneys and staff take a seat; clients, co-counsel and experts don't; a freed seat can be reused", async () => {
    const x = await setup(); // owner + paralegal + billing admin = 3 of 3 trial seats
    const invite = (role: string, n: string) => db.withFirm(x.owner, (s) =>
      inviteUser(s, { email: `${n}@${x.slug}.example`, fullName: `Person ${n}`, role: role as never, locationId: x.locationId }));
    await expect(invite("attorney", "a4")).rejects.toThrow(/free trial includes 3 seats/);
    await expect(invite("attorney", "a4")).rejects.toBeInstanceOf(UserFacingError);
    // Outside people never take a seat.
    await invite("client", "c1");
    await invite("co_counsel", "cc1");
    await invite("expert_witness", "e1");
    // Disabling someone frees their seat.
    await db.withFirm(x.owner, (s) => disableUser(s, x.billing.id));
    await invite("attorney", "a5");
    // Turning a disabled license back on directly can't get round the limit (the database checks it).
    await expect(db.withFirm(x.owner, (s) => s.client.query(
      "UPDATE huis.licenses SET status = 'active', ends_at = NULL WHERE user_id = $1", [x.billing.id]))).rejects.toThrow(/free trial includes 3 seats/);
    const sub = await db.withFirm(x.owner, (s) => getSubscription(s));
    expect(sub.seats).toEqual({ used: 3, limit: 3 });
    expect(sub.externalUsers).toBe(3);
  });

  it("two people added at the same moment can't both take the last seat", async () => {
    const f = await newFirm(db);
    await db.withFirm(f.owner, (s) => inviteUser(s, { email: `p@${f.slug}.example`, fullName: "Pat Para", role: "paralegal", locationId: f.locationId }));
    const results = await Promise.allSettled([1, 2, 3].map((n) => db.withFirm(f.owner, (s) =>
      inviteUser(s, { email: `r${n}@${f.slug}.example`, fullName: `Racer ${n}`, role: "attorney", locationId: f.locationId }))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const used = (await t.admin.query("SELECT count(*)::int AS n FROM huis.licenses WHERE firm_id = $1 AND status = 'active' AND kind IN ('attorney','staff')", [f.firmId])).rows[0].n;
    expect(used).toBe(3);
  });

  it("a paid plan uses the seats Huis set for the firm", async () => {
    const x = await setup();
    await operator(x.slug, { plan: "professional", seats: 4, paidThrough: new Date(Date.now() + 30 * DAY), note: "Invoice 1" });
    const invite = (n: string) => db.withFirm(x.owner, (s) =>
      inviteUser(s, { email: `${n}@${x.slug}.example`, fullName: `Person ${n}`, role: "attorney", locationId: x.locationId }));
    await invite("a4");
    await expect(invite("a5")).rejects.toThrow(/All 4 of the firm's seats/);
    const sub = await db.withFirm(x.billingCtx, (s) => getSubscription(s));
    expect(sub.plan).toBe("professional");
    expect(sub.pricePerSeatCents).toBe(23700);
    expect(sub.monthlyEstimateCents).toBe(4 * 23700);
    expect(sub.storage.limitBytes).toBeNull();
  });
});

describe("trial limits", () => {
  it("storage: an upload that wouldn't fit is refused when it starts, and again when it's recorded", async () => {
    const x = await setup();
    await (await upload(x.owner, x.matter.id, 600)).record();
    await expect(db.withFirm(x.owner, (s) => startUpload(s, { matterId: x.matter.id, filename: "big.txt", totalSize: 500 })))
      .rejects.toThrow(/storage limit/);
    // Two uploads started together: whichever is recorded second doesn't fit.
    const a = await upload(x.owner, x.matter.id, 300);
    const b = await upload(x.owner, x.matter.id, 300);
    await a.record();
    await expect(b.record()).rejects.toThrow(/storage limit/);
    const sub = await db.withFirm(x.owner, (s) => getSubscription(s));
    expect(sub.storage).toEqual({ usedBytes: 900, limitBytes: 1000 });
  });

  it("AI questions: the month's allowance, counted across the firm", async () => {
    const x = await setup();
    await db.withFirm(x.owner, (s) => askMatter(s, x.matter.id, "What happened first?"));
    await db.withFirm(x.paraCtx, (s) => askMatter(s, x.matter.id, "Who is the witness?"));
    await expect(db.withFirm(x.owner, (s) => askMatter(s, x.matter.id, "One more?"))).rejects.toThrow(/this month's 2 AI questions/);
    expect((await db.withFirm(x.owner, (s) => getSubscription(s))).aiQuestions).toEqual({ usedThisMonth: 2, limitPerMonth: 2 });
  });
});

describe("when the trial ends or payment is late", () => {
  it("new work is paused for everyone; reading and export still work; nothing is deleted", async () => {
    const x = await setup();
    await (await upload(x.owner, x.matter.id, 100)).record();
    expect(await db.withFirm(x.owner, (s) => pausedReason(s))).toBeNull();
    await operator(x.slug, { trialEnds: new Date(Date.now() - DAY), note: "trial over" });

    const ended = /free trial has ended/;
    expect(await db.withFirm(x.paraCtx, (s) => pausedReason(s))).toMatch(ended);
    await expect(db.withFirm(x.owner, (s) => createMatter(s, { title: "New", clientId: x.client.id, leadAttorneyId: x.ownerUserId, jurisdictionState: "UT" })))
      .rejects.toThrow(ended);
    await expect(db.withFirm(x.owner, (s) => startUpload(s, { matterId: x.matter.id, filename: "n.txt", totalSize: 5 }))).rejects.toThrow(ended);
    await expect(db.withFirm(x.paraCtx, (s) => askMatter(s, x.matter.id, "Anything new?"))).rejects.toThrow(ended);
    await expect(db.withFirm(x.owner, (s) => inviteUser(s, { email: `z@${x.slug}.example`, fullName: "Zed", role: "client", locationId: x.locationId })))
      .resolves.toBeTruthy(); // an outside person takes no seat, and the license check only guards seats
    // Reading and export keep working.
    expect((await db.withFirm(x.paraCtx, (s) => listMatters(s))).map((m) => m.id)).toContain(x.matter.id);
    const plan = await db.withFirm(x.owner, (s) => prepareMatterExport(s, x.matter.id, true));
    expect(plan).toBeTruthy();
    const kept = (await t.admin.query("SELECT count(*)::int AS n FROM huis.evidence_items WHERE matter_id = $1", [x.matter.id])).rows[0].n;
    expect(kept).toBe(1);

    // Subscribing lifts the pause at once.
    await operator(x.slug, { plan: "professional", seats: 5, paidThrough: new Date(Date.now() + 30 * DAY), note: "subscribed" });
    expect(await db.withFirm(x.owner, (s) => pausedReason(s))).toBeNull();
    await db.withFirm(x.owner, (s) => createMatter(s, { title: "New", clientId: x.client.id, leadAttorneyId: x.ownerUserId, jurisdictionState: "UT" }));
  });

  it("a late payment has 7 days' grace; a suspended account is paused", async () => {
    const x = await setup();
    await operator(x.slug, { plan: "professional", seats: 5, paidThrough: new Date(Date.now() - 3 * DAY) });
    expect(await db.withFirm(x.owner, (s) => pausedReason(s))).toBeNull();
    await operator(x.slug, { paidThrough: new Date(Date.now() - 8 * DAY) });
    expect(await db.withFirm(x.owner, (s) => pausedReason(s))).toMatch(/payment is overdue/);
    await expect(db.withFirm(x.owner, (s) => inviteUser(s, { email: `a@${x.slug}.example`, fullName: "Al", role: "attorney", locationId: x.locationId })))
      .rejects.toThrow(/payment is overdue/);
    await operator(x.slug, { paidThrough: null, status: "suspended" });
    expect(await t.admin.query("SELECT huis.firm_write_block($1) AS r", [x.firmId]).then((r) => r.rows[0].r)).toMatch(/suspended/);
  });
});

describe("who can see and change the subscription", () => {
  it("owners, admins and billing admins see it; other staff and clients don't", async () => {
    const x = await setup();
    expect((await db.withFirm(x.billingCtx, (s) => getSubscription(s))).plan).toBe("trial");
    await expect(db.withFirm(x.paraCtx, (s) => getSubscription(s))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(db.withFirm(x.paraCtx, (s) => s.client.query("SELECT * FROM huis.my_firm_subscription()"))).rejects.toThrow();
  });

  it("only Huis changes plans, seats and dates (recorded in the audit log); the app can't, nor look at other firms", async () => {
    const x = await setup();
    const other = await newFirm(db);
    for (const sql of [
      "UPDATE huis.firms SET plan = 'enterprise'",
      "UPDATE huis.firms SET seat_limit = 999",
      "UPDATE huis.firms SET paid_through = now() + interval '10 years'",
      "UPDATE huis.firms SET trial_ends_at = now() + interval '10 years'",
    ]) {
      await expect(db.withFirm(x.owner, (s) => s.client.query(sql))).rejects.toThrow(/managed by Huis/);
    }
    await expect(db.withFirm(x.owner, (s) => s.client.query("SELECT huis.operator_set_subscription($1, 'enterprise', NULL, NULL, NULL, 'active', NULL)", [x.firmId])))
      .rejects.toThrow(/permission/i);
    for (const fn of ["firm_write_block($1)", "firm_storage_used($1)", "firm_seats_used($1)", "firm_ai_questions_this_month($1)", "firm_limits($1)"]) {
      await expect(db.withFirm(x.owner, (s) => s.client.query(`SELECT huis.${fn}`, [other.firmId]))).rejects.toThrow(/permission/i);
    }
    await operator(x.slug, { plan: "enterprise", seats: 50, note: "Signed agreement" });
    const audit = (await t.admin.query("SELECT actor_user_id, metadata FROM huis.audit_events WHERE firm_id = $1 AND action = 'subscription.changed'", [x.firmId])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_user_id).toBeNull();
    expect(audit[0].metadata.to).toMatchObject({ plan: "enterprise", seats: 50 });
    expect(audit[0].metadata.note).toBe("Signed agreement");
  });

  it("the operator command checks what it's given", () => {
    expect(parseArgs(["--firm", "acme", "--plan", "professional", "--seats", "5", "--paid-through", "2026-12-31"]).change)
      .toMatchObject({ plan: "professional", seats: 5 });
    expect(parseArgs(["--firm", "acme", "--seats", "none"]).change.seats).toBeNull();
    expect(() => parseArgs(["--plan", "trial"])).toThrow(/--firm/);
    expect(() => parseArgs(["--firm", "a", "--plan", "gold"])).toThrow(/--plan/);
    expect(() => parseArgs(["--firm", "a", "--seats", "0"])).toThrow(/--seats/);
    expect(() => parseArgs(["--firm", "a", "--paid-through", "12/31/2026"])).toThrow(/YYYY-MM-DD/);
  });
});
