import Link from "next/link";
import { notFound } from "next/navigation";
import { withSession } from "../../../../../lib/server";
import { WORK_PRODUCT_LABEL } from "../../../../../src/ai/gateway";
import { NotFoundError } from "../../../../../src/errors";
import type { Draft, Item } from "../../../../../src/intelligence/discovery";
import { discoveryAndOpposition } from "../../../../../src/services/caseStrength";
import { getMatter } from "../../../../../src/services/matters";
import { INTERNAL_ROLES } from "../../../../../src/security/permissions";

export const dynamic = "force-dynamic";

function Items({ list, empty }: { list: Item[]; empty: string }) {
  return list.length ? <ul>{list.map((i) => <li key={`${i.title}-${i.href}`}><Link href={i.href}><strong>{i.title}</strong></Link>{i.detail ? ` — ${i.detail}` : ""}</li>)}</ul> : <p className="notice">{empty}</p>;
}
function Drafts({ list, empty }: { list: Draft[]; empty: string }) {
  return list.length ? <ol>{list.map((d, i) => <li key={i} style={{ marginBottom: 8 }}>{d.text}<div className="notice">Why: <Link href={d.href}>{d.basis}</Link></div></li>)}</ol> : <p className="notice">{empty}</p>;
}

/* "What are we missing?" (Phase 11 part 2): discovery gaps from fixed rules over confirmed Case DNA. Firm staff only. */
export default async function MissingPage({ params }: { params: Promise<{ id: string }> }) {
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
  const { m, discovery: d, truncated } = data;
  return (
    <>
      <p className="sub"><Link href={`/matters/${m.id}`}>← {m.title}</Link> · <Link href={`/matters/${m.id}/strength`}>Case strength</Link> · <Link href={`/matters/${m.id}/opposition`}>If I were opposing counsel</Link></p>
      <p className="notice"><strong>{WORK_PRODUCT_LABEL}</strong></p>
      <h1>What are we missing?</h1>
      <p className="sub">Discovery to consider, from what the firm has confirmed in Case DNA. Requests below are drafts to edit, not to serve as written.</p>
      {truncated ? <p className="notice">Only the first 200 claims and defenses are included.</p> : null}

      <div className="card"><h2>Documents to request</h2><Drafts list={d.documents} empty="Every claim element already has two or more documents or emails behind it." /></div>
      <div className="card"><h2>Requests for admission (drafts)</h2><Drafts list={d.admissions} empty="No confirmed fact has a document behind it yet." />
        <p className="muted">Check your court&apos;s limits before serving. The federal rules set no number limit on requests for admission, but Utah R. Civ. P. 26(c)(5) limits them by tier (5, 10 or 20 per side; 10 in domestic cases), and many courts and local rules set their own.{d.admissionsTruncated ? " Only the first 30 are drafted here." : ""}</p>
        {d.questionFacts ? <p className="muted">{d.questionFacts} fact{d.questionFacts === 1 ? " is" : "s are"} worded as a question, so no admission was drafted. Reword {d.questionFacts === 1 ? "it" : "them"} as a statement in Case DNA.</p> : null}</div>
      <div className="card">
        <h2>Deposition targets</h2>
        {d.depositions.length ? <ul>{d.depositions.map((p) => <li key={p.href}><Link href={p.href}><strong>{p.title}</strong></Link>{p.detail ? ` (${p.detail})` : ""}<ul>{p.reasons.map((r) => <li key={r}>{r}</li>)}</ul></li>)}</ul>
          : <p className="notice">No one is linked yet to the decision, a contradicting fact or a defense.</p>}
      </div>
      <div className="card"><h2>Witness gaps</h2><Items list={d.witnessGaps} empty="Every supported element has a witness, and everyone in Case DNA is linked to a fact." /></div>
      <div className="card"><h2>Organizations (possible subpoenas)</h2><Items list={d.organizations} empty="No organizations in Case DNA." /></div>
      <div className="card"><h2>Expert needs</h2><Items list={d.experts} empty="The rules found no expert need (no damages recorded, no medical element)." /></div>
      <div className="card"><h2>Authentication</h2><Items list={d.authentication} empty="No document or email supports a claim element yet." /></div>
      <div className="card"><h2>What Huis can&apos;t see</h2><ul>{d.notTracked.map((n) => <li key={n}>{n}</li>)}</ul></div>
    </>
  );
}
