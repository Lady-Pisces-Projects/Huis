import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Phase 10 part 2: the few Stripe calls Huis makes, over Stripe's REST API.
 *
 * Huis never handles card numbers: people pay on Stripe's own checkout page and manage their card,
 * invoices and cancellation in Stripe's customer portal. Huis only creates those pages, reads a
 * subscription's current state, and sets how many seats a subscription bills.
 */
export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  priceMonthly: string;
  priceYearly: string;
  /** Stripe's API address. Only tests change it (to a stand-in for Stripe). */
  apiBase: string;
}

export function stripeConfig(env: NodeJS.ProcessEnv = process.env): StripeConfig | null {
  const { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_MONTHLY, STRIPE_PRICE_YEARLY } = env;
  if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET || !STRIPE_PRICE_MONTHLY || !STRIPE_PRICE_YEARLY) return null;
  return {
    secretKey: STRIPE_SECRET_KEY, webhookSecret: STRIPE_WEBHOOK_SECRET,
    priceMonthly: STRIPE_PRICE_MONTHLY, priceYearly: STRIPE_PRICE_YEARLY,
    apiBase: env.HUIS_STRIPE_API_BASE ?? "https://api.stripe.com",
  };
}

/** Where people may be sent: only Stripe's own pages. */
export const STRIPE_CHECKOUT_ORIGIN = "https://checkout.stripe.com";
export const STRIPE_PORTAL_ORIGIN = "https://billing.stripe.com";

export function isStripePage(url: unknown, origin: string): url is string {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return u.origin === origin && u.protocol === "https:";
  } catch {
    return false;
  }
}

export class StripeError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

type Params = Record<string, string | number | boolean | undefined>;

async function call<T>(cfg: StripeConfig, method: "GET" | "POST", path: string, params: Params = {}, idempotencyKey?: string): Promise<T> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) body.append(k, String(v));
  const url = new URL(path, cfg.apiBase);
  if (method === "GET") for (const [k, v] of body) url.searchParams.append(k, v);
  const headers: Record<string, string> = {
    authorization: `Bearer ${cfg.secretKey}`,
    "content-type": "application/x-www-form-urlencoded",
  };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  const res = await fetch(url, {
    method, headers, body: method === "POST" ? body.toString() : undefined,
    signal: AbortSignal.timeout(20_000), redirect: "error",
  });
  const text = await res.text();
  if (!res.ok) {
    // Stripe's error message only (never the key or the request).
    let msg = `Stripe request failed (${res.status})`;
    try { msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? msg; } catch { /* keep the generic message */ }
    throw new StripeError(msg, res.status);
  }
  return JSON.parse(text) as T;
}

// Stripe ids are opaque, but always of this shape; anything else is refused before it reaches a URL.
const ID = /^[a-z]{2,8}_[A-Za-z0-9]{1,255}$/;
function id(prefix: string, v: string): string {
  if (!ID.test(v) || !v.startsWith(`${prefix}_`)) throw new StripeError(`Unexpected Stripe id`, 400);
  return v;
}

export interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  metadata: Record<string, string>;
  items: { data: { id: string; quantity?: number; current_period_end?: number; price: { id: string; recurring?: { interval?: string } | null } }[] };
  /** Older API versions put the period on the subscription; newer ones on each item. */
  current_period_end?: number;
}

export function createCustomer(cfg: StripeConfig, p: { firmId: string; firmName: string; email?: string }) {
  return call<{ id: string }>(cfg, "POST", "/v1/customers", {
    name: p.firmName.slice(0, 250), email: p.email, "metadata[firm_id]": p.firmId,
  }, `huis-customer-${p.firmId}`);
}

export function createCheckoutSession(cfg: StripeConfig, p: {
  customer: string; firmId: string; price: string; quantity: number; trialEnd?: number; successUrl: string; cancelUrl: string;
}) {
  return call<{ id: string; url: string }>(cfg, "POST", "/v1/checkout/sessions", {
    mode: "subscription",
    customer: id("cus", p.customer),
    client_reference_id: p.firmId,
    "line_items[0][price]": p.price,
    "line_items[0][quantity]": Math.max(1, p.quantity),
    "subscription_data[metadata][firm_id]": p.firmId,
    "subscription_data[trial_end]": p.trialEnd,
    allow_promotion_codes: true,
    success_url: p.successUrl,
    cancel_url: p.cancelUrl,
  });
}

export function createPortalSession(cfg: StripeConfig, p: { customer: string; returnUrl: string }) {
  return call<{ id: string; url: string }>(cfg, "POST", "/v1/billing_portal/sessions", {
    customer: id("cus", p.customer), return_url: p.returnUrl,
  });
}

export function getSubscription(cfg: StripeConfig, subscriptionId: string) {
  return call<StripeSubscription>(cfg, "GET", `/v1/subscriptions/${id("sub", subscriptionId)}`);
}

/** Bills `quantity` seats from now on; Stripe prorates the difference. */
export function setSubscriptionItemQuantity(cfg: StripeConfig, itemId: string, quantity: number) {
  return call<{ id: string; quantity: number }>(cfg, "POST", `/v1/subscription_items/${id("si", itemId)}`, {
    quantity: Math.max(1, quantity), proration_behavior: "create_prorations",
  });
}

/**
 * Checks Stripe's signature over the exact body it sent (header `Stripe-Signature: t=…,v1=…`).
 * Refuses anything older or newer than `toleranceSeconds`, so a captured notification can't be replayed.
 */
export function verifyStripeSignature(rawBody: string, header: string | null, secret: string,
  nowSeconds = Math.floor(Date.now() / 1000), toleranceSeconds = 300): boolean {
  if (!header || !secret) return false;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2).map((x) => x?.trim());
    if (k === "t" && v && /^\d{1,12}$/.test(v)) timestamp = Number(v);
    else if (k === "v1" && v && /^[0-9a-f]{64}$/.test(v)) signatures.push(v);
  }
  if (timestamp === null || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest();
  return signatures.some((s) => {
    const given = Buffer.from(s, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

export function signStripePayload(rawBody: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const sig = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
  return `t=${timestamp},v1=${sig}`;
}
