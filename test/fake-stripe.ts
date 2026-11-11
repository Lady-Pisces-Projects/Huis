import http from "node:http";
import type { AddressInfo } from "node:net";
import { signStripePayload, type StripeConfig } from "../src/billing/stripe";

// ---------------------------------------------------------------------------
// A stand-in for Stripe's API (no real money, cards or customers).
// ---------------------------------------------------------------------------
export interface FakeSub {
  id: string;
  customer: string;
  status: string;
  metadata: Record<string, string>;
  items: { data: { id: string; quantity: number; current_period_end: number; price: { id: string } }[] };
}

export const PRICE_MONTHLY = "price_HuisMonthly";
export const PRICE_YEARLY = "price_HuisYearly";
export const WEBHOOK_SECRET = "whsec_testsecret";

export class FakeStripe {
  server!: http.Server;
  base = "";
  customers: { id: string; params: Record<string, string>; idem?: string }[] = [];
  checkouts: Record<string, string>[] = [];
  portals: Record<string, string>[] = [];
  subscriptions: Record<string, FakeSub> = {};
  quantityUpdates: { item: string; quantity: number }[] = [];
  calls: { method: string; path: string; auth?: string }[] = [];
  /** Return this address instead of Stripe's own pages (to test Huis refusing it). */
  checkoutUrl = "https://checkout.stripe.com/c/pay/cs_test_123";
  portalUrl = "https://billing.stripe.com/p/session/test_123";
  failSubscriptionFetch: number | null = null;
  private n = 0;

  async start() {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop() {
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  config(): StripeConfig {
    return { secretKey: "sk_test_fake", webhookSecret: WEBHOOK_SECRET, priceMonthly: PRICE_MONTHLY, priceYearly: PRICE_YEARLY, apiBase: this.base };
  }

  /** Adds a subscription as Stripe would hold it after checkout. */
  addSubscription(p: { firmId: string; customer: string; status?: string; price?: string; quantity?: number; periodEnd?: number }): FakeSub {
    this.n += 1;
    const sub: FakeSub = {
      id: `sub_Test${this.n}`, customer: p.customer, status: p.status ?? "active", metadata: { firm_id: p.firmId },
      items: { data: [{ id: `si_Test${this.n}`, quantity: p.quantity ?? 1,
        current_period_end: p.periodEnd ?? Math.floor(Date.now() / 1000) + 30 * 86400, price: { id: p.price ?? PRICE_MONTHLY } }] },
    };
    this.subscriptions[sub.id] = sub;
    return sub;
  }

  /** A signed notification, as Stripe would send it. */
  event(type: string, object: Record<string, unknown>, opts: { secret?: string; timestamp?: number } = {}) {
    const body = JSON.stringify({ id: `evt_${++this.n}`, type, data: { object } });
    return { body, signature: signStripePayload(body, opts.secret ?? WEBHOOK_SECRET, opts.timestamp) };
  }

  private json(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url!, this.base);
    const raw = await new Promise<string>((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d)); });
    const params = Object.fromEntries(new URLSearchParams(raw));
    this.calls.push({ method: req.method!, path: url.pathname, auth: req.headers.authorization });
    if (req.headers.authorization !== "Bearer sk_test_fake") return this.json(res, 401, { error: { message: "Invalid API key" } });

    if (req.method === "POST" && url.pathname === "/v1/customers") {
      const idem = req.headers["idempotency-key"] as string | undefined;
      const existing = idem ? this.customers.find((c) => c.idem === idem) : undefined;
      if (existing) return this.json(res, 200, { id: existing.id });
      const c = { id: `cus_Test${++this.n}`, params, idem };
      this.customers.push(c);
      return this.json(res, 200, { id: c.id });
    }
    if (req.method === "POST" && url.pathname === "/v1/checkout/sessions") {
      this.checkouts.push(params);
      return this.json(res, 200, { id: "cs_test_123", url: this.checkoutUrl });
    }
    if (req.method === "POST" && url.pathname === "/v1/billing_portal/sessions") {
      this.portals.push(params);
      return this.json(res, 200, { id: "bps_123", url: this.portalUrl });
    }
    const subMatch = url.pathname.match(/^\/v1\/subscriptions\/(sub_[A-Za-z0-9]+)$/);
    if (req.method === "GET" && subMatch) {
      if (this.failSubscriptionFetch) return this.json(res, this.failSubscriptionFetch, { error: { message: "unavailable" } });
      const sub = this.subscriptions[subMatch[1]!];
      return sub ? this.json(res, 200, { object: "subscription", ...sub }) : this.json(res, 404, { error: { message: "No such subscription" } });
    }
    const itemMatch = url.pathname.match(/^\/v1\/subscription_items\/(si_[A-Za-z0-9]+)$/);
    if (req.method === "POST" && itemMatch) {
      const q = Number(params.quantity);
      this.quantityUpdates.push({ item: itemMatch[1]!, quantity: q });
      for (const s of Object.values(this.subscriptions)) for (const it of s.items.data) if (it.id === itemMatch[1]) it.quantity = q;
      return this.json(res, 200, { id: itemMatch[1], quantity: q });
    }
    return this.json(res, 404, { error: { message: "Unknown endpoint" } });
  }
}
