import Link from "next/link";
import { notFound } from "next/navigation";
import { withSession } from "../../../../../lib/server";
import { WORK_PRODUCT_LABEL } from "../../../../../src/ai/gateway";
import type { Benchmark } from "../../../../../src/benchmarks/federal";
import { MIN_CASES } from "../../../../../src/benchmarks/federal";
import { NotFoundError } from "../../../../../src/errors";
import { federalBenchmarks } from "../../../../../src/services/benchmarks";
import { INTERNAL_ROLES } from "../../../../../src/security/permissions";
import { getMatter } from "../../../../../src/services/matters";

export const dynamic = "force-dynamic";

function Figures({ b }: { b: Benchmark }) {
  return (
    <div style={{ minWidth: 0 }}>
      <h3>{b.scope[0]!.toUpperCase() + b.scope.slice(1)}</h3>
      <p className="muted">{b.why}</p>
      {b.enough ? (
        <>
          <table><tbody>
            {b.shares.map((sh) => (
              <tr key={sh.label}><td>{sh.label}{sh.note ? <div className="muted">{sh.note}</div> : null}</td>
                <td>{sh.value === null ? <span className="badge muted">Fewer than {MIN_CASES}</span> : `${sh.value}%`}</td>
                <td className="muted">{sh.n === null ? `${sh.of.toLocaleString("en-US")} in total` : `${sh.n.toLocaleString("en-US")} of ${sh.of.toLocaleString("en-US")}`}</td></tr>
            ))}
          </tbody></table>
          {b.months ? <p>Time from filing to the end: median <strong>{b.months.median} months</strong> (middle half: {b.months.p25} to {b.months.p75} months).</p> : null}
          {b.trialMonths ? <p>Cases that ended by trial: median {b.trialMonths.median} months ({b.trialMonths.n.toLocaleString("en-US")} cases).</p> : <p className="muted">Too few trials to show a time to trial.</p>}
        </>
      ) : null}
    </div>
  );
}

/* Federal benchmarks (Phase 11 part 3): how similar federal cases ended and how long they took. No dollar values. */
export default async function BenchmarksPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await withSession(async (s) => {
    if (!INTERNAL_ROLES.has(s.actor.role)) return null;
    try {
      return { m: await getMatter(s, id), r: await federalBenchmarks(s, id) };
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
  });
  if (!data) notFound();
  const { m, r } = data;
  return (
    <>
      <p className="sub"><Link href={`/matters/${m.id}`}>← {m.title}</Link> · <Link href={`/matters/${m.id}/strength`}>Case strength</Link> · <Link href={`/matters/${m.id}/readiness`}>Trial readiness</Link></p>
      <p className="notice"><strong>{WORK_PRODUCT_LABEL}</strong></p>
      <h1>Federal benchmarks</h1>
      <p className="sub">
        How federal cases of the same type ended and how long they took, from the Federal Judicial Center&apos;s Integrated Database.
        <strong> No dollar values, and not a prediction</strong> for this Matter.
      </p>
      {r.loaded
        ? <p className="notice">Cases that ended {r.loaded.from} to {r.loaded.through}. Source: Federal Judicial Center, Integrated Database (civil).</p>
        : <p className="notice">The federal data hasn&apos;t been loaded yet. Huis staff load it from the Federal Judicial Center.</p>}
      {!r.districts.length ? <p className="notice">The Matter&apos;s state ({r.state}) has no federal district in the data; only nationwide figures are shown.</p> : null}
      {r.claims.length ? r.claims.map((c, i) => (
        <div className="card" key={`${c.claim}-${i}`}>
          <h2>{c.claim}</h2>
          {c.nos === null ? <p className="notice">No federal case type matches this claim&apos;s name, so there are no benchmarks for it.</p> : (
            <>
              <p className="muted">Federal case type: {c.nos} {c.nosTitle}</p>
              {r.loaded ? (
                <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
                  {c.state ? <Figures b={c.state} /> : null}
                  {c.national ? <Figures b={c.national} /> : null}
                </div>
              ) : null}
            </>
          )}
        </div>
      )) : <p className="notice">No confirmed claims in Case DNA yet.</p>}
      <div className="card"><h2>What this doesn&apos;t show</h2><ul>{r.notShown.map((n) => <li key={n}>{n}</li>)}</ul></div>
    </>
  );
}
