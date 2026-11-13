import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "../../../../lib/admin";
import { adminSetAgreementAction, adminSetStatusAction, adminSetTrialEndAction } from "../../../../lib/admin-actions";
import { getFlash } from "../../../../lib/server";
import { date, formatBytes } from "../../../../lib/ui";
import { standing, TONE } from "../../../../src/admin/standing";
import { getFirm } from "../../../../src/services/admin";

export const dynamic = "force-dynamic";

const ACTIONS: Record<string, string> = {
  "subscription.changed": "Plan or account changed", "billing.account_created": "Stripe billing account created",
  "trial.set_end": "Trial end set", "firm.set_status": "Account status set", "plan.set_agreement": "Plan set by agreement",
};
// The date as Utah sees it (YYYY-MM-DD), for the date fields.
const iso = (d: Date | null) => (d ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(d) : "");

/** One firm's account, for Huis staff: fields and counts, its account history, and the changes staff can make. */
export default async function AdminFirmPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ f?: string }> }) {
  const { id } = await params;
  const { platform } = await requireStaff();
  const got = await getFirm(platform, id);
  if (!got) notFound();
  const flash = await getFlash((await searchParams).f);
  const { firm: f, history } = got;
  const s = standing(f);
  // Same rule as huis.platform_stripe_live (security review 30): any subscription Stripe could still restart.
  const stripeLive = f.stripeStatus !== null && !["canceled", "incomplete_expired"].includes(f.stripeStatus);
  const row = (k: string, v: React.ReactNode) => <tr><th style={{ width: 220 }}>{k}</th><td>{v}</td></tr>;
  return (
    <main style={{ maxWidth: 1000, margin: "0 auto", padding: "24px 16px" }}>
      <p><Link href="/admin">← All firms</Link></p>
      <h1 style={{ marginBottom: 4 }}>{f.name}</h1>
      <p style={{ color: TONE[s.tone], fontWeight: 600, marginTop: 0 }}>{s.label}</p>
      {flash ? <div className={`flash ${flash.kind}`} role="status">{flash.message}</div> : null}

      <div className="card" style={{ overflowX: "auto" }}>
        <table><tbody>
          {row("Owner", <>{f.ownerName ?? "—"} {f.ownerEmail ? <span className="notice">· {f.ownerEmail}</span> : null}</>)}
          {row("Address in Huis", `${f.slug} · ${f.stateCode}`)}
          {row("Started", date(f.createdAt))}
          {row("Plan", `${f.plan}${f.billingInterval ? ` (${f.billingInterval === "year" ? "yearly" : "monthly"})` : ""}`)}
          {f.plan === "trial" && f.trialEndsAt ? row("Trial ends", date(f.trialEndsAt)) : null}
          {f.paidThrough ? row(f.stripeStatus ? "Renews" : "Paid through", date(f.paidThrough)) : null}
          {row("Stripe", f.stripeStatus ?? (f.hasStripeCustomer ? "Customer created, no subscription" : "Not used"))}
          {row("First payment", f.firstPaidAt ? date(f.firstPaidAt) : "Not yet (deleted 30 days after an unpaid trial ends)")}
          {f.deleteAfter ? row("Deletion date", <strong style={{ color: TONE.bad }}>{date(f.deleteAfter)}</strong>) : null}
          {f.writeBlock ? row("What the firm sees", f.writeBlock) : null}
          {row("Seats", `${f.seatsUsed}${f.seatLimit !== null ? ` of ${f.seatLimit}` : " (no limit)"} · ${f.externalUsers} outside users (free)`)}
          {row("Matters", f.matters)}
          {row("Evidence stored", formatBytes(f.storageBytes))}
          {row(f.plan === "trial" ? "AI questions (trial)" : "AI questions this month", f.aiQuestions)}
        </tbody></table>
      </div>

      <h2>Change this account</h2>
      <p className="notice">Every change needs a note and is recorded with your name, in this firm&apos;s own audit log and in the Huis staff log.</p>
      <div className="grid">
        {f.plan === "trial" ? (
          <form action={adminSetTrialEndAction} className="card">
            <h3>Trial end</h3>
            <input type="hidden" name="firmId" value={f.firmId} />
            <label htmlFor="trialEnds">New end date (end of that day, Utah time)</label>
            <input id="trialEnds" name="trialEnds" type="date" required min={iso(new Date())} defaultValue={iso(f.trialEndsAt)} />
            <label htmlFor="trialNote">Note</label>
            <input id="trialNote" name="note" required maxLength={500} placeholder="e.g. Extended for a demo with the partners" />
            {stripeLive ? <p className="flash error">This firm has a Stripe subscription. Change its trial in Stripe instead.</p> : null}
            <button type="submit" disabled={stripeLive}>Set trial end</button>
          </form>
        ) : null}
        <form action={adminSetStatusAction} className="card">
          <h3>{f.status === "active" ? "Suspend account" : "Restore account"}</h3>
          <input type="hidden" name="firmId" value={f.firmId} />
          <input type="hidden" name="status" value={f.status === "active" ? "suspended" : "active"} />
          <p className="notice">{f.status === "active" ? stripeLive ? "Everyone can still sign in, open and export; adding new work stops. Stripe keeps charging: pause or cancel the subscription in Stripe if billing should stop too." : "Everyone can still sign in, open and export; adding new work stops. The plan stays as it is." : "Restores the firm's access as its plan allows."}</p>
          <label htmlFor="statusNote">Note</label>
          <input id="statusNote" name="note" required maxLength={500} />
          <button type="submit" className={f.status === "active" ? "danger" : undefined}>{f.status === "active" ? "Suspend" : "Restore"}</button>
        </form>
        <form action={adminSetAgreementAction} className="card">
          <h3>Plan by agreement</h3>
          <input type="hidden" name="firmId" value={f.firmId} />
          {stripeLive ? <p className="flash error">This firm has a Stripe subscription that could still charge. Cancel it in Stripe first.</p> : null}
          <label htmlFor="plan">Plan</label>
          <select id="plan" name="plan" defaultValue={f.plan === "enterprise" ? "enterprise" : "professional"}>
            <option value="professional">Professional</option><option value="enterprise">Enterprise</option>
          </select>
          <label htmlFor="seats">Seats (blank: no limit)</label>
          <input id="seats" name="seats" type="number" min={1} max={10000} defaultValue={f.seatLimit ?? ""} />
          <label htmlFor="paidThrough">Paid through</label>
          <input id="paidThrough" name="paidThrough" type="date" required defaultValue={iso(f.paidThrough)} />
          <label htmlFor="agreementNote">Note</label>
          <input id="agreementNote" name="note" required maxLength={500} placeholder="e.g. Annual invoice 1001" />
          <button type="submit" disabled={stripeLive}>Set plan</button>
        </form>
      </div>

      <h2>Account history</h2>
      <div className="card" style={{ overflowX: "auto", padding: 0 }}>
        <table>
          <thead><tr><th>When</th><th>What</th><th>By</th><th>Note</th></tr></thead>
          <tbody>
            {history.map((h, i) => (
              <tr key={i}><td>{date(h.at)}</td><td>{ACTIONS[h.action] ?? h.action}</td><td>{h.byWhom}</td><td>{h.note ?? ""}</td></tr>
            ))}
            {history.length === 0 ? <tr><td colSpan={4} className="notice">No account changes yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </main>
  );
}
