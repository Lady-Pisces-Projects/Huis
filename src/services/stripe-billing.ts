import type pg from "pg";
import type { HuisDb, RequestContext } from "../db/tenant";
import { UserFacingError } from "../errors";
import {
  createCheckoutSession, createCustomer, createPortalSession, getSubscription, isStripePage, setSubscriptionItemQuantity,
  STRIPE_CHECKOUT_ORIGIN, STRIPE_PORTAL_ORIGIN, StripeError, verifyStripeSignature,
  type StripeConfig, type StripeSubscription,
} from "../billing/stripe";

/**
 * Phase 10 part 2: paying for Huis through Stripe.
 *
 * - Checkout and the customer portal are Stripe's own pages; Huis only creates them and sends people there.
 * - Stripe's notifications are trusted only after their signature checks out, and even then Huis asks Stripe
 *   for the subscription's current state rather than trusting the copy in the notification.
 * - What a subscription means for the firm (plan, paid-through date, access ending) is recorded by the
 *   database (huis.billing_apply_subscription), through a login that can do nothing else.
 *
 * Stripe calls are made outside database transactions, so a slow Stripe never holds a connection or a lock.
 */

export type BillingInterval = "month" | "year";

/** Stripe needs a trial end at least 48 hours ahead; keep a margin. */
const MIN_TRIAL_CARRYOVER_SECONDS = 49 * 3600;

interface CheckoutInfo {
  firm_id: string;
  firm_name: string;
  stripe_customer_id: string | null;
  seats_used: number;
  trial_ends_at: Date | null;
  subscribed: boolean;
}

async function checkoutInfo(db: HuisDb, ctx: RequestContext): Promise<CheckoutInfo> {
  return db.withFirm(ctx, async (s) => (await s.client.query<CheckoutInfo>("SELECT * FROM huis.my_firm_checkout()")).rows[0]!);
}

/** The firm's Stripe customer, created once and recorded by the database (which never lets it be replaced). */
async function ensureCustomer(db: HuisDb, ctx: RequestContext, cfg: StripeConfig, info: CheckoutInfo): Promise<string> {
  if (info.stripe_customer_id) return info.stripe_customer_id;
  // Same idempotency key per firm, so two clicks at once get the same customer from Stripe.
  const customer = await createCustomer(cfg, { firmId: info.firm_id, firmName: info.firm_name });
  try {
    await db.withFirm(ctx, (s) => s.client.query("SELECT huis.my_firm_set_stripe_customer($1)", [customer.id]));
  } catch (err) {
    // Recorded meanwhile by another request: use what the database holds.
    const now = await checkoutInfo(db, ctx);
    if (now.stripe_customer_id) return now.stripe_customer_id;
    throw err;
  }
  return customer.id;
}

/** Starts Stripe checkout for the firm (owners, managing partners, firm and billing administrators). Returns Stripe's page. */
export async function startCheckout(db: HuisDb, ctx: RequestContext, cfg: StripeConfig,
  p: { interval: BillingInterval; baseUrl: string; now?: Date }): Promise<string> {
  const info = await checkoutInfo(db, ctx);
  if (info.subscribed) throw new UserFacingError("The firm already has a subscription. Use Manage billing to change it.");
  const customer = await ensureCustomer(db, ctx, cfg, info);
  const now = (p.now ?? new Date()).getTime() / 1000;
  const trialEnd = info.trial_ends_at ? Math.floor(new Date(info.trial_ends_at).getTime() / 1000) : null;
  const session = await createCheckoutSession(cfg, {
    customer, firmId: info.firm_id,
    price: p.interval === "year" ? cfg.priceYearly : cfg.priceMonthly,
    quantity: Number(info.seats_used),
    // Subscribing during the trial keeps the rest of the trial free.
    trialEnd: trialEnd !== null && trialEnd - now >= MIN_TRIAL_CARRYOVER_SECONDS ? trialEnd : undefined,
    successUrl: `${p.baseUrl}/subscription?checkout=done`,
    cancelUrl: `${p.baseUrl}/subscription`,
  });
  if (!isStripePage(session.url, STRIPE_CHECKOUT_ORIGIN)) throw new Error("Stripe returned an unexpected checkout address");
  return session.url;
}

/** Opens Stripe's customer portal (card, invoices, switching monthly/yearly, cancelling). Returns Stripe's page. */
export async function openPortal(db: HuisDb, ctx: RequestContext, cfg: StripeConfig, p: { baseUrl: string }): Promise<string> {
  const info = await checkoutInfo(db, ctx);
  if (!info.stripe_customer_id) throw new UserFacingError("The firm doesn't have a billing account yet. Subscribe first.");
  const session = await createPortalSession(cfg, { customer: info.stripe_customer_id, returnUrl: `${p.baseUrl}/subscription` });
  if (!isStripePage(session.url, STRIPE_PORTAL_ORIGIN)) throw new Error("Stripe returned an unexpected portal address");
  return session.url;
}

// ---------------------------------------------------------------------------
// Stripe's notifications
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUB_ID = /^sub_[A-Za-z0-9]{1,255}$/;
const LIVE = new Set(["active", "trialing", "past_due"]);

/** The notifications Huis acts on. Anything else is acknowledged and ignored. */
export const HANDLED_EVENTS = new Set([
  "checkout.session.completed",
  "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted",
  "customer.subscription.paused", "customer.subscription.resumed",
  "invoice.paid", "invoice.payment_failed",
]);

export interface WebhookResult { status: number; outcome: string }

function subscriptionIdOf(type: string, obj: Record<string, unknown>): string | null {
  let v: unknown = null;
  if (type.startsWith("customer.subscription.")) v = obj.id;
  else if (type === "checkout.session.completed") v = obj.subscription;
  else if (type.startsWith("invoice.")) {
    v = obj.subscription
      ?? (obj.parent as { subscription_details?: { subscription?: unknown } } | undefined)?.subscription_details?.subscription;
  }
  if (v && typeof v === "object" && "id" in v) v = (v as { id: unknown }).id;
  return typeof v === "string" && SUB_ID.test(v) ? v : null;
}

/** Which Huis price the subscription is for, if it is exactly one of them. */
function huisPrice(cfg: StripeConfig, sub: StripeSubscription): { interval: BillingInterval; item: StripeSubscription["items"]["data"][number] } | null {
  const items = sub.items?.data ?? [];
  if (items.length !== 1) return null;
  const item = items[0]!;
  if (item.price?.id === cfg.priceMonthly) return { interval: "month", item };
  if (item.price?.id === cfg.priceYearly) return { interval: "year", item };
  return null;
}

/**
 * Handles one notification from Stripe. `billing` is the webhook's own connection (huis_billing role).
 * Returns the HTTP status for Stripe: 2xx means "don't send it again".
 */
export async function handleStripeWebhook(billing: pg.Pool, cfg: StripeConfig, rawBody: string, signature: string | null,
  nowSeconds?: number): Promise<WebhookResult> {
  if (!verifyStripeSignature(rawBody, signature, cfg.webhookSecret, nowSeconds)) return { status: 400, outcome: "bad signature" };
  let event: { type?: unknown; data?: { object?: unknown } };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { status: 400, outcome: "not JSON" };
  }
  const type = typeof event.type === "string" ? event.type : "";
  const obj = event.data?.object;
  if (!HANDLED_EVENTS.has(type) || !obj || typeof obj !== "object") return { status: 200, outcome: "ignored: not handled" };
  const subId = subscriptionIdOf(type, obj as Record<string, unknown>);
  if (!subId) return { status: 200, outcome: "ignored: no subscription" };

  // Stripe's current state, not the notification's copy (which may be stale, out of order or replayed).
  let sub: StripeSubscription;
  try {
    sub = await getSubscription(cfg, subId);
  } catch (err) {
    if (err instanceof StripeError && err.status === 404) return { status: 200, outcome: "ignored: subscription not found" };
    throw err; // Stripe will retry.
  }
  const firmId = sub.metadata?.firm_id;
  if (typeof firmId !== "string" || !UUID.test(firmId)) return { status: 200, outcome: "ignored: no firm" };
  const price = huisPrice(cfg, sub);
  const periodEnd = price?.item.current_period_end ?? sub.current_period_end;

  const { rows } = await billing.query<{ r: string }>(
    "SELECT huis.billing_apply_subscription($1, $2, $3, $4, $5, $6, $7) AS r",
    [firmId, typeof sub.customer === "string" ? sub.customer : null, sub.id, sub.status, price?.interval ?? null,
     typeof periodEnd === "number" ? new Date(periodEnd * 1000) : null, price !== null],
  );
  const outcome = rows[0]!.r;
  if (outcome.startsWith("ignored")) return { status: 200, outcome };

  if (LIVE.has(sub.status) && price) await correctSeats(billing, cfg, firmId, sub, price.item);
  return { status: 200, outcome };
}

/**
 * Keeps the number of seats Stripe bills equal to the firm's active attorneys and staff.
 * Called after each notification, and after people are added, removed or change role.
 */
async function correctSeats(billing: pg.Pool, cfg: StripeConfig, firmId: string, sub: StripeSubscription,
  item: StripeSubscription["items"]["data"][number]): Promise<void> {
  const r = (await billing.query<{ seats_used: number; stripe_subscription_id: string | null; live: boolean }>(
    "SELECT * FROM huis.billing_firm_seats($1)", [firmId])).rows[0];
  if (!r || !r.live || r.stripe_subscription_id !== sub.id) return;
  const want = Math.max(1, Number(r.seats_used));
  if (item.quantity !== want) await setSubscriptionItemQuantity(cfg, item.id, want);
}

/** After a change to the firm's people: bill the right number of seats. Best effort; the next notification corrects it too. */
export async function syncSeats(billing: pg.Pool, cfg: StripeConfig, firmId: string): Promise<void> {
  const r = (await billing.query<{ stripe_subscription_id: string | null; live: boolean }>(
    "SELECT * FROM huis.billing_firm_seats($1)", [firmId])).rows[0];
  if (!r?.live || !r.stripe_subscription_id) return;
  const sub = await getSubscription(cfg, r.stripe_subscription_id);
  const price = huisPrice(cfg, sub);
  if (!price || sub.metadata?.firm_id !== firmId) return;
  await correctSeats(billing, cfg, firmId, sub, price.item);
}
