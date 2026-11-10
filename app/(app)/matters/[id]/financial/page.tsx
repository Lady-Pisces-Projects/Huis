import Link from "next/link";
import { notFound } from "next/navigation";
import { money, showDay } from "../../../../../lib/billing-ui";
import { withSession } from "../../../../../lib/server";
import { WORK_PRODUCT_LABEL } from "../../../../../src/ai/gateway";
import { NotFoundError } from "../../../../../src/errors";
import { FLAG_LABELS, type FlagRule } from "../../../../../src/finance/analyze";
import { matterFinancials, MAX_DOCUMENTS, MIN_TRANSACTIONS } from "../../../../../src/services/finance";
import { getMatter } from "../../../../../src/services/matters";
import { INTERNAL_ROLES } from "../../../../../src/security/permissions";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const showMonth = (m: string) => `${MONTH_NAMES[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

/** Phase 10 part 4: the Matter's financial documents, read by fixed rules. */
export default async function FinancialPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const data = await withSession(async (s) => {
    if (!INTERNAL_ROLES.has(s.actor.role)) return null;
    let matter;
    try { matter = await getMatter(s, id); } catch (e) { if (e instanceof NotFoundError) return null; throw e; }
    return { matter, f: await matterFinancials(s, id) };
  });
  if (!data) notFound();
  const { matter, f } = data;

  return (
    <>
      <p className="notice"><Link href={`/matters/${id}`}>← {matter.title}</Link></p>
      <h1>Financial analysis</h1>
      <p className="sub">
        Bank statements, ledgers, registers and spreadsheet exports in this Matter, read by fixed rules: each transaction&apos;s date,
        description and amount, totals by month, and what may be worth a look. Huis suggests; check every figure against the document.
      </p>
      <p className="notice"><span className="badge privileged">{WORK_PRODUCT_LABEL}</span></p>

      {f.documents.length === 0 ? (
        <div className="card">
          <p>No financial documents found yet.</p>
          <p className="notice">
            A document counts when Huis can read at least {MIN_TRANSACTIONS} transactions from its text (a date, a description and an amount with cents on one line,
            or a spreadsheet with date and amount columns). Scanned statements need their text read first (OCR runs when they&apos;re uploaded).
          </p>
        </div>
      ) : (
        <>
          <div className="grid" style={{ marginBottom: 20 }}>
            <div className="card"><div className="stat">{f.documents.length}</div><div className="stat-label">Financial documents</div></div>
            <div className="card"><div className="stat">{f.totals.count}</div><div className="stat-label">Transactions{f.totals.first && f.totals.last ? `, ${showDay(f.totals.first)} – ${showDay(f.totals.last)}` : ""}</div></div>
            <div className="card"><div className="stat">{money(f.totals.moneyIn)}</div><div className="stat-label">Money in</div></div>
            <div className="card"><div className="stat">{money(f.totals.moneyOut)}</div><div className="stat-label">Money out</div></div>
          </div>
          <div className="card">
            <h2>Documents</h2>
            <table>
              <thead><tr><th>Document</th><th>Period</th><th style={{ textAlign: "right" }}>Transactions</th><th style={{ textAlign: "right" }}>In</th><th style={{ textAlign: "right" }}>Out</th><th>Worth a look</th></tr></thead>
              <tbody>
                {f.documents.map((d) => (
                  <tr key={d.evidenceId}>
                    <td><Link href={`/matters/${id}/financial/${d.evidenceId}`}>{d.filename}</Link></td>
                    <td style={{ whiteSpace: "nowrap" }}>{d.first ? showDay(d.first) : ""}{d.last && d.last !== d.first ? ` – ${showDay(d.last)}` : ""}</td>
                    <td style={{ textAlign: "right" }}>{d.count}</td>
                    <td style={{ textAlign: "right" }}>{money(d.moneyIn)}</td>
                    <td style={{ textAlign: "right" }}>{money(d.moneyOut)}</td>
                    <td>{(Object.entries(d.flags) as [FlagRule, number][]).map(([rule, n]) => (
                      <span key={rule} className={rule === "balance" || rule === "statement" ? "badge privileged" : "badge walled"} style={{ marginRight: 4 }}>{FLAG_LABELS[rule]} ({n})</span>
                    ))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card">
            <h2>By month, all documents</h2>
            <table>
              <thead><tr><th>Month</th><th style={{ textAlign: "right" }}>Transactions</th><th style={{ textAlign: "right" }}>In</th><th style={{ textAlign: "right" }}>Out</th><th style={{ textAlign: "right" }}>Net</th></tr></thead>
              <tbody>
                {f.months.map((m) => (
                  <tr key={m.month}><td>{showMonth(m.month)}</td><td style={{ textAlign: "right" }}>{m.count}</td><td style={{ textAlign: "right" }}>{money(m.moneyIn)}</td><td style={{ textAlign: "right" }}>{money(m.moneyOut)}</td><td style={{ textAlign: "right" }}>{money(m.moneyIn + m.moneyOut)}</td></tr>
                ))}
              </tbody>
            </table>
            <p className="notice">Totals add up every document, so overlapping statements count a transaction more than once (listed below).</p>
          </div>
          {f.overlaps.length ? (
            <div className="card">
              <h2>The same transaction in more than one document</h2>
              <p className="notice">Same date, amount and description: overlapping statements, a copy of the same statement, or a transaction worth checking.</p>
              <table><tbody>
                {f.overlaps.map((o, i) => (
                  <tr key={i}>
                    <td style={{ whiteSpace: "nowrap" }}>{showDay(o.date)}</td><td>{o.description}</td><td style={{ textAlign: "right" }}>{money(o.amount)}</td>
                    <td>{o.documents.map((d) => <div key={d.evidenceId}><Link href={`/matters/${id}/financial/${d.evidenceId}`}>{d.filename}</Link> <span className="notice">line {d.line}</span></div>)}</td>
                  </tr>
                ))}
              </tbody></table>
            </div>
          ) : null}
        </>
      )}
      <p className="notice">Huis read the {f.read} most recent documents with text{f.more ? ` (this Matter has more than ${MAX_DOCUMENTS}; older ones aren't included)` : ""}. Only documents you can see are included.</p>
    </>
  );
}
