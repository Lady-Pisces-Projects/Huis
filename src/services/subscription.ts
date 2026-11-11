import type { FirmSession } from "../db/tenant";
import { assertCan } from "../security/permissions";

/**
 * Phase 10 part 1: the firm's subscription, seats and usage (numbers only).
 *
 * The limits themselves are enforced by the database (db/migrations/0028_subscriptions.sql) whatever the
 * caller; this reads them for the people who manage the firm's account. Plans, seats and payment dates are
 * set by Stripe (part 2, src/services/stripe-billing.ts) or, for firms invoiced by agreement, by Huis
 * (scripts/operator/set-subscription.ts).
 */
export interface FirmSubscription {
  plan: "trial" | "professional" | "enterprise";
  planName: string;
  /** Per seat per month, in cents; null when priced by agreement. */
  pricePerSeatCents: number | null;
  /** Per seat per year, in cents (two months free); null when there's no yearly price. */
  pricePerSeatYearCents: number | null;
  /** How a Stripe subscription is billed; null when not subscribed through Stripe. */
  billingInterval: "month" | "year" | null;
  /** Stripe's word for the subscription (active, past_due, canceled…); null when not subscribed through Stripe. */
  stripeStatus: string | null;
  /** The firm has a Stripe customer, so the customer portal can open. */
  hasBillingAccount: boolean;
  trialEndsAt: Date | null;
  paidThrough: Date | null;
  seats: { used: number; limit: number | null };
  matters: { used: number; limit: number | null };
  /** Clients, co-counsel and experts: they don't take a seat. */
  externalUsers: number;
  storage: { usedBytes: number; limitBytes: number | null };
  aiQuestions: { usedThisMonth: number; limitPerMonth: number | null };
  /** Why new work is paused, or null when it isn't. */
  paused: string | null;
  /** When the firm's access ended, and when its data will be deleted (30 days later); null while it has access. */
  accessEndedAt: Date | null;
  deleteAfter: Date | null;
  /** Seats × price, per month, in cents (null when priced by agreement). */
  monthlyEstimateCents: number | null;
  /** Whole days left on the trial (0 once it has ended); null when not on the trial. */
  trialDaysLeft: number | null;
}

export async function getSubscription(s: FirmSession): Promise<FirmSubscription> {
  assertCan(s.actor.role, "licenses.view");
  const r = (await s.client.query("SELECT * FROM huis.my_firm_subscription()")).rows[0]!;
  const seatsUsed = Number(r.seats_used);
  const seatLimit = r.seat_limit === null ? null : Number(r.seat_limit);
  const price = r.price_cents_per_seat === null ? null : Number(r.price_cents_per_seat);
  const trialEndsAt = r.trial_ends_at ? new Date(r.trial_ends_at) : null;
  return {
    plan: r.plan, planName: r.plan_name, pricePerSeatCents: price, trialEndsAt,
    pricePerSeatYearCents: r.price_cents_per_seat_year === null ? null : Number(r.price_cents_per_seat_year),
    billingInterval: r.billing_interval ?? null,
    stripeStatus: r.stripe_status ?? null,
    hasBillingAccount: Boolean(r.has_billing_account),
    matters: { used: Number(r.matters_used), limit: r.matter_limit === null ? null : Number(r.matter_limit) },
    accessEndedAt: r.access_ended_at ? new Date(r.access_ended_at) : null,
    deleteAfter: r.delete_after ? new Date(r.delete_after) : null,
    paidThrough: r.paid_through ? new Date(r.paid_through) : null,
    seats: { used: seatsUsed, limit: seatLimit },
    externalUsers: Number(r.external_users),
    storage: { usedBytes: Number(r.storage_used_bytes), limitBytes: r.storage_limit_bytes === null ? null : Number(r.storage_limit_bytes) },
    aiQuestions: { usedThisMonth: Number(r.ai_questions_used), limitPerMonth: r.ai_questions_per_month === null ? null : Number(r.ai_questions_per_month) },
    paused: r.write_block ?? null,
    // A paid plan bills its purchased seats (or the seats in use when none are set); the trial is free.
    monthlyEstimateCents: price === null ? null : price * (r.plan === "trial" ? 0 : (seatLimit ?? seatsUsed)),
    trialDaysLeft: r.plan === "trial" && trialEndsAt
      ? Math.max(0, Math.ceil((trialEndsAt.getTime() - Date.now()) / 86_400_000)) : null,
  };
}

/** When the caller's firm's data will be deleted (firm staff only; null for others, or while the firm has access). */
export async function deletionDate(s: FirmSession): Promise<Date | null> {
  const d = (await s.client.query<{ d: Date | null }>("SELECT huis.my_firm_delete_after() AS d")).rows[0]?.d;
  return d ? new Date(d) : null;
}

/** Why new work is paused for the caller's firm (everyone in the firm may know), or null. */
export async function pausedReason(s: FirmSession): Promise<string | null> {
  return (await s.client.query<{ r: string | null }>("SELECT huis.my_firm_write_block() AS r")).rows[0]?.r ?? null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatDollars(cents: number): string {
  // "-$6,409.50", not "$-6,409.50".
  const a = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}$${(a / 100).toLocaleString("en-US", { minimumFractionDigits: a % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}
