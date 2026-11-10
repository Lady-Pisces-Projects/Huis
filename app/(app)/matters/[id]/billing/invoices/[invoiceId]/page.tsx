import Link from "next/link";
import { notFound } from "next/navigation";
import {
  deleteDraftInvoiceAction, issueInvoiceAction, recordPaymentAction, removeFromDraftAction, updateDraftNotesAction, voidInvoiceAction,
} from "../../../../../../../lib/actions";
import { money, showDay, STATUS_LABELS } from "../../../../../../../lib/billing-ui";
import { getFlash, withSession } from "../../../../../../../lib/server";
import { FlashBanner } from "../../../../../../../lib/ui";
import { NotFoundError } from "../../../../../../../src/errors";
import { getInvoice, hours, PAYMENT_METHOD_LABELS, PAYMENT_METHODS } from "../../../../../../../src/services/billing";
import { INTERNAL_ROLES } from "../../../../../../../src/security/permissions";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An invoice: firm staff on the Matter see drafts and act on them; a client on the Matter sees it once issued. */
export default async function InvoicePage({ params, searchParams }: { params: Promise<{ id: string; invoiceId: string }>; searchParams: Promise<{ f?: string }> }) {
  const { id, invoiceId } = await params;
  if (!UUID.test(id) || !UUID.test(invoiceId)) notFound();
  const flash = await getFlash((await searchParams).f);
  const data = await withSession(async (s) => {
    try {
      const inv = await getInvoice(s, invoiceId);
      return inv.matterId === id ? { inv, staff: INTERNAL_ROLES.has(s.actor.role) } : null;
    } catch (e) { if (e instanceof NotFoundError) return null; throw e; }
  });
  if (!data) notFound();
  const { inv, staff } = data;
  const today = new Date().toISOString().slice(0, 10);
  const due30 = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const owed = (inv.totalCents ?? 0) - inv.paidCents;
  const hidden = <><input type="hidden" name="matterId" value={id} /><input type="hidden" name="invoiceId" value={inv.id} /></>;
  const draftTotal = inv.draft ? inv.draft.timeCents + inv.draft.expenseCents : 0;

  return (
    <>
      <p className="notice no-print">{staff ? <Link href={`/matters/${id}/billing`}>← Billing</Link> : <Link href={`/matters/${id}`}>← {inv.matterTitle}</Link>}</p>
      <FlashBanner flash={flash} />
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <h1 style={{ marginBottom: 4 }}>{inv.number ? `Invoice ${inv.number}` : "Draft invoice"}</h1>
            <p className="sub" style={{ margin: 0 }}>{inv.firmName}</p>
          </div>
          <span className={inv.overdue ? "badge privileged" : inv.status === "draft" ? "badge walled" : "badge"}>{inv.overdue ? "Overdue" : STATUS_LABELS[inv.status]}</span>
        </div>
        <table style={{ marginTop: 16 }}><tbody>
          <tr><td style={{ width: 160 }} className="notice">Client</td><td>{inv.clientName}</td></tr>
          <tr><td className="notice">Matter</td><td>{inv.matterTitle} <span className="notice">({inv.matterNumber})</span></td></tr>
          {inv.issuedOn ? <tr><td className="notice">Issued</td><td>{showDay(inv.issuedOn)}</td></tr> : null}
          {inv.dueOn ? <tr><td className="notice">Due</td><td>{showDay(inv.dueOn)}</td></tr> : null}
        </tbody></table>
        {inv.status === "void" ? <div className="flash error" style={{ marginTop: 16 }}>This invoice was voided. Nothing is owed on it.</div> : null}

        {inv.draft ? (
          <>
            <h2 style={{ marginTop: 20 }}>On this draft</h2>
            <p className="notice">These are copied into the invoice when it&apos;s issued; until then they can still change.</p>
            <table>
              <thead><tr><th>Date</th><th>Description</th><th style={{ textAlign: "right" }}>Hours</th><th style={{ textAlign: "right" }}>Rate</th><th style={{ textAlign: "right" }}>Amount</th><th /></tr></thead>
              <tbody>
                {inv.draft.time.map((t) => (
                  <tr key={t.id}>
                    <td style={{ whiteSpace: "nowrap" }}>{showDay(t.workDate)}</td><td>{t.description} <span className="notice">· {t.userName}</span></td>
                    <td style={{ textAlign: "right" }}>{hours(t.minutes)}</td><td style={{ textAlign: "right" }}>{money(t.rateCents)}</td><td style={{ textAlign: "right" }}>{money(t.amountCents)}</td>
                    <td>{inv.canInvoice ? <form action={removeFromDraftAction}>{hidden}<input type="hidden" name="kind" value="time" /><input type="hidden" name="itemId" value={t.id} /><button className="secondary" type="submit">Take off</button></form> : null}</td>
                  </tr>
                ))}
                {inv.draft.expenses.map((e) => (
                  <tr key={e.id}>
                    <td style={{ whiteSpace: "nowrap" }}>{showDay(e.incurredOn)}</td><td>{e.description} <span className="notice">· expense</span></td>
                    <td /><td /><td style={{ textAlign: "right" }}>{money(e.amountCents)}</td>
                    <td>{inv.canInvoice ? <form action={removeFromDraftAction}>{hidden}<input type="hidden" name="kind" value="expense" /><input type="hidden" name="itemId" value={e.id} /><button className="secondary" type="submit">Take off</button></form> : null}</td>
                  </tr>
                ))}
                <tr><td colSpan={4} style={{ textAlign: "right" }}><strong>Total</strong></td><td style={{ textAlign: "right" }}><strong>{money(draftTotal)}</strong></td><td /></tr>
              </tbody>
            </table>
          </>
        ) : (
          <>
            <h2 style={{ marginTop: 20 }}>Services and expenses</h2>
            <table>
              <thead><tr><th>Date</th><th>Description</th><th style={{ textAlign: "right" }}>Hours</th><th style={{ textAlign: "right" }}>Rate</th><th style={{ textAlign: "right" }}>Amount</th></tr></thead>
              <tbody>
                {inv.lines.map((l) => (
                  <tr key={l.position}>
                    <td style={{ whiteSpace: "nowrap" }}>{showDay(l.date)}</td>
                    <td>{l.description}{l.kind === "time" && l.who ? <span className="notice"> · {l.who}</span> : l.kind === "expense" ? <span className="notice"> · expense</span> : null}</td>
                    <td style={{ textAlign: "right" }}>{l.tenths !== null ? (l.tenths / 10).toFixed(1) : ""}</td>
                    <td style={{ textAlign: "right" }}>{l.rateCents !== null ? money(l.rateCents) : ""}</td>
                    <td style={{ textAlign: "right" }}>{money(l.amountCents)}</td>
                  </tr>
                ))}
                <tr><td colSpan={4} style={{ textAlign: "right" }}>Fees</td><td style={{ textAlign: "right" }}>{money(inv.timeCents)}</td></tr>
                <tr><td colSpan={4} style={{ textAlign: "right" }}>Expenses</td><td style={{ textAlign: "right" }}>{money(inv.expenseCents)}</td></tr>
                <tr><td colSpan={4} style={{ textAlign: "right" }}><strong>Total</strong></td><td style={{ textAlign: "right" }}><strong>{money(inv.totalCents)}</strong></td></tr>
                {inv.paidCents ? <tr><td colSpan={4} style={{ textAlign: "right" }}>Paid</td><td style={{ textAlign: "right" }}>{money(inv.paidCents)}</td></tr> : null}
                {inv.status !== "void" ? <tr><td colSpan={4} style={{ textAlign: "right" }}><strong>Balance due</strong></td><td style={{ textAlign: "right" }}><strong>{money(owed)}</strong></td></tr> : null}
              </tbody>
            </table>
          </>
        )}
        {inv.notes && !inv.draft ? <p style={{ marginTop: 16, whiteSpace: "pre-wrap" }}>{inv.notes}</p> : null}
        {inv.payments.length ? (
          <>
            <h2 style={{ marginTop: 20 }}>Payments received</h2>
            <table><tbody>
              {inv.payments.map((p, i) => (
                <tr key={i}><td>{showDay(p.receivedOn)}</td><td>{PAYMENT_METHOD_LABELS[p.method]}{p.reference ? ` · ${p.reference}` : ""}</td><td style={{ textAlign: "right" }}>{money(p.amountCents)}</td></tr>
              ))}
            </tbody></table>
          </>
        ) : null}
        {inv.status !== "draft" ? <p className="notice no-print" style={{ marginTop: 16 }}>Use your browser&apos;s Print to save or print this invoice.</p> : null}
      </div>

      {inv.canInvoice && inv.status === "draft" ? (
        <div className="card no-print">
          <h2>Notes and issuing</h2>
          <form action={updateDraftNotesAction}>
            {hidden}
            <label>Notes on the invoice (the client sees these)<textarea name="notes" rows={3} maxLength={2000} defaultValue={inv.notes} /></label>
            <p><button className="secondary" type="submit">Save notes</button></p>
          </form>
          <form action={issueInvoiceAction} className="row">
            {hidden}
            <label>Invoice date<input type="date" name="issuedOn" defaultValue={today} required /></label>
            <label>Due<input type="date" name="dueOn" defaultValue={due30} required /></label>
            <button type="submit">Issue invoice for {money(draftTotal)}</button>
          </form>
          <p className="notice">Issuing gives it the firm&apos;s next number and fixes its lines and total; the client can then see it. To change an issued invoice, void it and issue a new one.</p>
          <form action={deleteDraftInvoiceAction}>{hidden}<button className="secondary" type="submit">Delete this draft</button></form>
        </div>
      ) : null}

      {inv.canInvoice && inv.status === "issued" ? (
        <div className="card no-print">
          <h2>Record a payment</h2>
          <form action={recordPaymentAction} className="row">
            {hidden}
            <label>Amount ($)<input name="amount" required inputMode="decimal" defaultValue={(owed / 100).toFixed(2)} style={{ width: 130 }} /></label>
            <label>Received<input type="date" name="receivedOn" defaultValue={today} required /></label>
            <label>How<select name="method" defaultValue="check">{PAYMENT_METHODS.map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>)}</select></label>
            <label>Reference<input name="reference" maxLength={100} placeholder="Check number…" /></label>
            <button type="submit">Record payment</button>
          </form>
          <p className="notice">Huis records payments received; it doesn&apos;t take them. Client trust (IOLTA) money isn&apos;t handled here.</p>
          {inv.paidCents === 0 ? (
            <form action={voidInvoiceAction} className="row" style={{ marginTop: 12 }}>
              {hidden}
              <label className="check"><input type="checkbox" name="confirm" /> Void this invoice (it stays on record as void; its items become unbilled again)</label>
              <button className="secondary" type="submit">Void invoice</button>
            </form>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
