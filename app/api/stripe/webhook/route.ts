import { NextResponse } from "next/server";
import { stripeConfig } from "../../../../src/billing/stripe";
import { handleStripeWebhook } from "../../../../src/services/stripe-billing";
import { billingPool } from "../../../../lib/billing";

export const dynamic = "force-dynamic";

/** Stripe's raw body is far smaller than this; anything bigger isn't from Stripe. */
const MAX_BODY_BYTES = 512 * 1024;

/** Reads the body a piece at a time and stops at the limit (security review 27, R27-5), so nobody can make the server hold an unbounded body. */
async function readCapped(req: Request): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Phase 10 part 2: notifications from Stripe about the firm's subscription.
 * Signature-checked over the exact body; the subscription's current state is then fetched from Stripe.
 */
export async function POST(req: Request) {
  const cfg = stripeConfig();
  const pool = billingPool();
  if (!cfg || !pool) return new NextResponse("Online payment is not configured.", { status: 503 });
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return new NextResponse("Too large", { status: 413 });
  const raw = await readCapped(req);
  if (raw === null) return new NextResponse("Too large", { status: 413 });
  try {
    const result = await handleStripeWebhook(pool, cfg, raw, req.headers.get("stripe-signature"));
    return NextResponse.json({ received: result.status < 300 }, { status: result.status });
  } catch (err) {
    // Stripe retries on any 5xx; the error itself stays in the server log.
    console.error("[huis] Stripe notification failed:", err instanceof Error ? err.name : "unknown");
    return new NextResponse("Try again", { status: 500 });
  }
}
