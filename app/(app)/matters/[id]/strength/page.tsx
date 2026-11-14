import Link from "next/link";
import { notFound } from "next/navigation";
import { reviewGapAction } from "../../../../../lib/actions";
import { getFlash, withSession } from "../../../../../lib/server";
import { FlashBanner } from "../../../../../lib/ui";
import { WORK_PRODUCT_LABEL } from "../../../../../src/ai/gateway";
import { NotFoundError } from "../../../../../src/errors";
import type { ClaimResult, ElementResult, Gap, SourceRef } from "../../../../../src/intelligence/strength";
import { SCORE_RULES } from "../../../../../src/intelligence/strength";
import { caseStrength, type GapReview } from "../../../../../src/services/caseStrength";
import { getMatter } from "../../../../../src/services/matters";
import { INTERNAL_ROLES } from "../../../../../src/security/permissions";

export const dynamic = "force-dynamic";

const SEVERITY_CLASS: Record<string, string> = { Critical: "badge danger", High: "badge warn", Medium: "badge", Low: "badge muted" };

function Source({ s }: { s: SourceRef }) {
  return (
    <li>
      <q>{s.quote.length > 300 ? `${s.quote.slice(0, 300)}…` : s.quote}</q>{" "}
      — {s.evidenceId ? <Link href={`/evidence/${s.evidenceId}`}>{s.title}</Link> : <span>Note: {s.title}</span>}
      {s.kind === "email" ? " (email)" : s.kind === "note" ? " (attorney note)" : ""}
    </li>
  );
}

function Why({ e, claim }: { e: ElementResult; claim: ClaimResult }) {
  return (
    <details>
      <summary>Why did Huis say this?</summary>
      <h4>How the score was worked out</h4>
      <ul>{e.lines.map((l, i) => <li key={i}>{l.points >= 0 ? `+${l.points}` : l.points}: {l.why}</li>)}</ul>
      <h4>Supporting evidence</h4>
      {e.supporting.length ? e.supporting.map((f) => (
        <div key={f.id}><strong>{f.label}</strong>{f.witnesses.length ? ` (witness: ${f.witnesses.map((w) => w.label).join(", ")})` : ""}
          {f.sources.length ? <ul>{f.sources.map((s) => <Source key={s.id} s={s} />)}</ul> : <p className="notice">No source cited.</p>}</div>
      )) : <p className="notice">None confirmed yet.</p>}
      <h4>Contrary evidence</h4>
      {e.contradicting.length ? e.contradicting.map((f) => (
        <div key={f.id}><strong>{f.label}</strong>{f.sources.length ? <ul>{f.sources.map((s) => <Source key={s.id} s={s} />)}</ul> : null}</div>
      )) : <p className="notice">Nothing confirmed contradicts it.</p>}
      <h4>Missing evidence</h4>
      {e.missing.length ? <ul>{e.missing.map((m) => <li key={m}>{m}</li>)}</ul> : <p className="notice">Nothing more the rules look for.</p>}
      <h4>Applicable law</h4>
      {[...e.authorities, ...claim.authorities].length ? (
        <ul>{[...e.authorities.map((a) => ({ ...a, on: "this element" })), ...claim.authorities.map((a) => ({ ...a, on: "the claim" }))].map((a, i) => (
          <li key={`${a.citation}-${i}`}>{a.url ? <a href={a.url} target="_blank" rel="noopener noreferrer nofollow">{a.citation}</a> : a.citation} ({a.stance}, cited on {a.on}{a.verified ? ", verified" : ", not verified"})</li>
        ))}</ul>
      ) : <p className="notice">No authorities cited for this element or claim yet{claim.details ? `. The claim notes: ${claim.details}` : ""}.</p>}
      <h4>Assumptions</h4>
      <p className="notice">Only confirmed facts and links count; Huis&apos;s suggestions waiting for review don&apos;t. Anything you can&apos;t see (behind an ethical wall) isn&apos;t counted. Huis doesn&apos;t judge how persuasive a fact is, only whether it is there, sourced and corroborated.</p>
    </details>
  );
}

function ClaimCard({ c, matterId }: { c: ClaimResult; matterId: string }) {
  return (
    <div className="card">
      <h3 style={{ marginBottom: 4 }}><Link href={`/matters/${matterId}/dna/${c.id}`}>{c.label}</Link> — {c.rating}{c.score !== null ? ` (${c.score}/100)` : ""}</h3>
      <p>{c.why}</p>
      {c.elements.length ? (
        <table>
          <thead><tr><th>Element</th><th>Score</th><th>Support</th><th></th></tr></thead>
          <tbody>
            {c.elements.map((e) => (
              <tr key={e.id}>
                <td>{e.label}</td>
                <td>{e.score}</td>
                <td>{e.supporting.length ? `${e.supporting.length} fact${e.supporting.length === 1 ? "" : "s"}, ${e.documentSources} document${e.documentSources === 1 ? "" : "s"} or email${e.documentSources === 1 ? "" : "s"}${e.witnesses.length ? `, ${e.witnesses.length} witness${e.witnesses.length === 1 ? "" : "es"}` : ""}${e.disputed ? `, ${e.contradicting.length} contradicting` : ""}` : "None yet"}</td>
                <td><Why e={e} claim={c} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

function GapItem({ g, matterId, review, canReview }: { g: Gap; matterId: string; review?: GapReview; canReview: boolean }) {
  return (
    <li style={{ marginBottom: 14 }}>
      <span className={SEVERITY_CLASS[g.severity]}>{g.severity}</span> <span className="badge muted">{g.impact}</span>{" "}
      <Link href={g.href}><strong>{g.title}</strong></Link>
      <div>{g.detail}</div>
      <div className="notice">Suggested actions:</div>
      <ul>{g.actions.map((a) => <li key={a}>{a}</li>)}</ul>
      {review ? <p className="notice">{review.decision === "set_aside" ? "Set aside" : "Context"} by {review.by}: {review.note}</p> : null}
      {canReview ? (
        <details>
          <summary>Agree, set aside or add context</summary>
          <form action={reviewGapAction} className="stack">
            <input type="hidden" name="matterId" value={matterId} />
            <input type="hidden" name="gapKey" value={g.key} />
            <label htmlFor={`note-${g.key}`}>Note</label>
            <textarea id={`note-${g.key}`} name="note" maxLength={2000} rows={2} defaultValue={review?.note ?? ""} />
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="submit" name="decision" value="context">Add context</button>
              <button type="submit" name="decision" value="set_aside" className="secondary">Set aside (not relevant or handled)</button>
              {review ? <button type="submit" name="decision" value="reopen" className="secondary">Put back</button> : null}
            </div>
          </form>
        </details>
      ) : null}
    </li>
  );
}

/*
 * Case Outcome Intelligence (Phase 11 part 1): case strength, the holes in the case and next steps, from fixed rules
 * over the Matter's confirmed Case DNA. Firm staff only; attorney work product.
 */
export default async function StrengthPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ f?: string }> }) {
  const { id } = await params;
  const flash = await getFlash((await searchParams).f);
  const data = await withSession(async (s) => {
    if (!INTERNAL_ROLES.has(s.actor.role)) return null;
    try {
      const m = await getMatter(s, id);
      return { m, r: await caseStrength(s, id), canReview: s.actor.role !== "read_only" };
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
  });
  if (!data) notFound();
  const { m, r, canReview } = data;
  const priorities = r.open.filter((g) => g.severity !== "Low").slice(0, 5);

  return (
    <>
      <p className="sub"><Link href={`/matters/${m.id}`}>← {m.title}</Link> · <Link href={`/matters/${m.id}/dna`}>Case DNA™</Link> · <Link href={`/matters/${m.id}/claims`}>Claims matrix</Link></p>
      <p><Link className="button" href={`/matters/${m.id}/missing`}>What are we missing?</Link>{" "}<Link className="button" href={`/matters/${m.id}/opposition`}>If I were opposing counsel</Link>{" "}<Link className="button" href={`/matters/${m.id}/what-if`}>What if?</Link>{" "}<Link className="button" href={`/matters/${m.id}/readiness`}>Trial readiness</Link></p>
      <p className="notice"><strong>{WORK_PRODUCT_LABEL}</strong></p>
      <h1>Case Outcome Intelligence™</h1>
      <p className="sub">
        How well the evidence you&apos;ve confirmed covers each claim, where it falls short, and what to do next. These are evidence
        coverage scores from fixed rules, <strong>not a probability of winning</strong>. Every number shows the rule behind it.
      </p>
      <FlashBanner flash={flash} />

      <div className="card">
        <h2>Overall: {r.overall.rating}{r.overall.score !== null ? ` — ${r.overall.score}/100` : ""}</h2>
        <p>{r.overall.why}</p>
        <p><strong>Confidence: {r.confidence.level}.</strong> {r.confidence.reasons.join(" ")}</p>
        {r.truncated ? <p className="notice">This Matter has more than 200 claims and defenses; only the first 200 are included.</p> : null}
      </div>

      <div className="card">
        <h2>Breakdown</h2>
        <table>
          <thead><tr><th>Category</th><th>Score</th><th>Rule</th><th>Why</th></tr></thead>
          <tbody>
            {r.categories.map((c) => (
              <tr key={c.key}><td>{c.label}</td><td>{c.value === null ? "—" : `${c.value}%`}</td><td className="notice">{c.rule}</td><td>{c.why}</td></tr>
            ))}
          </tbody>
        </table>
        <p className="notice">
          Each element scores {SCORE_RULES.supported} for a confirmed supporting fact, +{SCORE_RULES.documented} if it is cited to a document or email,
          +{SCORE_RULES.twoSources} for two independent documents or emails, +{SCORE_RULES.witness} for a person linked as a witness and +{SCORE_RULES.threeSources} for
          three or more documents or emails (up to 100), less {-SCORE_RULES.perContradiction} for each confirmed contradicting fact (not below {SCORE_RULES.floor} while
          supported). Attorney notes count as support but not as extra sources. The overall rating is never better than the weakest claim.
        </p>
      </div>

      <div className="card">
        <h2>What should we focus on?</h2>
        {priorities.length ? (
          <ol>
            {priorities.map((g) => (
              <li key={g.key} style={{ marginBottom: 10 }}>
                <Link href={g.href}><strong>{g.title}</strong></Link> <span className={SEVERITY_CLASS[g.severity]}>{g.severity}</span>
                <ul>{g.actions.map((a) => <li key={a}>{a}</li>)}</ul>
              </li>
            ))}
          </ol>
        ) : <p className="notice">No critical, high or medium gaps open.</p>}
        <p className="notice">Suggested actions are starting points from the element&apos;s name; check them against your strategy and the controlling law.</p>
      </div>

      {r.strengths.length ? (
        <div className="card">
          <h2>Why the case is strong</h2>
          <ul>{r.strengths.map((s) => <li key={s.text}><Link href={s.href}>{s.text}</Link></li>)}</ul>
        </div>
      ) : null}

      <h2>Claims</h2>
      {r.claims.length ? r.claims.map((c) => <ClaimCard key={c.id} c={c} matterId={m.id} />) : (
        <div className="card"><p className="notice">No claims yet. <Link href={`/matters/${m.id}/dna`}>Add one in Case DNA</Link>.</p></div>
      )}

      <div className="card">
        <h2>Where the case has holes</h2>
        {r.open.length ? <ul style={{ listStyle: "none", paddingLeft: 0 }}>{r.open.map((g) => <GapItem key={g.key} g={g} matterId={m.id} review={r.reviews.get(g.key)} canReview={canReview} />)}</ul>
          : <p className="notice">No gaps open.</p>}
      </div>

      {r.setAside.length ? (
        <div className="card">
          <h2>Set aside by attorneys</h2>
          <ul style={{ listStyle: "none", paddingLeft: 0 }}>{r.setAside.map((g) => <GapItem key={g.key} g={g} matterId={m.id} review={g.review} canReview={canReview} />)}</ul>
          <p className="notice">Setting a gap aside removes it from the priority list; the scores stay based on the evidence.</p>
        </div>
      ) : null}

      {r.defenses.length ? (
        <>
          <h2>Defenses (support for the other side)</h2>
          {r.defenses.map((c) => <ClaimCard key={c.id} c={c} matterId={m.id} />)}
        </>
      ) : null}
    </>
  );
}
