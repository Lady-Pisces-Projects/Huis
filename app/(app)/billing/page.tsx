import Link from "next/link";
import { notFound } from "next/navigation";
import { removeRateAction, setRateAction } from "../../../lib/actions";
import { money, showDay, STATUS_LABELS } from "../../../lib/billing-ui";
import { getFlash, withSession } from "../../../lib/server";
import { FlashBanner } from "../../../lib/ui";
import { BILLING_MANAGERS, billingOverview, listRates } from "../../../src/services/billing";
import { INTERNAL_ROLES } from "../../../src/security/permissions";

export const dynamic = "force-dynamic";

/** Phase 10 part 3: the firm's billing at a glance, and billing rates. */
export default async function BillingPage({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  const flash = await getFlash((await searchParams).f);
  const data = await withSession(async (s) => {
    if (!INTERNAL_ROLES.has(s.actor.role)) return null;
    const manager = BILLING_MANAGERS.has(s.actor.role);
    const people = manager
      ? (await s.client.query("SELECT id, full_name FROM huis.users WHERE status = 'active' AND huis.is_internal_role(role) ORDER BY full_name")).rows
      : [];
    const matters = manager ? (await s.client.query("SELECT id, title FROM huis.matters WHERE status <> 'archived' ORDER BY title LIMIT 500")).rows : [];
    return { o: await billingOverview(s), rates: await listRates(s), manager, people, matters };
  });
  if (!data) notFound();
  const { o, rates, manager, people, matters } = data;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <h1>Billing</h1>
      <p className="sub">Unbilled work, invoices and money owed across the Matters you can see. Record time and invoice on each Matter&apos;s Billing page.</p>
      <FlashBanner flash={flash} />
      <div className="grid" style={{ marginBottom: 20 }}>
        <div className="card"><div className="stat">{money(o.unbilledCents)}</div><div className="stat-label">Unbilled time and expenses</div></div>
        <div className="card"><div className="stat">{money(o.outstandingCents)}</div><div className="stat-label">Invoiced and still owed</div></div>
        <div className="card"><div className="stat" style={o.overdueCents ? { color: "#b42318" } : undefined}>{money(o.overdueCents)}</div><div className="stat-label">Overdue</div></div>
      </div>

      <div className="card">
        <h2>Invoices awaiting payment</h2>
        {o.outstanding.length === 0 ? <p className="notice">Nothing is owed right now.</p> : (
          <table>
            <thead><tr><th>Invoice</th><th>Matter</th><th>Client</th><th>Due</th><th style={{ textAlign: "right" }}>Still owed</th></tr></thead>
            <tbody>
              {o.outstanding.map((i) => (
                <tr key={i.id}>
                  <td><Link href={`/matters/${i.matterId}/billing/invoices/${i.id}`}>{i.number}</Link></td>
                  <td>{i.matterTitle}</td><td>{i.clientName}</td>
                  <td>{i.dueOn ? showDay(i.dueOn) : ""} {i.overdue ? <span className="badge privileged">Overdue</span> : null}</td>
                  <td style={{ textAlign: "right" }}>{money((i.totalCents ?? 0) - i.paidCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="grid" style={{ marginBottom: 20 }}>
        <div className="card">
          <h2>Draft invoices</h2>
          {o.drafts.length === 0 ? <p className="notice">No drafts.</p> : (
            <table><tbody>
              {o.drafts.map((i) => (
                <tr key={i.id}><td><Link href={`/matters/${i.matterId}/billing/invoices/${i.id}`}>{STATUS_LABELS.draft}</Link></td><td>{i.matterTitle}</td></tr>
              ))}
            </tbody></table>
          )}
        </div>
        <div className="card">
          <h2>Unbilled, by Matter</h2>
          {o.unbilled.length === 0 ? <p className="notice">Nothing unbilled.</p> : (
            <table><tbody>
              {o.unbilled.slice(0, 50).map((u) => (
                <tr key={u.matterId}><td><Link href={`/matters/${u.matterId}/billing`}>{u.title}</Link></td><td style={{ textAlign: "right" }}>{money(u.cents)}</td></tr>
              ))}
            </tbody></table>
          )}
        </div>
      </div>

      <div className="card">
        <h2>{manager ? "Billing rates" : "Your billing rate"}</h2>
        <p className="notice">Hourly rates. A rate for one Matter beats the person&apos;s standard rate; a rate applies from its date. Time keeps the rate in force when it was recorded.{manager ? "" : " Billing staff set rates."}</p>
        {manager ? (
          <form action={setRateAction} className="row" style={{ marginBottom: 12 }}>
            <label>Person<select name="userId" required>{people.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</select></label>
            <label>Matter (optional)<select name="matterId" defaultValue="">{[<option key="" value="">Standard rate (all Matters)</option>, ...matters.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)]}</select></label>
            <label>Per hour ($)<input name="rate" required inputMode="decimal" placeholder="300.00" style={{ width: 120 }} /></label>
            <label>From<input type="date" name="effectiveFrom" defaultValue={today} required /></label>
            <button type="submit">Save rate</button>
          </form>
        ) : null}
        {rates.length === 0 ? <p className="notice">No rates yet.</p> : (
          <table>
            <thead><tr><th>Person</th><th>Applies to</th><th>From</th><th style={{ textAlign: "right" }}>Per hour</th>{manager ? <th /> : null}</tr></thead>
            <tbody>
              {rates.map((r) => (
                <tr key={r.id}>
                  <td>{r.userName}</td><td>{r.matterId ? (r.matterTitle ?? <span className="notice">A Matter you can&apos;t see</span>) : "Standard rate"}</td><td>{showDay(r.effectiveFrom)}</td><td style={{ textAlign: "right" }}>{money(r.rateCents)}</td>
                  {manager ? <td><form action={removeRateAction}><input type="hidden" name="rateId" value={r.id} /><button className="secondary" type="submit">Remove</button></form></td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
