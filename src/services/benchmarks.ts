import type { FirmSession } from "../db/tenant";
import { PermissionDeniedError } from "../errors";
import { benchmark, DISP_GROUPS, DISTRICTS_BY_STATE, nosFor, NOT_SHOWN, type Benchmark, type Counts } from "../benchmarks/federal";
import { INTERNAL_ROLES } from "../security/permissions";
import { getMatter } from "./matters";

/*
 * Phase 11 part 3: federal benchmarks for a Matter's claims (FJC Integrated Database, civil; no dollar values).
 * Firm staff who can see the Matter only. The reference data holds no firm information; the Matter's claims are read
 * as the reader (row-level security), so a claim behind an ethical wall isn't used.
 */

export interface ClaimBenchmark { claim: string; nos: number | null; nosTitle: string | null; state: Benchmark | null; national: Benchmark | null }
export interface FederalBenchmarks {
  loaded: { through: string | null; from: string | null; importedAt: Date } | null;
  state: string;
  districts: string[];
  claims: ClaimBenchmark[];
  notShown: string[];
}

async function counts(s: FirmSession, nos: number, districts: string[] | null): Promise<Counts> {
  const g = DISP_GROUPS;
  const r = (await s.client.query(
    `WITH c AS (SELECT disp, judgment, (terminated - filed) / 30.4375 AS months
                  FROM huis.federal_cases WHERE nos = $1 AND ($2::text[] IS NULL OR district = ANY($2::text[])) AND disp = ANY($3::int[]))
     SELECT count(*)::int AS total,
            count(*) FILTER (WHERE disp = ANY($4::int[]))::int AS settled,
            count(*) FILTER (WHERE disp = ANY($5::int[]))::int AS voluntary,
            count(*) FILTER (WHERE disp = ANY($6::int[]))::int AS dismissed,
            count(*) FILTER (WHERE disp = ANY($7::int[]))::int AS judgment,
            count(*) FILTER (WHERE disp = ANY($8::int[]))::int AS trial,
            count(*) FILTER (WHERE disp = ANY($7::int[]) AND judgment = 1)::int AS for_plaintiff,
            count(*) FILTER (WHERE disp = ANY($7::int[]) AND judgment = 2)::int AS for_defendant,
            count(*) FILTER (WHERE disp = ANY($7::int[]) AND judgment IN (1, 2, 3))::int AS judgment_known,
            percentile_cont(ARRAY[0.25, 0.5, 0.75]) WITHIN GROUP (ORDER BY months) AS q,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY months) FILTER (WHERE disp = ANY($8::int[])) AS trial_median
       FROM c`,
    [nos, districts, g.counted, g.settled, g.voluntary, g.dismissed, g.judgment, g.trial])).rows[0];
  const q = r.q as number[] | null;
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    total: r.total, settled: r.settled, voluntary: r.voluntary, dismissed: r.dismissed, judgment: r.judgment, trial: r.trial,
    forPlaintiff: r.for_plaintiff, forDefendant: r.for_defendant, judgmentKnown: r.judgment_known,
    months: q && r.total ? { p25: round(q[0]!), median: round(q[1]!), p75: round(q[2]!) } : null,
    trialMonths: r.trial_median === null ? null : { median: round(r.trial_median), n: r.trial },
  };
}

export async function federalBenchmarks(s: FirmSession, matterId: string): Promise<FederalBenchmarks> {
  if (!INTERNAL_ROLES.has(s.actor.role)) throw new PermissionDeniedError("see federal benchmarks");
  const m = await getMatter(s, matterId);
  const imp = (await s.client.query("SELECT terminated_from::text AS terminated_from, terminated_through::text AS terminated_through, imported_at FROM huis.federal_imports ORDER BY imported_at DESC LIMIT 1")).rows[0];
  const state = m.jurisdictionState;
  const districts = DISTRICTS_BY_STATE[state] ?? [];
  const claimRows = (await s.client.query<{ label: string }>(
    "SELECT label FROM huis.dna_nodes WHERE matter_id = $1 AND kind = 'claim' AND status = 'confirmed' ORDER BY created_at LIMIT 200", [matterId])).rows;
  const claims: ClaimBenchmark[] = [];
  const cache = new Map<string, Benchmark>();
  for (const c of claimRows) {
    const n = nosFor(c.label);
    if (!n || !imp) { claims.push({ claim: c.label, nos: n?.nos ?? null, nosTitle: n?.title ?? null, state: null, national: null }); continue; }
    const key = String(n.nos);
    if (!cache.has(`s${key}`) && districts.length) cache.set(`s${key}`, benchmark(`federal court in ${state}`, await counts(s, n.nos, districts)));
    if (!cache.has(`n${key}`)) cache.set(`n${key}`, benchmark("federal courts nationwide", await counts(s, n.nos, null)));
    claims.push({ claim: c.label, nos: n.nos, nosTitle: n.title, state: cache.get(`s${key}`) ?? null, national: cache.get(`n${key}`)! });
  }
  const iso = (d: Date | string | null) => (d === null ? null : typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10));
  return {
    loaded: imp ? { from: iso(imp.terminated_from), through: iso(imp.terminated_through), importedAt: imp.imported_at } : null,
    state, districts, claims, notShown: NOT_SHOWN,
  };
}
