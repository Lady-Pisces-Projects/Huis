import Link from "next/link";
import { notFound } from "next/navigation";
import {
  addExpenseAction, addTimeAction, createDraftInvoiceAction, deleteExpenseAction, deleteTimeAction,
} from "../../../../../lib/actions";
import { getFlash, withSession } from "../../../../../lib/server";
import { FlashBanner } from "../../../../../lib/ui";
import { NotFoundError } from "../../../../../src/errors";
import { hours, matterBilling } from "../../../../../src/services/billing";
import { money, showDay, STATUS_LABELS } from "../../../../../lib/billing-ui";
import { getMatter } from "../../../../../src/services/matters";
import { INTERNAL_ROLES } from "../../../../../src/security/permissions";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function MatterBillingPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ f?: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const flash = await getFlash((await searchParams).f);
  const data = await withSession(async (s) => {
    if (!INTERNAL_ROLES.has(s.actor.role)) return null;
    let matter;
    try { matter = await getMatter(s, id); } catch (e) { if (e instanceof NotFoundError) return null; throw e; }
    return { matter, b: await matterBilling(s, id), canWrite: s.actor.role !== "read_only" };
  });
  if (!data) notFound();
  const { matter, b, canWrite } = data;
  const today = new Date().toISOString().slice(0, 10);
  const status = (x: { invoiceId: string | null; invoiceStatus: string | null; billable: boolean }) =>
    !x.billable ? <span className="badge">Not billable</span>
      : x.invoiceId ? <Link className={x.invoiceStatus === "draft" ? "badge walled" : "badge"} href={`/matters/${id}/billing/invoices/${x.invoiceId}`}>{x.invoiceStatus === "draft" ? "On a draft" : "Billed"}</Link>
        : <span className="badge walled">Unbilled</span>;

  return (
    <>
      <p className="notice"><Link href={`/matters/${id}`}>← {matter.title}</Link></p>
      <h1>Billing</h1>
      <p className="sub">Time, expenses and invoices for this Matter. Time is billed in tenths of an hour (6 minutes), rounded up, at the rate in force that day.</p>
      <FlashBanner flash={flash} />

      <div className="grid" style={{ marginBottom: 20 }}>
        <div className="card"><div className="stat">{money(b.unbilled.timeCents + b.unbilled.expenseCents)}</div><div className="stat-label">Unbilled ({hours(b.unbilled.minutes)} h of time, {money(b.unbilled.expenseCents)} expenses)</div></div>
        <div className="card"><div className="stat">{money(b.invoices.filter((i) => i.status === "issued").reduce((a, i) => a + (i.totalCents ?? 0) - i.paidCents, 0))}</div><div className="stat-label">Invoiced and still owed</div></div>
      </div>
      {b.unbilled.missingRates ? (
        <div className="flash error">{b.unbilled.missingRates} unbilled time entr{b.unbilled.missingRates === 1 ? "y has" : "ies have"} no rate, so {b.unbilled.missingRates === 1 ? "it comes" : "they come"} to $0. Billing staff set rates on the <Link href="/billing">Billing</Link> page.</div>
      ) : null}

      {canWrite ? (
        <div className="card">
          <h2>Record time</h2>
          <form action={addTimeAction} className="row">
            <input type="hidden" name="matterId" value={id} />
            <label>Date<input type="date" name="workDate" defaultValue={today} required /></label>
            <label>Hours<input name="duration" placeholder="1.5 or 1:30" required inputMode="decimal" style={{ width: 110 }} /></label>
            <label style={{ flex: "1 1 280px" }}>What was done<input name="description" required maxLength={2000} placeholder="e.g. Draft motion to compel" /></label>
            {b.isManager ? (
              <>
                <label>Who<select name="userId" defaultValue="">{[<option key="" value="">Me</option>, ...b.timekeepers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)]}</select></label>
                <label>Rate (optional)<input name="rate" placeholder="from rate table" inputMode="decimal" style={{ width: 130 }} /></label>
              </>
            ) : null}
            <label className="check"><input type="checkbox" name="billable" defaultChecked /> Billable</label>
            <button type="submit">Record time</button>
          </form>
          <p className="notice">The client sees each description on the invoice. Keep privileged detail out of it.</p>
        </div>
      ) : null}

      <div className="card">
        <h2>Time</h2>
        {b.time.length === 0 ? <p className="notice">No time recorded yet.</p> : (
          <table>
            <thead><tr><th>Date</th><th>Who</th><th>What was done</th><th style={{ textAlign: "right" }}>Hours</th><th style={{ textAlign: "right" }}>Rate</th><th style={{ textAlign: "right" }}>Amount</th><th /></tr></thead>
            <tbody>
              {b.time.map((e) => (
                <tr key={e.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{showDay(e.workDate)}</td>
                  <td>{e.userName}</td>
                  <td>{e.description} {status(e)}</td>
                  <td style={{ textAlign: "right" }}>{hours(e.minutes)}</td>
                  <td style={{ textAlign: "right" }}>{e.rateCents === null ? <span className="notice">none</span> : money(e.rateCents)}</td>
                  <td style={{ textAlign: "right" }}>{e.billable ? money(e.amountCents) : "—"}</td>
                  <td>{canWrite && (e.mine || b.canInvoice) && e.invoiceStatus !== "issued" && e.invoiceStatus !== "paid" ? (
                    <form action={deleteTimeAction}><input type="hidden" name="matterId" value={id} /><input type="hidden" name="entryId" value={e.id} /><button className="secondary" type="submit">Remove</button></form>
                  ) : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {canWrite ? (
        <div className="card">
          <h2>Record an expense</h2>
          <form action={addExpenseAction} className="row">
            <input type="hidden" name="matterId" value={id} />
            <label>Date<input type="date" name="incurredOn" defaultValue={today} required /></label>
            <label style={{ flex: "1 1 280px" }}>What for<input name="description" required maxLength={500} placeholder="e.g. Filing fee" /></label>
            <label>Amount ($)<input name="amount" required inputMode="decimal" placeholder="375.00" style={{ width: 120 }} /></label>
            <label className="check"><input type="checkbox" name="billable" defaultChecked /> Billable</label>
            <button type="submit">Record expense</button>
          </form>
        </div>
      ) : null}

      <div className="card">
        <h2>Expenses</h2>
        {b.expenses.length === 0 ? <p className="notice">No expenses recorded yet.</p> : (
          <table>
            <thead><tr><th>Date</th><th>What for</th><th style={{ textAlign: "right" }}>Amount</th><th /></tr></thead>
            <tbody>
              {b.expenses.map((e) => (
                <tr key={e.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{showDay(e.incurredOn)}</td>
                  <td>{e.description} {status(e)}</td>
                  <td style={{ textAlign: "right" }}>{money(e.amountCents)}</td>
                  <td>{canWrite && (e.mine || b.canInvoice) && e.invoiceStatus !== "issued" && e.invoiceStatus !== "paid" ? (
                    <form action={deleteExpenseAction}><input type="hidden" name="matterId" value={id} /><input type="hidden" name="expenseId" value={e.id} /><button className="secondary" type="submit">Remove</button></form>
                  ) : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Invoices</h2>
        {b.canInvoice ? (
          <form action={createDraftInvoiceAction} className="row" style={{ marginBottom: 12 }}>
            <input type="hidden" name="matterId" value={id} />
            <label>Include work up to<input type="date" name="through" defaultValue={today} /></label>
            <button type="submit">Create a draft invoice from unbilled items</button>
          </form>
        ) : <p className="notice">Billing staff and the Matter&apos;s lead attorney prepare invoices.</p>}
        {b.invoices.length === 0 ? <p className="notice">No invoices yet.</p> : (
          <table>
            <thead><tr><th>Invoice</th><th>Status</th><th>Issued</th><th>Due</th><th style={{ textAlign: "right" }}>Total</th><th style={{ textAlign: "right" }}>Paid</th></tr></thead>
            <tbody>
              {b.invoices.map((i) => (
                <tr key={i.id}>
                  <td><Link href={`/matters/${id}/billing/invoices/${i.id}`}>{i.number ?? "Draft"}</Link></td>
                  <td><span className={i.overdue ? "badge privileged" : i.status === "draft" ? "badge walled" : "badge"}>{i.overdue ? "Overdue" : STATUS_LABELS[i.status]}</span></td>
                  <td>{i.issuedOn ? showDay(i.issuedOn) : "—"}</td>
                  <td>{i.dueOn ? showDay(i.dueOn) : "—"}</td>
                  <td style={{ textAlign: "right" }}>{money(i.totalCents)}</td>
                  <td style={{ textAlign: "right" }}>{money(i.paidCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
