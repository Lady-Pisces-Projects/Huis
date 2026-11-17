import Link from "next/link";
import { notFound } from "next/navigation";
import { withSession } from "../../../../../lib/server";
import { WORK_PRODUCT_LABEL } from "../../../../../src/ai/gateway";
import { NotFoundError } from "../../../../../src/errors";
import { discoveryAndOpposition } from "../../../../../src/services/caseStrength";
import { getMatter } from "../../../../../src/services/matters";
import { INTERNAL_ROLES } from "../../../../../src/security/permissions";

export const dynamic = "force-dynamic";

const SEVERITY_CLASS: Record<string, string> = { Critical: "badge danger", High: "badge warn", Medium: "badge", Low: "badge muted" };

/* "If I were opposing counsel" (Phase 11 part 2): the other side's likely arguments from the gaps in the confirmed
 * evidence, with how to counter each. Fixed rules, firm staff only. */
export default async function OppositionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await withSession(async (s) => {
    if (!INTERNAL_ROLES.has(s.actor.role)) return null;
    try {
      return { m: await getMatter(s, id), ...(await discoveryAndOpposition(s, id)) };
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
  });
  if (!data) notFound();
  const { m, opposition: o, truncated } = data;
  return (
    <>
      <p className="sub"><Link href={`/matters/${m.id}`}>← {m.title}</Link> · <Link href={`/matters/${m.id}/strength`}>Case strength</Link> · <Link href={`/matters/${m.id}/missing`}>What are we missing?</Link></p>
      <p className="notice"><strong>{WORK_PRODUCT_LABEL}</strong></p>
      <h1>If I were opposing counsel</h1>
      <p className="sub">The arguments the gaps in your confirmed evidence invite, most severe first, and how to counter each. A red-team checklist from fixed rules, not a prediction of what the other side will do.</p>
      {truncated ? <p className="notice">Only the first 200 claims and defenses are included.</p> : null}
      {o.points.length ? o.points.map((p) => (
        <div className="card" key={p.key}>
          <h2 style={{ marginBottom: 4 }}>{p.severity === o.points[0]!.severity ? "Most severe: " : ""}{p.argument} <span className={SEVERITY_CLASS[p.severity]}>{p.severity}</span></h2>
          <h4>Why they could say it</h4>
          <ul>{p.why.map((w) => <li key={w}>{w}</li>)}</ul>
          <h4>How do we counter it?</h4>
          <ul>{p.counter.map((c) => <li key={c}>{c}</li>)}</ul>
          {p.evidence.length ? <><h4>Evidence needed</h4><ul>{p.evidence.map((e) => <li key={e}>{e}</li>)}</ul></> : null}
          <p><Link href={p.href}>Open in Case DNA</Link></p>
        </div>
      )) : <div className="card"><p className="notice">The rules found no argument to flag. That doesn&apos;t mean there isn&apos;t one.</p></div>}
      <div className="card"><h2>What this doesn&apos;t check</h2><ul>{o.notChecked.map((n) => <li key={n}>{n}</li>)}</ul></div>
    </>
  );
}
