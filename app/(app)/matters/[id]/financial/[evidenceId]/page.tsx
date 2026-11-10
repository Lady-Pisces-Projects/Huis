import Link from "next/link";
import { notFound } from "next/navigation";
import { money, showDay } from "../../../../../../lib/billing-ui";
import { withSession } from "../../../../../../lib/server";
import { WORK_PRODUCT_LABEL } from "../../../../../../src/ai/gateway";
import { NotFoundError } from "../../../../../../src/errors";
import { FLAG_LABELS, RULES } from "../../../../../../src/finance/analyze";
import { documentFinancials } from "../../../../../../src/services/finance";
import { INTERNAL_ROLES } from "../../../../../../src/security/permissions";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One document's transactions, totals and flags, each flag quoting the line it came from. */
export default async function DocumentFinancialPage({ params }: { params: Promise<{ id: string; evidenceId: string }> }) {
  const { id, evidenceId } = await params;
  if (!UUID.test(id) || !UUID.test(evidenceId)) notFound();
  const a = await withSession(async (s) => {
    if (!INTERNAL_ROLES.has(s.actor.role)) return null;
    try {
      const d = await documentFinancials(s, evidenceId);
      return d.matterId === id ? d : null;
    } catch (e) { if (e instanceof NotFoundError) return null; throw e; }
  });
  if (!a) notFound();
  const flagged = new Map<number, string[]>();
  for (const f of a.flags) for (const i of f.refs) flagged.set(i, [...(flagged.get(i) ?? []), FLAG_LABELS[f.rule]]);

  return (
    <>
      <p className="notice"><Link href={`/matters/${id}/financial`}>← Financial analysis</Link> · <Link href={`/evidence/${evidenceId}`}>Open the document</Link></p>
      <h1>{a.filename}</h1>
      <p className="notice"><span className="badge privileged">{WORK_PRODUCT_LABEL}</span></p>
      {a.noText ? <div className="card"><p>Huis hasn&apos;t read this document&apos;s text yet (it may still be processing, or be a scan without text).</p></div> : null}
      {!a.noText && !a.financial ? (
        <div className="card"><p>Huis didn&apos;t find enough transactions in this document to treat it as financial ({a.totals.count} found).</p></div>
      ) : null}
      {a.financial ? (
        <>
          <div className="grid" style={{ marginBottom: 20 }}>
            <div className="card"><div className="stat">{a.totals.count}</div><div className="stat-label">Transactions{a.totals.first ? `, ${showDay(a.totals.first)} – ${showDay(a.totals.last!)}` : ""}</div></div>
            <div className="card"><div className="stat">{money(a.totals.moneyIn)}</div><div className="stat-label">Money in</div></div>
            <div className="card"><div className="stat">{money(a.totals.moneyOut)}</div><div className="stat-label">Money out</div></div>
            <div className="card"><div className="stat">{money(a.totals.net)}</div><div className="stat-label">Net{a.opening ? ` · opening ${money(a.opening.amount)}` : ""}{a.closing ? ` · closing ${money(a.closing.amount)}` : ""}</div></div>
          </div>

          <div className="card">
            <h2>Worth a look ({a.flags.length})</h2>
            {a.flags.length === 0 ? <p className="notice">Nothing the rules below pick out.</p> : (
              <table><tbody>
                {a.flags.map((f, i) => (
                  <tr key={i}>
                    <td style={{ width: 190 }}><span className={f.rule === "balance" || f.rule === "statement" ? "badge privileged" : "badge walled"}>{FLAG_LABELS[f.rule]}</span></td>
                    <td>{f.why}{f.refs.map((r) => <div key={r} className="notice" style={{ fontFamily: "ui-monospace, monospace" }}>line {a.transactions[r]!.line}: {a.transactions[r]!.text}</div>)}</td>
                  </tr>
                ))}
              </tbody></table>
            )}
            <details style={{ marginTop: 12 }}>
              <summary className="notice">The rules</summary>
              <ul className="notice">
                <li><strong>Running balance</strong>: each balance shown should be the one before plus the transaction.</li>
                <li><strong>Opening and closing</strong>: the opening balance plus every transaction found should equal the closing balance.</li>
                <li><strong>Possible duplicate</strong>: the same amount to the same payee within {RULES.duplicateDays} days, or the same amount on the same day.</li>
                <li><strong>Round amount</strong>: a whole hundred dollars, ${RULES.roundFrom / 100} or more.</li>
                <li><strong>Unusually large</strong>: at least {RULES.largeTimesMedian} times the typical (median) transaction and ${RULES.largeFrom / 100} or more (with 5 or more transactions).</li>
                <li><strong>Cash</strong> and <strong>transfers</strong>: the description reads as an ATM or cash withdrawal, or a wire, transfer, Zelle, Venmo, PayPal or Cash App.</li>
                <li><strong>Gap in dates</strong>: more than {RULES.gapDays} days with no transactions.</li>
              </ul>
              <p className="notice">Amounts need cents (e.g. 1,250.00) to be read. Money out is shown negative; where a statement doesn&apos;t sign amounts, the running balance decides.</p>
            </details>
          </div>

          <div className="card">
            <h2>By month</h2>
            <table>
              <thead><tr><th>Month</th><th style={{ textAlign: "right" }}>Transactions</th><th style={{ textAlign: "right" }}>In</th><th style={{ textAlign: "right" }}>Out</th></tr></thead>
              <tbody>{a.months.map((m) => <tr key={m.month}><td>{m.month}</td><td style={{ textAlign: "right" }}>{m.count}</td><td style={{ textAlign: "right" }}>{money(m.moneyIn)}</td><td style={{ textAlign: "right" }}>{money(m.moneyOut)}</td></tr>)}</tbody>
            </table>
          </div>

          <div className="card">
            <h2>Transactions</h2>
            <table>
              <thead><tr><th>Line</th><th>Date</th><th>Description</th><th style={{ textAlign: "right" }}>Amount</th><th style={{ textAlign: "right" }}>Balance</th></tr></thead>
              <tbody>
                {a.transactions.map((t, i) => (
                  <tr key={i}>
                    <td className="notice">{t.line}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{showDay(t.date)}</td>
                    <td>{t.description}{flagged.has(i) ? <> {[...new Set(flagged.get(i))].map((l) => <span key={l} className="badge walled" style={{ marginLeft: 4 }}>{l}</span>)}</> : null}</td>
                    <td style={{ textAlign: "right", color: t.amount < 0 ? "#b42318" : undefined }}>{money(t.amount)}</td>
                    <td style={{ textAlign: "right" }}>{t.balance !== null ? money(t.balance) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {a.skipped ? <p className="notice">{a.skipped} line(s) looked like transactions but couldn&apos;t be read (for example a date with no year and no statement period to take it from).</p> : null}
            {a.truncated ? <p className="notice">This document is longer than Huis reads in one go; only its first part is included.</p> : null}
          </div>
        </>
      ) : null}
    </>
  );
}
