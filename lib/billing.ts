import "server-only";
import pg from "pg";
import { stripeConfig } from "../src/billing/stripe";
import { syncSeats } from "../src/services/stripe-billing";
import { getSession } from "./server";

/**
 * Phase 10 part 2: the Stripe webhook's own database connection. Its login is a member of huis_billing,
 * which can only record Stripe's state for a firm (huis.billing_apply_subscription) and read how many seats
 * to bill. It can't read or change anything else.
 */
const globalForBilling = globalThis as unknown as { huisBillingPool?: pg.Pool };

export function billingPool(): pg.Pool | null {
  const url = process.env.HUIS_BILLING_DATABASE_URL;
  if (!url) return null;
  if (!globalForBilling.huisBillingPool) globalForBilling.huisBillingPool = new pg.Pool({ connectionString: url, max: 4 });
  return globalForBilling.huisBillingPool;
}

/**
 * After someone is added, removed or changes role: bill the right number of seats. Best effort: if Stripe
 * can't be reached the change still stands, and the next notification from Stripe corrects the count.
 */
export async function syncSeatsAfterPeopleChange(): Promise<void> {
  const cfg = stripeConfig();
  const pool = billingPool();
  const session = await getSession();
  if (!cfg || !pool || !session) return;
  try {
    await syncSeats(pool, cfg, session.firmId);
  } catch (err) {
    console.error("[huis] seat count not sent to Stripe:", err instanceof Error ? err.name : "unknown");
  }
}
