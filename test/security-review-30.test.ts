import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UserFacingError } from "../src/errors";
import { getFirm, setAgreement, setTrialEnd } from "../src/services/admin";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

/*
 * Independent security review 30: Phase 10 part 6, the Huis admin portal.
 * Each test fails today and passes once its problem is fixed.
 */

let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });

const DAY = 86_400_000;

/** Puts a firm into a billing state directly, as the Stripe webhook would have. */
async function asSecurity(sql: string, params: unknown[]) {
  const c = await t.admin.connect();
  try {
    await c.query("BEGIN"); await c.query("SET LOCAL ROLE huis_security");
    await c.query(sql, params);
    await c.query("COMMIT");
  } finally { c.release(); }
}

describe("R30-1: staff can set a trial end in the past, which gives the firm a deletion date that has already passed", () => {
  it("a backdated trial end is refused (it would start the 30-day deletion clock years ago)", async () => {
    const f = await newFirm(t.db);
    // A typo in the date field (2020 for 2026), or a deliberate "shorten": accepted today.
    const backdated = new Date("2020-01-01T06:59:59Z");
    const attempt = setTrialEnd(t.platform, "Tracy Peart", f.firmId, backdated, "Shorten the trial");
    await attempt.catch(() => undefined);
    const firm = (await getFirm(t.platform, f.firmId))!.firm;
    // Today: trial_ends_at = 2020-01-01 and deleteAfter = 2020-01-31, i.e. the firm's client data is due for
    // deletion (part 2b) immediately, with none of the 14/7/1-day warnings ever sent.
    expect(firm.deleteAfter === null || firm.deleteAfter.getTime() > Date.now()).toBe(true);
    await expect(attempt).rejects.toBeInstanceOf(UserFacingError);
  });

  it("the same happens to a firm that has already subscribed in Stripe during its trial", async () => {
    const f = await newFirm(t.db);
    await asSecurity("UPDATE huis.firms SET stripe_customer_id = 'cus_R301', stripe_subscription_id = 'sub_R301', stripe_status = 'trialing', billing_interval = 'month' WHERE id = $1", [f.firmId]);
    await setTrialEnd(t.platform, "Tracy Peart", f.firmId, new Date(Date.now() - 45 * DAY), "Align with Stripe").catch(() => undefined);
    const firm = (await getFirm(t.platform, f.firmId))!.firm;
    expect(firm.deleteAfter === null || firm.deleteAfter.getTime() > Date.now()).toBe(true);
  });
});

describe("R30-2: the Stripe-live guard on 'plan by agreement' misses 'unpaid' and 'paused' subscriptions, which Stripe can still resume and charge", () => {
  it("setting a plan by agreement is refused while the firm still has an unpaid (not cancelled) Stripe subscription", async () => {
    const f = await newFirm(t.db);
    await asSecurity(`UPDATE huis.firms SET plan = 'professional', stripe_customer_id = 'cus_R302', stripe_subscription_id = 'sub_R302',
      stripe_status = 'unpaid', billing_interval = 'month', paid_through = now() - interval '3 days', access_ended_at = now() - interval '1 day' WHERE id = $1`, [f.firmId]);
    const until = new Date(Date.now() + 365 * DAY);
    const attempt = setAgreement(t.platform, "Tracy Peart", f.firmId, { plan: "enterprise", seats: 25, paidThrough: until }, "Annual invoice 1002");
    await attempt.catch(() => undefined);

    // Today it succeeds and operator_set_subscription unlinks sub_R302. The customer then pays the open Stripe
    // invoice (Stripe reactivates an unpaid subscription when its invoice is paid): Huis is charged for twice,
    // and the webhook silently replaces the 25-seat enterprise agreement with Stripe's professional plan.
    // Observed in review: before the webhook ['enterprise', 25]; billing_apply_subscription(..., 'active', ...)
    // returns 'applied'; after it ['professional', null].
    await expect(attempt).rejects.toThrow(/Stripe/);
  });

  it("the same for a paused subscription (resumes as soon as the firm adds a card)", async () => {
    const f = await newFirm(t.db);
    await asSecurity(`UPDATE huis.firms SET plan = 'professional', stripe_customer_id = 'cus_R303', stripe_subscription_id = 'sub_R303',
      stripe_status = 'paused', billing_interval = 'month', access_ended_at = now() WHERE id = $1`, [f.firmId]);
    await expect(setAgreement(t.platform, "Tracy Peart", f.firmId, { plan: "professional", seats: 5, paidThrough: new Date(Date.now() + 30 * DAY) }, "Invoice 1003"))
      .rejects.toThrow(/Stripe/);
  });
});
