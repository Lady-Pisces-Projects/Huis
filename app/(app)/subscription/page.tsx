import Link from "next/link";
import { notFound } from "next/navigation";
import { withSession } from "../../../lib/server";
import { date } from "../../../lib/ui";
import { can } from "../../../src/security/permissions";
import { formatBytes, formatDollars, getSubscription } from "../../../src/services/subscription";

export const dynamic = "force-dynamic";

/** Phase 10 part 1: the firm's plan, seats and usage, for the people who manage the account. */
export default async function SubscriptionPage() {
  const sub = await withSession(async (s) => (can(s.actor.role, "licenses.view") ? getSubscription(s) : null));
  if (!sub) notFound();
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

  return (
    <>
      <h1>Subscription</h1>
      <p className="sub">Your firm&apos;s plan, seats and usage. Your firm owns its data: whatever happens to the subscription, you can always open and export everything.</p>

      <div className="card">
        <h2>{sub.planName}</h2>
        {sub.plan === "trial" ? (
          <p>{sub.trialDaysLeft ? <>Free trial: <strong>{sub.trialDaysLeft} day{sub.trialDaysLeft === 1 ? "" : "s"}</strong> left</> : "The free trial has ended"}
            {sub.trialEndsAt ? <span className="notice"> · ends {date(sub.trialEndsAt)}</span> : null}.
            {" "}The trial has a few limits (shown below) so nobody can load a whole discovery set for free.</p>
        ) : (
          <p>
            {sub.pricePerSeatCents !== null ? <>{formatDollars(sub.pricePerSeatCents)} per seat per month{sub.monthlyEstimateCents !== null ? <> · <strong>{formatDollars(sub.monthlyEstimateCents)}</strong> a month for {sub.seats.limit ?? sub.seats.used} seat{(sub.seats.limit ?? sub.seats.used) === 1 ? "" : "s"}</> : null}</> : "Priced by agreement with your firm."}
            {sub.paidThrough ? <span className="notice"> · paid through {date(sub.paidThrough)}</span> : null}
          </p>
        )}
        <p className="notice">
          To subscribe, add seats or change plans, contact Huis. Online payment is coming; until then Huis sets up your plan for you.
        </p>
      </div>

      <div className="grid" style={{ marginBottom: 20 }}>
        {meter("Seats in use", String(sub.seats.used), sub.seats.limit === null ? null : String(sub.seats.limit), pct(sub.seats.used, sub.seats.limit),
          `Attorneys and staff take a seat. Clients, co-counsel and experts don't (${sub.externalUsers} now).`)}
        {meter("Evidence stored", formatBytes(sub.storage.usedBytes), sub.storage.limitBytes === null ? null : formatBytes(sub.storage.limitBytes),
          pct(sub.storage.usedBytes, sub.storage.limitBytes))}
        {meter("AI questions this month", String(sub.aiQuestions.usedThisMonth), sub.aiQuestions.limitPerMonth === null ? null : String(sub.aiQuestions.limitPerMonth),
          pct(sub.aiQuestions.usedThisMonth, sub.aiQuestions.limitPerMonth), "Matter Brain and agent questions, counted by calendar month (UTC).")}
      </div>

      <div className="card">
        <h2>If the trial ends or a payment is late</h2>
        <p className="notice">
          Nothing is deleted or hidden. Everyone can still sign in, open Matters and evidence, and export a whole Matter.
          Adding new work (Matters, evidence, AI questions, imports and people) is paused until the subscription is active again.
          A late payment has 7 days&apos; grace first. Manage people on <Link href="/users">Users &amp; Access</Link>.
        </p>
      </div>
    </>
  );
}
