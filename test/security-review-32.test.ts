import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TrialDeletionWorker, type EmailMessage, type EmailSender, type FirmFileDeleter } from "../src/billing/trialDeletion";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

/*
 * Independent security review 32: deleting an unpaid trial's data (Phase 10 part 2b,
 * db/migrations/0041_trial_deletion.sql, src/billing/trialDeletion.ts).
 * Each test fails today and passes once its problem is fixed.
 */

let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });

class FakeEmail implements EmailSender {
  readonly name = "fake";
  sent: EmailMessage[] = [];
  async send(m: EmailMessage) { this.sent.push(m); }
}

class NoFiles implements FirmFileDeleter {
  deleted: string[] = [];
  async deleteFirmPrefix(prefix: string) { this.deleted.push(prefix); }
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

const endTrial = (firmId: string, days: number) =>
  asHuis("UPDATE huis.firms SET trial_ends_at = now() - make_interval(hours => $2) WHERE id = $1", [firmId, Math.round(days * 24)]);

/** Makes the firm's deletion round due now, with its warnings sent on time (14 days and 1 day before). */
async function roundDue(firmId: string) {
  await t.admin.query(`INSERT INTO huis.firm_deletion_rounds (firm_id, base_after, delete_on, started_at)
      VALUES ($1, coalesce(huis.firm_trial_delete_base($1), (SELECT trial_ends_at + interval '720 hours' FROM huis.firms WHERE id = $1)), now() - interval '1 hour', now() - interval '15 days')
      ON CONFLICT (firm_id) DO UPDATE SET base_after = EXCLUDED.base_after, delete_on = EXCLUDED.delete_on, started_at = EXCLUDED.started_at`, [firmId]);
  await t.admin.query("DELETE FROM huis.firm_deletion_notices WHERE firm_id = $1", [firmId]);
  await t.admin.query(`INSERT INTO huis.firm_deletion_notices (firm_id, user_id, days_before, for_delete_after, status, sent_at)
      SELECT $1, u.id, k.d, r.delete_on, 'sent', r.delete_on - make_interval(days => k.d)
        FROM huis.firm_deletion_rounds r JOIN huis.users u ON u.firm_id = r.firm_id AND u.role = 'firm_owner'
        CROSS JOIN (VALUES (14), (7), (1)) k(d) WHERE r.firm_id = $1`, [firmId]);
}

const firmExists = async (firmId: string) =>
  Number((await t.admin.query("SELECT count(*) FROM huis.firms WHERE id = $1", [firmId])).rows[0].count) === 1;

const worker = (email: EmailSender = new FakeEmail(), files: FirmFileDeleter = new NoFiles()) =>
  new TrialDeletionWorker(t.worker, files, email, "https://app.huislaw.ai", true, 0);

describe("R32-1: a trial firm with a Stripe subscription that can still charge is deleted, and Stripe keeps billing", () => {
  it.each(["trialing", "past_due", "unpaid", "paused"])("a firm whose subscription is '%s' is held, not deleted", async (status) => {
    const f = await newFirm(t.db);
    const cus = `cus_R321${randomBytes(4).toString("hex")}`;
    const sub = `sub_R321${randomBytes(4).toString("hex")}`;
    await asHuis("UPDATE huis.firms SET stripe_customer_id = $2 WHERE id = $1", [f.firmId, cus]);
    // Subscribed during the trial (Stripe 'trialing'); then, e.g., the first charge failed and Stripe is still
    // retrying (past_due, for up to weeks per the dunning settings), or it went unpaid/paused with the invoice
    // still open (paying it reactivates the subscription), or Huis staff extended the trial in Stripe as the
    // admin portal tells them to (R30-1), which never moves firms.trial_ends_at.
    await t.billing.query("SELECT huis.billing_apply_subscription($1, $2, $3, 'trialing', 'month', now() + interval '7 days', true)", [f.firmId, cus, sub]);
    if (status !== "trialing") {
      await t.billing.query("SELECT huis.billing_apply_subscription($1, $2, $3, $4, 'month', now() + interval '7 days', true)", [f.firmId, cus, sub, status]);
    }
    await endTrial(f.firmId, 31);
    await roundDue(f.firmId);

    // Today the firm (and every Matter, document and email in it) is deleted while Stripe can still take the
    // first payment: if a retry succeeds tomorrow, the customer is charged and billing_apply_subscription answers
    // 'ignored: firm not found'. The admin portal already refuses a plan change in this state (R30-2).
    expect((await t.worker.query("SELECT huis.worker_delete_firm($1) AS p", [f.firmId])).rows[0].p).toBeNull();
    expect(await firmExists(f.firmId)).toBe(true);
  });
});

describe("R32-2: a firm Huis suspended and then restored is deleted at once, with no warning after it was restored", () => {
  it("restoring a suspended firm after its date doesn't delete it on the worker's next pass", async () => {
    const f = await newFirm(t.db);
    // Deletion date 12 hours away; all three warnings went out on time.
    await endTrial(f.firmId, 29.5);
    await t.worker.query("SELECT huis.worker_queue_deletion_notices()");
    await t.admin.query(`UPDATE huis.firm_deletion_notices SET status = 'sent',
        sent_at = now() - make_interval(hours => (days_before * 24) - 12) WHERE firm_id = $1`, [f.firmId]);

    // Huis suspends the account (e.g. looking into a complaint). A suspended firm is shown no deletion date.
    await t.platform.query("SELECT huis.platform_set_status('Tracy Peart', $1, 'suspended', 'Looking into a report')", [f.firmId]);
    // Ten days pass (simulated by moving every date back ten days).
    await asHuis("UPDATE huis.firms SET trial_ends_at = trial_ends_at - interval '10 days' WHERE id = $1", [f.firmId]);
    await t.admin.query(`UPDATE huis.firm_deletion_notices SET sent_at = sent_at - interval '10 days',
        for_delete_after = for_delete_after - interval '10 days' WHERE firm_id = $1`, [f.firmId]);
    while (await worker().deleteOnce()) { /* nothing of this firm's while it is suspended */ }
    expect(await firmExists(f.firmId)).toBe(true);

    // Huis restores it. Docs: "If warnings start late (a trial extended, a firm restored ...) the deletion waits;
    // it never happens early." Today the warnings from before the suspension still count and the firm is deleted
    // on the very next pass, seconds after being restored, with no email since.
    await t.platform.query("SELECT huis.platform_set_status('Tracy Peart', $1, 'active', 'Report closed')", [f.firmId]);
    const email = new FakeEmail();
    const w = worker(email);
    await w.queueDue(true);
    while (await w.sendOnce()) { /* send whatever is due now */ }
    while (await w.deleteOnce()) { /* delete whatever is due now */ }
    expect(await firmExists(f.firmId)).toBe(true);
  });
});

describe("R32-3: late warnings go out as one burst that names a date already past", () => {
  it("a firm first warned after its date gets one warning at a time, naming a date that is still ahead", async () => {
    const f = await newFirm(t.db);
    // The trial ended 45 days ago (the date passed 15 days ago): deletion was off, or the email service was set
    // up late, both cases the docs name.
    await endTrial(f.firmId, 45);
    const email = new FakeEmail();
    const w = worker(email);
    await w.queueDue(true);
    while (await w.sendOnce()) { /* send */ }

    // Today three emails arrive together: "will be deleted on <15 days ago> (in 14 days)", "(in 7 days)" and
    // "(tomorrow)". The deletion then happens 13 days later with no further email: no 7-day or 1-day warning
    // precedes it, and no email ever stated the real date.
    expect(email.sent).toHaveLength(1);
    const named = /deleted on (.+)$/.exec(email.sent[0]!.subject)?.[1];
    expect(new Date(named!).getTime()).toBeGreaterThan(Date.now() + 12 * 86_400_000);
  });
});

describe("R32-4: one firm whose files can't be deleted stops every other deleted firm's files being deleted", () => {
  it("the next firm's files are still deleted, and the worker's pass doesn't fail", async () => {
    const a = await newFirm(t.db);
    const b = await newFirm(t.db);
    for (const f of [a, b]) {
      await endTrial(f.firmId, 31);
      await roundDue(f.firmId);
      expect((await t.worker.query("SELECT huis.worker_delete_firm($1) AS p", [f.firmId])).rows[0].p).not.toBeNull();
    }
    // Storage refuses firm A's prefix (an object store error, a permission problem on one directory...).
    const files = new (class implements FirmFileDeleter {
      deleted: string[] = [];
      async deleteFirmPrefix(prefix: string) {
        if (prefix.includes(a.firmId)) throw new Error("storage unavailable");
        this.deleted.push(prefix);
      }
    })();
    const w = worker(new FakeEmail(), files);
    // Today worker_firm_files_pending returns A (oldest) on every pass, deleteOnce throws, and B's privileged
    // files stay in storage forever. In src/worker/main.ts the throw also skips brain.indexOnce for all firms.
    for (let i = 0; i < 20; i++) await w.deleteOnce().catch(() => undefined);
    expect(files.deleted).toContain(`firm/${b.firmId}/`);
    await expect(w.runOnce()).resolves.toBeTypeOf("boolean");
  });
});

describe("R32-5: the migration's blanket DELETE grant lets huis_security erase the staff log and the tombstones", () => {
  it("huis_security still can't delete from huis.platform_audit (only added to) or huis.firm_deletions", async () => {
    // 0037 made platform_audit append-only by grants alone (SELECT, INSERT). 0041's
    // "GRANT DELETE ON ALL TABLES IN SCHEMA huis TO huis_security" quietly added DELETE, so any flaw in any of
    // the many huis_security definer functions can now erase the staff log or the record of a deletion.
    await expect(asHuis("DELETE FROM huis.platform_audit WHERE false")).rejects.toThrow(/permission/i);
    await expect(asHuis("DELETE FROM huis.firm_deletions WHERE false")).rejects.toThrow(/permission/i);
  });
});
