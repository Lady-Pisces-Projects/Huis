/**
 * Security review 27: Phase 10 part 2 (Stripe checkout, portal, webhook; the 1-seat / 1-Matter trial;
 * the 30-day deletion date). Each test here FAILS on the reviewed working tree and shows one finding;
 * it passes once the finding is fixed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { createClient } from "../src/services/clients";
import { createMatter } from "../src/services/matters";
import { handleStripeWebhook, startCheckout } from "../src/services/stripe-billing";
import { getSubscription } from "../src/services/subscription";
import { inviteUser } from "../src/services/users";
import { FakeStripe, PRICE_MONTHLY, PRICE_YEARLY, WEBHOOK_SECRET } from "./fake-stripe";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

// The webhook route imports server-only modules; stand them in so the route itself can be exercised.
vi.mock("server-only", () => ({}));
vi.mock("../lib/server", () => ({ getSession: async () => null }));

let t: TestDatabase;
let db: HuisDb;
let stripe: FakeStripe;
const BASE = "https://app.huis.test";
const DAY = 86_400_000;
const nowS = () => Math.floor(Date.now() / 1000);

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
  // The trial as decided on 11 November 2026: 1 seat, 1 Matter.
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
const firmRow = async (firmId: string) => (await t.admin.query("SELECT * FROM huis.firms WHERE id = $1", [firmId])).rows[0];
const send = (type: string, object: Record<string, unknown>) => {
  const ev = stripe.event(type, object);
  return handleStripeWebhook(t.billing, cfg(), ev.body, ev.signature);
};

async function firmWithMatter() {
  const f = await newFirm(db);
  const matter = await db.withFirm(f.owner, async (s) => {
    const client = await createClient(s, { kind: "person", displayName: "Pat Smith" });
    return createMatter(s, { title: "Smith v. Acme", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
  });
  return { ...f, matter };
}

async function subscribedFirm(opts: { price?: string; status?: string; periodEnd?: number } = {}) {
  const f = await firmWithMatter();
  await startCheckout(db, f.owner, cfg(), { interval: "month", baseUrl: BASE });
  const customer = (await firmRow(f.firmId)).stripe_customer_id as string;
  const sub = stripe.addSubscription({ firmId: f.firmId, customer, price: opts.price, status: opts.status, periodEnd: opts.periodEnd });
  const res = await send("checkout.session.completed", { id: "cs_test_123", subscription: sub.id, customer });
  return { ...f, customer, sub, res };
}

describe("R27-1: subscribing during the trial lifts the 1-seat / 1-Matter limits before anything is paid", () => {
  it("a 'trialing' subscription (card on file, $0 charged, cancellable before the trial ends) keeps the trial limits", async () => {
    // Checkout during the trial carries the rest of the trial over (subscription_data[trial_end]), so Stripe's
    // subscription is 'trialing' and nothing is charged until the trial ends. The firm can cancel in the portal
    // (cancel at period end keeps it 'trialing') and never pay.
    const f = await subscribedFirm({ status: "trialing" });
    expect(f.res.outcome).toBe("applied");
    expect(stripe.checkouts.at(-1)!["subscription_data[trial_end]"]).toBeDefined();
    // Today: plan 'professional', no seat or Matter limit, while $0 has been paid.
    const more = db.withFirm(f.owner, async (s) => {
      const c = await createClient(s, { kind: "person", displayName: "Second Client" });
      return createMatter(s, { title: "Second (whole discovery set)", clientId: c.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
    });
    await expect(more).rejects.toThrow(/free trial includes 1 Matter/);
    await expect(db.withFirm(f.owner, (s) => inviteUser(s, {
      email: `a@${f.slug}.example`, fullName: "Al Attorney", role: "attorney", locationId: f.locationId,
    }))).rejects.toThrow(/free trial includes 1 seat/);
  });
});

describe("R27-2: 'past_due' moves paid_through to the end of the period that hasn't been paid", () => {
  it("an unpaid renewal does not extend access (the 7-day overdue grace should still apply)", async () => {
    // A subscription whose paid period ended 8 days ago (Huis would now say 'payment is overdue')...
    const f = await subscribedFirm({ periodEnd: nowS() - 8 * 86400 });
    expect((await t.admin.query("SELECT huis.firm_write_block($1) AS r", [f.firmId])).rows[0].r).toMatch(/overdue/);
    const paidBefore = (await firmRow(f.firmId)).paid_through as Date;
    // ...renews, the charge fails: Stripe advances the period and marks it past_due (and, with "leave past
    // due" dunning, keeps doing so every period without ever being paid).
    const s = stripe.subscriptions[f.sub.id]!;
    s.status = "past_due";
    s.items.data[0]!.current_period_end = nowS() + 22 * 86400;
    await send("invoice.payment_failed", { id: "in_fail", subscription: f.sub.id });
    const row = await firmRow(f.firmId);
    expect((row.paid_through as Date).getTime()).toBe(paidBefore.getTime());
    expect((await t.admin.query("SELECT huis.firm_write_block($1) AS r", [f.firmId])).rows[0].r).toMatch(/overdue/);
  });
});

describe("R27-3: once a Stripe subscription ends, Huis restoring the firm by hand leaves it paused with a deletion date", () => {
  it("operator_set_subscription to a paid plan clears the ended state", async () => {
    const f = await subscribedFirm();
    stripe.subscriptions[f.sub.id]!.status = "canceled";
    expect((await send("customer.subscription.deleted", { id: f.sub.id })).outcome).toBe("applied");
    // The firm moves to an invoiced agreement; Huis records it (scripts/operator/set-subscription.ts).
    await t.admin.query("SELECT huis.operator_set_subscription($1, 'enterprise', 25, NULL, now() + interval '1 year', 'active', 'invoiced by agreement')", [f.firmId]);
    const sub = await db.withFirm(f.owner, (s) => getSubscription(s));
    // Today: still "subscription has ended" and "files will be deleted on …" (and 10.2b would delete them).
    expect(sub.paused).toBeNull();
    expect(sub.deleteAfter).toBeNull();
  });
});

describe("R27-4: clients and other outside users can read the firm's Stripe standing straight from huis.firms", () => {
  it("a client-portal session can't see stripe_status, access_ended_at, paid_through or the Stripe customer", async () => {
    const f = await subscribedFirm();
    stripe.subscriptions[f.sub.id]!.status = "canceled";
    await send("customer.subscription.deleted", { id: f.sub.id });
    const client = await db.withFirm(f.owner, (s) => inviteUser(s, { email: `c@${f.slug}.example`, fullName: "Casey Client", role: "client", locationId: f.locationId }));
    // my_firm_delete_after() and my_firm_write_block() hide this from outside users (R24-2) ...
    expect((await db.withFirm(ctxOf(f.firmId, client.id), (s) => s.client.query("SELECT huis.my_firm_delete_after() AS d"))).rows[0].d).toBeNull();
    // ... but the table itself is readable by any session of the firm (firms_select has no role condition).
    const leaked = await db.withFirm(ctxOf(f.firmId, client.id), async (s) =>
      (await s.client.query("SELECT stripe_status, access_ended_at, paid_through, stripe_customer_id FROM huis.firms")).rows[0])
      .catch(() => null);
    expect(leaked?.stripe_status ?? null).toBeNull();
    expect(leaked?.access_ended_at ?? null).toBeNull();
    expect(leaked?.stripe_customer_id ?? null).toBeNull();
  });
});

describe("R27-5: the webhook reads an unbounded body before checking its size", () => {
  it("a chunked body with no Content-Length is cut off near the 512 KB limit, not buffered whole", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.STRIPE_PRICE_MONTHLY = PRICE_MONTHLY;
    process.env.STRIPE_PRICE_YEARLY = PRICE_YEARLY;
    process.env.HUIS_STRIPE_API_BASE = stripe.base;
    process.env.HUIS_BILLING_DATABASE_URL = "postgres://nobody:nothing@127.0.0.1:1/none";
    const { POST } = await import("../app/api/stripe/webhook/route");
    const TOTAL = 16 * 1024 * 1024;
    const CHUNK = 64 * 1024;
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (pulled >= TOTAL) { c.close(); return; }
        pulled += CHUNK;
        c.enqueue(new Uint8Array(CHUNK).fill(0x20));
      },
    });
    // Unauthenticated: no signature is needed to make the server hold the whole body in memory.
    const req = new Request("https://app.huis.test/api/stripe/webhook", {
      method: "POST", body, headers: { "stripe-signature": "t=1,v1=00" }, duplex: "half",
    } as RequestInit);
    const res = await POST(req);
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThanOrEqual(2 * 1024 * 1024);
  });
});
