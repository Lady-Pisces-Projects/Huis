import Link from "next/link";
import { notFound } from "next/navigation";
import { withSession } from "../../../../../lib/server";
import { WORK_PRODUCT_LABEL } from "../../../../../src/ai/gateway";
import { NotFoundError } from "../../../../../src/errors";
import { trialReadiness } from "../../../../../src/services/caseStrength";
import { getMatter } from "../../../../../src/services/matters";
import { INTERNAL_ROLES } from "../../../../../src/security/permissions";

export const dynamic = "force-dynamic";

/* Trial readiness (Phase 11 part 4): only what Huis can measure in confirmed Case DNA. Firm staff only. */
export default async function ReadinessPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await withSession(async (s) => {
    if (!INTERNAL_ROLES.has(s.actor.role)) return null;
    try {
      return { m: await getMatter(s, id), r: await trialReadiness(s, id) };
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
  });
  if (!data) notFound();
  const { m, r } = data;
  return (
    <>
      <p className="sub"><Link href={`/matters/${m.id}`}>← {m.title}</Link> · <Link href={`/matters/${m.id}/strength`}>Case strength</Link> · <Link href={`/matters/${m.id}/what-if`}>What if?</Link></p>
      <p className="notice"><strong>{WORK_PRODUCT_LABEL}</strong></p>
      <h1>Trial readiness</h1>
      <p className="sub">How ready the record is, from what the firm has confirmed in Case DNA. What Huis can&apos;t measure is shown as not measured, never guessed. Decision support, not a guarantee of any result.</p>
      <p className="notice">Only confirmed facts and links count; Huis&apos;s suggestions waiting for review don&apos;t. Anything you can&apos;t see (behind an ethical wall) isn&apos;t counted.</p>
      {r.truncated ? <p className="notice">Only the first 200 claims and defenses are included.</p> : null}
      <div className="card">
        <h2>{r.score === null ? "Not enough to measure" : `${r.score}%`}</h2>
        <p className="muted">{r.why}</p>
        {r.score !== null && !r.weakest ? <p>Every category Huis can measure is at 100%.</p> : null}
        {r.weakest ? <p><strong>Your largest current weakness is {r.weakest.label.toLowerCase()}</strong> ({r.weakest.value}%): {r.weakest.why}</p> : null}
        <p><strong>Confidence: {r.confidence.level}.</strong> {r.confidence.reasons.join(" ")}</p>
      </div>
      <div className="card">
        <h2>Categories</h2>
        <table><thead><tr><th>Category</th><th>Score</th><th>Rule</th><th>Why</th></tr></thead>
          <tbody>{r.categories.map((c) => <tr key={c.key}><td>{c.label}</td><td>{c.value === null ? <span className="badge muted">Not measured</span> : `${c.value}%`}</td><td>{c.rule}</td><td>{c.why}</td></tr>)}</tbody></table>
      </div>
      <p><Link className="button" href={`/matters/${m.id}/missing`}>What are we missing?</Link>{" "}<Link className="button" href={`/matters/${m.id}/what-if`}>Test what would improve it</Link></p>
    </>
  );
}
