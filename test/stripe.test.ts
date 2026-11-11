import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { PermissionDeniedError, UserFacingError } from "../src/errors";
import { signStripePayload, verifyStripeSignature } from "../src/billing/stripe";
import { createClient } from "../src/services/clients";
import { createMatter, listMatters } from "../src/services/matters";
import { handleStripeWebhook, openPortal, startCheckout, syncSeats } from "../src/services/stripe-billing";
import { getSubscription, pausedReason } from "../src/services/subscription";
import { inviteUser } from "../src/services/users";
import { FakeStripe, PRICE_YEARLY, WEBHOOK_SECRET } from "./fake-stripe";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

let t: TestDatabase;
let db: HuisDb;
let stripe: FakeStripe;
const BASE = "https://app.huis.test";
const DAY = 86_400_000;

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
  // The trial Tracy chose on 11 November 2026: 1 seat, 1 Matter (helpers.ts lifts the limits for other tests).
  await t.admin.query("UPDATE huis.plans SET seat_limit = 1, matter_limit = 1 WHERE code = 'trial'");
  stripe = new FakeStripe();
  await stripe.start();
});
afterAll(async () => {
  await stripe?.stop();
  await t?.drop();
});

const cfg = () => stripe.config();
const ctxOf = (firmId: string, userId: string): RequestContext => ({ firmId, userId });

async function firmWithMatter() {
  const f = await newFirm(db);
  const matter = await db.withFirm(f.owner, async (s) => {
    const client = await createClient(s, { kind: "person", displayName: "Pat Smith" });
    return createMatter(s, { title: "Smith v. Acme", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
  });
  return { ...f, matter };
}

/** A firm that has been through checkout: its customer is recorded and Stripe holds a subscription. */
async function subscribedFirm(opts: { price?: string; status?: string } = {}) {
  const f = await firmWithMatter();
  await startCheckout(db, f.owner, cfg(), { interval: "month", baseUrl: BASE });
  const customer = (await t.admin.query("SELECT stripe_customer_id FROM huis.firms WHERE id = $1", [f.firmId])).rows[0].stripe_customer_id as string;
  const sub = stripe.addSubscription({ firmId: f.firmId, customer, price: opts.price, status: opts.status });
  const ev = stripe.event("checkout.session.completed", { id: "cs_test_123", subscription: sub.id, customer });
  const res = await handleStripeWebhook(t.billing, cfg(), ev.body, ev.signature);
  return { ...f, customer, sub, res };
}

/** Changes Huis alone may make (the plan, trial and seats), as Huis's own database role. */
async function asHuis(sql: string, params: unknown[]) {
  const c = await t.admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE huis_security");
    await c.query(sql, params);
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
}

const firmRow = async (firmId: string) => (await t.admin.query("SELECT * FROM huis.firms WHERE id = $1", [firmId])).rows[0];
const send = (type: string, object: Record<string, unknown>) => {
  const ev = stripe.event(type, object);
  return handleStripeWebhook(t.billing, cfg(), ev.body, ev.signature);
};

describe("the trial: 7 days, 1 seat, 1 Matter", () => {
  it("the owner takes the only seat; outside people are still free", async () => {
    const f = await newFirm(db);
    const invite = (role: string, n: string) => db.withFirm(f.owner, (s) =>
      inviteUser(s, { email: `${n}@${f.slug}.example`, fullName: `Person ${n}`, role: role as never, locationId: f.locationId }));
    await expect(invite("paralegal", "p1")).rejects.toThrow(/free trial includes 1 seat/);
    await expect(invite("paralegal", "p1")).rejects.toBeInstanceOf(UserFacingError);
    await invite("client", "c1");
    const trialEnds = (await firmRow(f.firmId)).trial_ends_at as Date;
    expect(Math.round((trialEnds.getTime() - Date.now()) / DAY)).toBe(7);
  });

  it("one Matter; a second is refused, even two created at the same moment", async () => {
    const f = await newFirm(db);
    const client = await db.withFirm(f.owner, (s) => createClient(s, { kind: "person", displayName: "Pat Smith" }));
    const make = (n: number) => db.withFirm(f.owner, (s) =>
      createMatter(s, { title: `Matter ${n}`, clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" }));
    const results = await Promise.allSettled([1, 2, 3].map(make));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await expect(make(4)).rejects.toThrow(/free trial includes 1 Matter/);
    // Straight into the table makes no difference: the database enforces it.
    await expect(db.withFirm(f.owner, (s) => s.client.query(
      `INSERT INTO huis.matters (firm_id, location_id, client_id, title, huis_number, lead_attorney_id, jurisdiction_state)
       SELECT firm_id, location_id, client_id, 'Sneaky', 'X-1', lead_attorney_id, jurisdiction_state FROM huis.matters WHERE firm_id = $1 LIMIT 1`,
      [f.firmId]))).rejects.toThrow(/includes 1 Matter|violates|null value/);
    const sub = await db.withFirm(f.owner, (s) => getSubscription(s));
    expect(sub.matters).toEqual({ used: 1, limit: 1 });
    expect(sub.seats).toEqual({ used: 1, limit: 1 });
  });
});

describe("checkout", () => {
  it("creates the firm's Stripe customer once, and sends people only to Stripe's own page", async () => {
    const f = await firmWithMatter();
    const url = await startCheckout(db, f.owner, cfg(), { interval: "month", baseUrl: BASE });
    expect(url).toBe("https://checkout.stripe.com/c/pay/cs_test_123");
    await startCheckout(db, f.owner, cfg(), { interval: "year", baseUrl: BASE });
    const mine = stripe.customers.filter((c) => c.params["metadata[firm_id]"] === f.firmId);
    expect(mine).toHaveLength(1);
    expect((await firmRow(f.firmId)).stripe_customer_id).toBe(mine[0]!.id);
    const [monthly, yearly] = stripe.checkouts.slice(-2);
    expect(monthly).toMatchObject({
      mode: "subscription", customer: mine[0]!.id, "line_items[0][price]": "price_HuisMonthly", "line_items[0][quantity]": "1",
      "subscription_data[metadata][firm_id]": f.firmId, client_reference_id: f.firmId, allow_promotion_codes: "true",
      success_url: `${BASE}/subscription?checkout=done`, cancel_url: `${BASE}/subscription`,
    });
    expect(yearly!["line_items[0][price]"]).toBe(PRICE_YEARLY);
    // Subscribing on day 1 keeps the rest of the trial free.
    const trialEnd = Math.floor(((await firmRow(f.firmId)).trial_ends_at as Date).getTime() / 1000);
    expect(Number(monthly!["subscription_data[trial_end]"])).toBe(trialEnd);
    const audit = await t.admin.query("SELECT 1 FROM huis.audit_events WHERE firm_id = $1 AND action = 'billing.account_created'", [f.firmId]);
    expect(audit.rowCount).toBe(1);
  });

  it("near the end of the trial, billing starts straight away (Stripe needs 48 hours' notice)", async () => {
    const f = await firmWithMatter();
    await asHuis("UPDATE huis.firms SET trial_ends_at = now() + interval '1 day' WHERE id = $1", [f.firmId]);
    await startCheckout(db, f.owner, cfg(), { interval: "month", baseUrl: BASE });
    expect(stripe.checkouts.at(-1)!["subscription_data[trial_end]"]).toBeUndefined();
  });

  it("refuses an address that isn't Stripe's", async () => {
    const f = await firmWithMatter();
    stripe.checkoutUrl = "https://checkout.stripe.com.evil.example/pay";
    try {
      await expect(startCheckout(db, f.owner, cfg(), { interval: "month", baseUrl: BASE })).rejects.toThrow(/unexpected checkout address/);
    } finally {
      stripe.checkoutUrl = "https://checkout.stripe.com/c/pay/cs_test_123";
    }
  });

  it("only owners, managing partners and firm or billing administrators can subscribe", async () => {
    const f = await firmWithMatter();
    await asHuis("UPDATE huis.firms SET seat_limit = 5 WHERE id = $1", [f.firmId]);
    const para = await db.withFirm(f.owner, (s) => inviteUser(s, { email: `p@${f.slug}.example`, fullName: "Pat Para", role: "paralegal", locationId: f.locationId }));
    const billing = await db.withFirm(f.owner, (s) => inviteUser(s, { email: `b@${f.slug}.example`, fullName: "Bo Billing", role: "billing_admin", locationId: f.locationId }));
    await expect(startCheckout(db, ctxOf(f.firmId, para.id), cfg(), { interval: "month", baseUrl: BASE })).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(openPortal(db, ctxOf(f.firmId, para.id), cfg(), { baseUrl: BASE })).rejects.toBeInstanceOf(PermissionDeniedError);
    await startCheckout(db, ctxOf(f.firmId, billing.id), cfg(), { interval: "month", baseUrl: BASE });
    expect(await openPortal(db, ctxOf(f.firmId, billing.id), cfg(), { baseUrl: BASE })).toBe("https://billing.stripe.com/p/session/test_123");
  });

  it("the app can record its firm's customer once, and never replace it", async () => {
    const f = await firmWithMatter();
    await startCheckout(db, f.owner, cfg(), { interval: "month", baseUrl: BASE });
    await expect(db.withFirm(f.owner, (s) => s.client.query("SELECT huis.my_firm_set_stripe_customer('cus_SomeoneElse')")))
      .rejects.toThrow();
    await expect(db.withFirm(f.owner, (s) => s.client.query("UPDATE huis.firms SET stripe_customer_id = 'cus_X' WHERE id = $1", [f.firmId])))
      .rejects.toThrow(/managed by Huis/);
  });
});

describe("Stripe's notifications", () => {
  it("a paid subscription lifts the trial limits, and is recorded in the audit log", async () => {
    const f = await subscribedFirm();
    expect(f.res).toEqual({ status: 200, outcome: "applied" });
    const row = await firmRow(f.firmId);
    expect(row).toMatchObject({ plan: "professional", stripe_status: "active", billing_interval: "month", seat_limit: null, access_ended_at: null });
    expect((row.paid_through as Date).getTime() / 1000).toBe(f.sub.items.data[0]!.current_period_end);
    // A second Matter and a second seat are now fine.
    await db.withFirm(f.owner, async (s) => {
      const c = await createClient(s, { kind: "person", displayName: "Second Client" });
      await createMatter(s, { title: "Second", clientId: c.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
      await inviteUser(s, { email: `a@${f.slug}.example`, fullName: "Al Attorney", role: "attorney", locationId: f.locationId });
    });
    const audit = await t.admin.query("SELECT metadata FROM huis.audit_events WHERE firm_id = $1 AND action = 'subscription.changed'", [f.firmId]);
    expect(audit.rows[0].metadata).toMatchObject({ by: "Stripe", from: { plan: "trial" }, to: { plan: "professional", status: "active" } });
    // A duplicate changes nothing.
    expect(await send("invoice.paid", { id: "in_1", subscription: f.sub.id })).toEqual({ status: 200, outcome: "unchanged" });
  });

  it("subscribing during the trial keeps the trial's limits until the first payment, then lifts them (R27-1)", async () => {
    const f = await subscribedFirm({ status: "trialing" });
    expect(await firmRow(f.firmId)).toMatchObject({ plan: "trial", stripe_status: "trialing" });
    const more = () => db.withFirm(f.owner, async (s) => {
      const c = await createClient(s, { kind: "person", displayName: "Second Client" });
      return createMatter(s, { title: "Second", clientId: c.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
    });
    await expect(more()).rejects.toThrow(/free trial includes 1 Matter/);
    // Checkout can't be opened twice.
    await expect(startCheckout(db, f.owner, cfg(), { interval: "month", baseUrl: BASE })).rejects.toThrow(/already has a subscription/);
    // The trial ends and Stripe takes the first payment.
    stripe.subscriptions[f.sub.id]!.status = "active";
    expect((await send("invoice.paid", { id: "in_9", subscription: f.sub.id })).outcome).toBe("applied");
    expect((await firmRow(f.firmId)).plan).toBe("professional");
    await more();
  });

  it("cancelling during the trial: the trial runs to its own end, and the firm can subscribe again", async () => {
    const f = await subscribedFirm({ status: "trialing" });
    stripe.subscriptions[f.sub.id]!.status = "canceled";
    expect((await send("customer.subscription.deleted", { id: f.sub.id })).outcome).toBe("applied");
    expect(await firmRow(f.firmId)).toMatchObject({ plan: "trial", stripe_status: "canceled", access_ended_at: null });
    expect((await db.withFirm(f.owner, (s) => getSubscription(s))).deleteAfter).toBeNull();
    await startCheckout(db, f.owner, cfg(), { interval: "year", baseUrl: BASE });
  });

  it("refuses a bad signature, a replayed one and an old one", async () => {
    const f = await firmWithMatter();
    const ev = stripe.event("customer.subscription.updated", { id: "sub_Nope" });
    expect((await handleStripeWebhook(t.billing, cfg(), ev.body, null)).status).toBe(400);
    expect((await handleStripeWebhook(t.billing, cfg(), ev.body, signStripePayload(ev.body, "whsec_wrong"))).status).toBe(400);
    expect((await handleStripeWebhook(t.billing, cfg(), `${ev.body} `, ev.signature)).status).toBe(400);
    const old = stripe.event("customer.subscription.updated", { id: "sub_Nope" }, { timestamp: Math.floor(Date.now() / 1000) - 600 });
    expect((await handleStripeWebhook(t.billing, cfg(), old.body, old.signature)).status).toBe(400);
    expect((await firmRow(f.firmId)).plan).toBe("trial");
  });

  it("trusts Stripe's current state, not the notification's copy", async () => {
    const f = await subscribedFirm();
    // A forged-looking or stale copy says "canceled"; Stripe says the subscription is active.
    const res = await send("customer.subscription.deleted", { id: f.sub.id, status: "canceled", metadata: { firm_id: f.firmId } });
    expect(res.outcome).toBe("unchanged");
    expect((await firmRow(f.firmId)).access_ended_at).toBeNull();
  });

  it("one firm's subscription can't upgrade another firm", async () => {
    const a = await subscribedFirm();
    const b = await firmWithMatter();
    // A subscription naming firm B, paid by firm A's customer.
    const sub = stripe.addSubscription({ firmId: b.firmId, customer: a.customer });
    expect((await send("customer.subscription.created", { id: sub.id })).outcome).toBe("ignored: customer does not match");
    expect((await firmRow(b.firmId)).plan).toBe("trial");
  });

  it("a subscription to any other price never grants access", async () => {
    const f = await subscribedFirm({ price: "price_SomethingElse" });
    expect(f.res.outcome).toBe("ignored: unknown price");
    expect((await firmRow(f.firmId)).plan).toBe("trial");
  });

  it("a checkout that never completes payment changes nothing", async () => {
    const f = await subscribedFirm({ status: "incomplete" });
    expect(f.res.outcome).toBe("ignored: not started");
    stripe.subscriptions[f.sub.id]!.status = "incomplete_expired";
    expect((await send("customer.subscription.updated", { id: f.sub.id })).outcome).toBe("ignored: not started");
    expect((await firmRow(f.firmId)).plan).toBe("trial");
  });

  it("asks Stripe to retry when Stripe can't be reached", async () => {
    const f = await subscribedFirm();
    stripe.failSubscriptionFetch = 503;
    try {
      await expect(send("invoice.paid", { id: "in_2", subscription: f.sub.id })).rejects.toThrow();
    } finally {
      stripe.failSubscriptionFetch = null;
    }
  });

  it("ignores notifications Huis doesn't act on", async () => {
    expect(await send("customer.created", { id: "cus_1" })).toEqual({ status: 200, outcome: "ignored: not handled" });
    expect(await send("invoice.paid", { id: "in_3" })).toEqual({ status: 200, outcome: "ignored: no subscription" });
  });

  it("the webhook's login can only record Stripe's state; the app can't call it at all", async () => {
    const f = await firmWithMatter();
    await expect(db.withFirm(f.owner, (s) => s.client.query(
      "SELECT huis.billing_apply_subscription($1, 'cus_X', 'sub_X', 'active', 'month', now() + interval '1 year', true)", [f.firmId])))
      .rejects.toThrow();
    await expect(t.billing.query("SELECT * FROM huis.firms")).rejects.toThrow(/permission denied/);
    await expect(t.billing.query("UPDATE huis.firms SET plan = 'professional'")).rejects.toThrow(/permission denied/);
  });
});

describe("seats billed follow the firm's staff", () => {
  it("after people are added or removed, Stripe bills the active attorneys and staff", async () => {
    const f = await subscribedFirm();
    const item = f.sub.items.data[0]!;
    await db.withFirm(f.owner, async (s) => {
      await inviteUser(s, { email: `a@${f.slug}.example`, fullName: "Al Attorney", role: "attorney", locationId: f.locationId });
      await inviteUser(s, { email: `p@${f.slug}.example`, fullName: "Pat Para", role: "paralegal", locationId: f.locationId });
      await inviteUser(s, { email: `c@${f.slug}.example`, fullName: "Cal Client", role: "client", locationId: f.locationId });
    });
    await syncSeats(t.billing, cfg(), f.firmId);
    expect(item.quantity).toBe(3);
    // A change made in Stripe directly is corrected by the next notification.
    item.quantity = 9;
    await send("customer.subscription.updated", { id: f.sub.id });
    expect(item.quantity).toBe(3);
  });
});

describe("when access ends: read and export for 30 days, then deletion", () => {
  it("a cancelled subscription pauses new work at once and shows the deletion date to firm staff", async () => {
    const f = await subscribedFirm();
    stripe.subscriptions[f.sub.id]!.status = "canceled";
    expect((await send("customer.subscription.deleted", { id: f.sub.id })).outcome).toBe("applied");
    const row = await firmRow(f.firmId);
    expect(row.access_ended_at).not.toBeNull();
    await expect(db.withFirm(f.owner, async (s) => {
      const c = await createClient(s, { kind: "person", displayName: "New" });
      return createMatter(s, { title: "New", clientId: c.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
    })).rejects.toThrow(/subscription has ended/);
    // Reading still works.
    expect(await db.withFirm(f.owner, (s) => listMatters(s))).toHaveLength(1);
    const sub = await db.withFirm(f.owner, (s) => getSubscription(s));
    expect(sub.deleteAfter!.getTime() - (row.access_ended_at as Date).getTime()).toBe(30 * DAY);
    expect(await db.withFirm(f.owner, (s) => pausedReason(s))).toMatch(/subscription has ended/);

    // Outside users never learn the firm's standing or the date.
    const portal = await db.withFirm(f.owner, (s) => inviteUser(s, { email: `c@${f.slug}.example`, fullName: "Casey Client", role: "client", locationId: f.locationId }));
    const portalCtx = ctxOf(f.firmId, portal.id);
    expect(await db.withFirm(portalCtx, (s) => pausedReason(s))).toBeNull();
    expect((await db.withFirm(portalCtx, (s) => s.client.query("SELECT huis.my_firm_delete_after() AS d"))).rows[0].d).toBeNull();

    // Subscribing again restores everything.
    stripe.subscriptions[f.sub.id]!.status = "active";
    expect((await send("customer.subscription.resumed", { id: f.sub.id })).outcome).toBe("applied");
    expect((await firmRow(f.firmId)).access_ended_at).toBeNull();
    expect((await db.withFirm(f.owner, (s) => getSubscription(s))).deleteAfter).toBeNull();
  });

  it("an old subscription ending doesn't end the firm's current one; a second one doesn't replace a live one", async () => {
    const f = await subscribedFirm();
    // Two checkouts completed at once: the second subscription doesn't replace the live one.
    const second = stripe.addSubscription({ firmId: f.firmId, customer: f.customer, price: PRICE_YEARLY });
    expect((await send("customer.subscription.created", { id: second.id })).outcome).toBe("ignored: firm already has a subscription");
    // The first ends, then the firm subscribes again with a new one.
    stripe.subscriptions[f.sub.id]!.status = "canceled";
    expect((await send("customer.subscription.deleted", { id: f.sub.id })).outcome).toBe("applied");
    const newer = stripe.addSubscription({ firmId: f.firmId, customer: f.customer, price: PRICE_YEARLY });
    expect((await send("customer.subscription.created", { id: newer.id })).outcome).toBe("applied");
    // A late notification about the old one changes nothing.
    expect((await send("customer.subscription.deleted", { id: f.sub.id })).outcome).toBe("ignored: not the firm's current subscription");
    expect(await firmRow(f.firmId)).toMatchObject({ billing_interval: "year", access_ended_at: null, stripe_subscription_id: newer.id });
  });

  it("a trial that ended unpaid: deletion 30 days after the trial's end, told to staff only", async () => {
    const f = await firmWithMatter();
    const portal = await db.withFirm(f.owner, (s) => inviteUser(s, { email: `c@${f.slug}.example`, fullName: "Casey Client", role: "client", locationId: f.locationId }));
    await asHuis("UPDATE huis.firms SET trial_ends_at = now() - interval '2 days' WHERE id = $1", [f.firmId]);
    const sub = await db.withFirm(f.owner, (s) => getSubscription(s));
    const ends = (await firmRow(f.firmId)).trial_ends_at as Date;
    expect(sub.deleteAfter!.getTime() - ends.getTime()).toBe(30 * DAY);
    expect(await db.withFirm(f.owner, (s) => pausedReason(s))).toMatch(/free trial has ended/);
    const r = await db.withFirm(ctxOf(f.firmId, portal.id), (s) => s.client.query("SELECT huis.my_firm_delete_after() AS d"));
    expect(r.rows[0].d).toBeNull();
  });

  it("a firm with access has no deletion date", async () => {
    const f = await firmWithMatter();
    expect((await db.withFirm(f.owner, (s) => getSubscription(s))).deleteAfter).toBeNull();
  });
});

describe("signature checking", () => {
  it("accepts Stripe's format and refuses anything else", () => {
    const body = '{"id":"evt_1"}';
    const now = 1_800_000_000;
    const good = signStripePayload(body, WEBHOOK_SECRET, now);
    expect(verifyStripeSignature(body, good, WEBHOOK_SECRET, now)).toBe(true);
    expect(verifyStripeSignature(body, `${good},v1=${"0".repeat(64)}`, WEBHOOK_SECRET, now)).toBe(true);
    expect(verifyStripeSignature(body, good, WEBHOOK_SECRET, now + 301)).toBe(false);
    expect(verifyStripeSignature(body, good.replace(/v1=\w+/, "v1=zz"), WEBHOOK_SECRET, now)).toBe(false);
    expect(verifyStripeSignature(body, `t=${now}`, WEBHOOK_SECRET, now)).toBe(false);
    expect(verifyStripeSignature(body, good, "", now)).toBe(false);
  });
});
