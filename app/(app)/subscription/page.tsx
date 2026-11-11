import Link from "next/link";
import { notFound } from "next/navigation";
import { getFlash, withSession } from "../../../lib/server";
import { date } from "../../../lib/ui";
import { openBillingPortalAction, startCheckoutAction } from "../../../lib/actions";
import { stripeConfig } from "../../../src/billing/stripe";
import { can } from "../../../src/security/permissions";
import { formatBytes, formatDollars, getSubscription } from "../../../src/services/subscription";

export const dynamic = "force-dynamic";

const STATUS_WORDS: Record<string, string> = {
  active: "Active", trialing: "Active (rest of the free trial first)", past_due: "Payment due: Stripe is retrying the card",
  canceled: "Cancelled", unpaid: "Unpaid", paused: "Paused", incomplete: "Waiting for the first payment", incomplete_expired: "Not completed",
};

/** Phase 10: the firm's plan, seats and usage, and paying through Stripe (parts 1 and 2). */
export default async function SubscriptionPage({ searchParams }: { searchParams: Promise<{ f?: string; checkout?: string }> }) {
  const sp = await searchParams;
  const sub = await withSession(async (s) => (can(s.actor.role, "licenses.view") ? getSubscription(s) : null));
  if (!sub) notFound();
  const flash = await getFlash(sp.f);
  const online = stripeConfig() !== null;
  const subscribedOnline = sub.stripeStatus !== null && ["active", "trialing", "past_due"].includes(sub.stripeStatus) && !sub.accessEndedAt;
  const pct = (used: number, limit: number | null) => (limit ? Math.min(100, Math.round((used / limit) * 100)) : null);
  const meter = (label: string, used: string, limit: string | null, p: number | null, note?: string) => (
    <div className="card">
      <div className="stat">{used}</div>
      <div className="stat-label">{label}{limit ? ` of ${limit}` : " (no limit)"}</div>
      {p !== null ? (
        <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={p}
          style={{ marginTop: 10, height: 6, borderRadius: 3, background: "#eef1f5" }}>
          <div style={{ width: `${p}%`, height: 6, borderRadius: 3, background: p >= 90 ? "#b42318" : "#1f3557" }} />
        </div>
      ) : null}
      {note ? <p className="notice" style={{ marginTop: 8 }}>{note}</p> : null}
    </div>
  );
  const seatsBilled = Math.max(1, sub.seats.used);
  // What subscribing costs comes from the Professional plan (on the trial, the firm's own plan price is $0).
  const monthly = sub.subscribePrices.monthCents ?? 23700;
  const yearly = sub.subscribePrices.yearCents ?? 237000;

  return (
    <>
      <h1>Subscription</h1>
      <p className="sub">Your firm&apos;s plan, seats and usage.</p>
      {flash ? <div className={`flash ${flash.kind}`} role="status">{flash.message}</div> : null}
      {sp.checkout === "done" && !subscribedOnline ? (
        <div className="flash success" role="status">Thank you. Stripe is confirming the payment; this page updates within a minute or two.</div>
      ) : null}

      {sub.deleteAfter ? (
        <div className="card" style={{ borderColor: "#b42318" }}>
          <h2>Your files will be deleted on {date(sub.deleteAfter)}</h2>
          <p>The free trial ended on {date(sub.accessEndedAt!)} without a first payment. Until {date(sub.deleteAfter)}, everyone can still sign in,
            open and export every Matter. After that date the firm&apos;s files and data are permanently deleted. Subscribing before then keeps everything.</p>
        </div>
      ) : null}

      <div className="card">
        <h2>{sub.planName}</h2>
        {sub.plan === "trial" ? (
          <p>{sub.trialDaysLeft ? <>Free trial: <strong>{sub.trialDaysLeft} day{sub.trialDaysLeft === 1 ? "" : "s"}</strong> left</> : "The free trial has ended"}
            {sub.trialEndsAt ? <span className="notice"> · ends {date(sub.trialEndsAt)}</span> : null}.
            {" "}The trial includes 1 seat, 1 Matter, 2 GB of evidence and 100 AI questions. No card is needed.</p>
        ) : (
          <p>
            {sub.billingInterval === "year"
              ? <>{formatDollars(yearly)} per seat per year</>
              : sub.pricePerSeatCents !== null ? <>{formatDollars(sub.pricePerSeatCents)} per seat per month</> : "Priced by agreement with your firm."}
            {sub.stripeStatus ? <> · <strong>{STATUS_WORDS[sub.stripeStatus] ?? sub.stripeStatus}</strong></> : null}
            {sub.paidThrough && !sub.accessEndedAt ? <span className="notice"> · {sub.stripeStatus ? "renews" : "paid through"} {date(sub.paidThrough)}</span> : null}
          </p>
        )}

        {online && !subscribedOnline ? (
          <>
            <p>Choose how to pay. You&apos;ll be billed for {seatsBilled} seat{seatsBilled === 1 ? "" : "s"} (your attorneys and staff); clients, co-counsel and experts are free.
              {sub.plan === "trial" && sub.trialDaysLeft && sub.trialDaysLeft > 2 ? " Subscribing now keeps the rest of your free trial free." : ""}</p>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <form action={startCheckoutAction}>
                <input type="hidden" name="interval" value="month" />
                <button type="submit">Choose Monthly · {formatDollars(monthly)} per seat</button>
              </form>
              <form action={startCheckoutAction}>
                <input type="hidden" name="interval" value="year" />
                <button type="submit">Choose Yearly · {formatDollars(yearly)} per seat (2 months free)</button>
              </form>
            </div>
            <p className="notice" style={{ marginTop: 8 }}>Payment is taken on Stripe&apos;s secure page. Huis never sees your card number. Have a founding-member code? Enter it on that page.</p>
          </>
        ) : null}
        {online && sub.hasBillingAccount ? (
          <form action={openBillingPortalAction} style={{ marginTop: 12 }}>
            <button type="submit" className="secondary">Manage billing (card, invoices, monthly or yearly, cancel)</button>
          </form>
        ) : null}
        {!online ? <p className="notice">Online payment isn&apos;t set up yet. Contact Huis to subscribe.</p> : null}
      </div>

      <div className="grid" style={{ marginBottom: 20 }}>
        {meter("Seats in use", String(sub.seats.used), sub.seats.limit === null ? null : String(sub.seats.limit), pct(sub.seats.used, sub.seats.limit),
          `Attorneys and staff take a seat. Clients, co-counsel and experts don't (${sub.externalUsers} now).`)}
        {meter("Matters", String(sub.matters.used), sub.matters.limit === null ? null : String(sub.matters.limit), pct(sub.matters.used, sub.matters.limit))}
        {meter("Evidence stored", formatBytes(sub.storage.usedBytes), sub.storage.limitBytes === null ? null : formatBytes(sub.storage.limitBytes),
          pct(sub.storage.usedBytes, sub.storage.limitBytes))}
        {meter(sub.plan === "trial" ? "AI questions during the trial" : "AI questions this month", String(sub.aiQuestions.usedThisMonth),
          sub.aiQuestions.limitPerMonth === null ? null : String(sub.aiQuestions.limitPerMonth),
          pct(sub.aiQuestions.usedThisMonth, sub.aiQuestions.limitPerMonth),
          "A question is one you type to Matter Brain or an AI agent. Everything Huis does by itself is free and unlimited: reading and searching files, the timeline, Case DNA suggestions, reading your case description, and analysis.")}
      </div>

      <div className="card">
        <h2>If the trial ends, or the subscription stops</h2>
        <p className="notice">
          <strong>If the free trial ends before a first payment</strong> (including if you subscribed during the trial but cancelled, or the first charge failed): adding new work pauses, and for 30 days everyone can still sign in, open
          and export everything. After those 30 days the firm&apos;s files and data are permanently deleted.
        </p>
        <p className="notice">
          <strong>Once your firm has made its first payment, Huis never deletes its cases for non-payment.</strong> If the subscription stops, adding new work
          pauses, and your Matters and information are kept, ready to open and export, until you subscribe again. A late card payment has
          7 days&apos; grace while Stripe retries it. Manage people on <Link href="/users">Users &amp; Access</Link>.
        </p>
      </div>
    </>
  );
}
