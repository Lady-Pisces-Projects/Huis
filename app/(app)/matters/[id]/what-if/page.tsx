import Link from "next/link";
import { notFound } from "next/navigation";
import { withSession } from "../../../../../lib/server";
import { WORK_PRODUCT_LABEL } from "../../../../../src/ai/gateway";
import { NotFoundError, UserFacingError } from "../../../../../src/errors";
import { MAX_CHANGES, parseChanges } from "../../../../../src/intelligence/scenarios";
import { whatIfAnalysis } from "../../../../../src/services/caseStrength";
import { getMatter } from "../../../../../src/services/matters";
import { INTERNAL_ROLES } from "../../../../../src/security/permissions";

export const dynamic = "force-dynamic";

const score = (n: number | null) => (n === null ? "—" : String(n));

/*
 * What-If Analysis (Phase 11 part 4): the attorney tests assumptions against the case-strength rules. Nothing is
 * saved or changed; firm staff only.
 */
export default async function WhatIfPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ c?: string | string[] }> }) {
  const { id } = await params;
  const changes = parseChanges((await searchParams).c);
  const chosen = new Set(changes.map((c) => `${c.kind}:${c.id}`));
  const data = await withSession(async (s) => {
    if (!INTERNAL_ROLES.has(s.actor.role)) return null;
    try {
      const m = await getMatter(s, id);
      try {
        return { m, ...(await whatIfAnalysis(s, id, changes)), error: null as string | null };
      } catch (err) {
        if (!(err instanceof UserFacingError)) throw err;
        return { m, ...(await whatIfAnalysis(s, id, [])), error: err.message };
      }
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
  });
  if (!data) notFound();
  const { m, options: o, result: r, truncated, error } = data;
  const box = (value: string, label: string) => (
    <label key={value} style={{ display: "block" }}><input type="checkbox" name="c" value={value} defaultChecked={chosen.has(value)} /> {label}</label>
  );

  return (
    <>
      <p className="sub"><Link href={`/matters/${m.id}`}>← {m.title}</Link> · <Link href={`/matters/${m.id}/strength`}>Case strength</Link> · <Link href={`/matters/${m.id}/readiness`}>Trial readiness</Link></p>
      <p className="notice"><strong>{WORK_PRODUCT_LABEL}</strong></p>
      <h1>What if?</h1>
      <p className="sub">
        Test assumptions against the same rules as case strength: what moves if a witness confirms an element, a new email turns up, or a
        fact is excluded. Nothing is saved, and Case DNA doesn&apos;t change. These are evidence coverage scores, <strong>not a probability of winning</strong>.
      </p>
      <p className="notice">Only confirmed facts and links count; Huis&apos;s suggestions waiting for review don&apos;t. Anything you can&apos;t see (behind an ethical wall) isn&apos;t counted.</p>
      {truncated ? <p className="notice">Only the first 200 claims and defenses are included.</p> : null}
      {error ? <p className="notice error" role="alert">{error}</p> : null}

      {r ? (
        <div className="card">
          <h2>Result</h2>
          <ul>{r.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
          <p><strong>Overall:</strong> {score(r.before.score)} ({r.before.rating}) → <strong>{score(r.after.score)} ({r.after.rating})</strong></p>
          <p className="muted">{r.after.why}</p>
          {r.claims.length ? (
            <table><thead><tr><th>Claim or defense</th><th>Now</th><th>With these assumptions</th></tr></thead>
              <tbody>{r.claims.map((c) => <tr key={c.id}><td>{c.label}{c.kind === "defense" ? " (defense)" : ""}</td><td>{score(c.before.score)} · {c.before.rating}</td><td><strong>{score(c.after.score)} · {c.after.rating}</strong></td></tr>)}</tbody></table>
          ) : <p className="notice">No claim or defense changes.</p>}
          {r.elements.length ? (
            <>
              <h3>Elements that move</h3>
              {r.elements.map((e) => (
                <details key={e.id}><summary>{e.label} ({e.claim}): {e.before} → <strong>{e.after}</strong></summary><ul>{e.why.map((w) => <li key={w}>{w}</li>)}</ul></details>
              ))}
            </>
          ) : null}
          {r.gapsClosed.length ? <><h3>Holes this would close</h3><ul>{r.gapsClosed.map((g) => <li key={g.key}>{g.title} <span className="badge muted">{g.severity}</span></li>)}</ul></> : null}
          {r.gapsChanged.length ? <><h3>Holes that would change</h3><ul>{r.gapsChanged.map((g) => <li key={g.key}>{g.title}: <span className="badge muted">{g.was.severity}</span> → <span className="badge warn">{g.severity}</span>{g.detail !== g.was.detail ? <div className="muted">{g.detail}</div> : null}</li>)}</ul></> : null}
          {r.gapsOpened.length ? <><h3>New holes this would open</h3><ul>{r.gapsOpened.map((g) => <li key={g.key}>{g.title} <span className="badge warn">{g.severity}</span></li>)}</ul></> : null}
          <h3>What this doesn&apos;t check</h3>
          <ul>{r.notChecked.map((n) => <li key={n}>{n}</li>)}</ul>
        </div>
      ) : null}

      <form method="get" className="card">
        <h2>Assumptions</h2>
        <p className="muted">Pick up to {MAX_CHANGES}, then run.</p>
        {o.elements.length ? (
          <>
            <h3>New evidence for an element</h3>
            {o.elements.map((e) => (
              <fieldset key={e.id} style={{ border: 0, padding: 0, marginBottom: 8 }}>
                <legend><strong>{e.label}</strong> <span className="muted">({e.kind === "defense" ? `defense: ${e.claim}` : e.claim})</span></legend>
                {box(`add-document:${e.id}`, "A new document or email supports it")}
                {box(`add-witness:${e.id}`, "A witness confirms it")}
              </fieldset>
            ))}
          </>
        ) : <p className="notice">No claim elements yet. Add a claim in Case DNA first.</p>}
        {o.facts.length ? <details><summary><h3 style={{ display: "inline" }}>Evidence that falls away</h3></summary>
          {o.facts.map((f) => box(`lose-fact:${f.id}`, `${f.label} — ${f.uses.join("; ")}`))}</details> : null}
        {o.witnesses.length ? <details><summary><h3 style={{ display: "inline" }}>Witnesses who become unavailable</h3></summary>
          {o.witnesses.map((w) => box(`lose-witness:${w.id}`, `${w.label} (witness to ${w.facts} fact${w.facts === 1 ? "" : "s"})`))}</details> : null}
        <p><button type="submit">Run what-if</button> <Link href={`/matters/${m.id}/what-if`}>Clear</Link></p>
      </form>
    </>
  );
}
