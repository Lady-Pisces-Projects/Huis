/**
 * Huis staff only: change a firm's plan, seats, trial or payment dates (Phase 10 part 1).
 *
 * Runs with the database owner's connection (HUIS_MIGRATION_DATABASE_URL), which the app and worker never
 * have; the change is made by huis.operator_set_subscription and recorded in the firm's audit log.
 * Until a payment processor is chosen (open item O-11), this is how a firm's subscription is set up.
 *
 *   npx tsx scripts/operator/set-subscription.ts --firm <slug> --show
 *   npx tsx scripts/operator/set-subscription.ts --firm <slug> --plan professional --seats 5 --paid-through 2026-12-31 --note "Invoice 1001"
 *   npx tsx scripts/operator/set-subscription.ts --firm <slug> --plan trial --trial-ends 2026-11-20 --note "Extended for demo"
 *   npx tsx scripts/operator/set-subscription.ts --firm <slug> --status suspended --note "Requested by firm"
 *
 * Anything not given keeps its current value. "--seats none" / "--paid-through none" clear them.
 */
import pg from "pg";

const PLANS = ["trial", "professional", "enterprise"] as const;
const STATUSES = ["active", "suspended", "disabled"] as const;

export interface SubscriptionChange {
  plan?: (typeof PLANS)[number];
  seats?: number | null;
  trialEnds?: Date | null;
  paidThrough?: Date | null;
  status?: (typeof STATUSES)[number];
  note?: string;
}

/** Minutes Utah (America/Denver) is behind UTC at this moment: 420 in winter, 360 in summer. */
function denverOffsetMinutes(at: Date): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at).map((p) => [p.type, p.value]));
  const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return Math.round((at.getTime() - local) / 60_000);
}

/** The end of that day in Utah, where Huis is based (security review 24, R24-6: real dates, summer time). */
export function parseDate(v: string, flag: string): Date | null {
  if (v === "none") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) throw new Error(`${flag}: use YYYY-MM-DD or "none"`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const asUtc = new Date(Date.UTC(y, mo - 1, d, 23, 59, 59));
  // 2026-02-31 would roll over to March: refuse it.
  if (asUtc.getUTCFullYear() !== y || asUtc.getUTCMonth() !== mo - 1 || asUtc.getUTCDate() !== d) throw new Error(`${flag}: ${v} is not a real date`);
  // 23:59:59 Utah time that day = 23:59:59 UTC plus Utah's offset then (checked again, in case it changed that day).
  let at = new Date(asUtc.getTime() + denverOffsetMinutes(asUtc) * 60_000);
  at = new Date(asUtc.getTime() + denverOffsetMinutes(at) * 60_000);
  return at;
}

export function parseArgs(argv: string[]): { firm: string; show: boolean; change: SubscriptionChange } {
  const out: { firm?: string; show: boolean; change: SubscriptionChange } = { show: false, change: {} };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--show") { out.show = true; continue; }
    const v = argv[++i];
    if (v === undefined) throw new Error(`${flag} needs a value`);
    switch (flag) {
      case "--firm": out.firm = v; break;
      case "--plan":
        if (!(PLANS as readonly string[]).includes(v)) throw new Error(`--plan: one of ${PLANS.join(", ")}`);
        out.change.plan = v as SubscriptionChange["plan"]; break;
      case "--seats":
        if (v === "none") { out.change.seats = null; break; }
        if (!/^[1-9][0-9]{0,4}$/.test(v)) throw new Error("--seats: a whole number from 1, or none");
        out.change.seats = Number(v); break;
      case "--trial-ends": out.change.trialEnds = parseDate(v, flag); break;
      case "--paid-through": out.change.paidThrough = parseDate(v, flag); break;
      case "--status":
        if (!(STATUSES as readonly string[]).includes(v)) throw new Error(`--status: one of ${STATUSES.join(", ")}`);
        out.change.status = v as SubscriptionChange["status"]; break;
      case "--note":
        if (v.length > 500) throw new Error("--note: at most 500 characters");
        out.change.note = v; break;
      default: throw new Error(`unknown option ${flag}`);
    }
  }
  if (!out.firm) throw new Error("--firm <slug> is required");
  return { firm: out.firm, show: out.show, change: out.change };
}

/** Applies a change to the firm with this slug, keeping whatever isn't given. Returns the firm's row after. */
export async function setSubscription(client: pg.ClientBase, slug: string, c: SubscriptionChange) {
  const f = (await client.query("SELECT id, plan, seat_limit, trial_ends_at, paid_through, status FROM huis.firms WHERE slug = $1", [slug])).rows[0];
  if (!f) throw new Error(`no firm with the slug ${slug}`);
  const keep = <T>(v: T | undefined, current: T): T => (v === undefined ? current : v);
  await client.query("SELECT huis.operator_set_subscription($1, $2, $3, $4, $5, $6, $7)", [
    f.id, keep(c.plan, f.plan), keep(c.seats, f.seat_limit), keep(c.trialEnds, f.trial_ends_at),
    keep(c.paidThrough, f.paid_through), keep(c.status, f.status), c.note ?? null,
  ]);
  return (await client.query("SELECT slug, plan, seat_limit, trial_ends_at, paid_through, status FROM huis.firms WHERE id = $1", [f.id])).rows[0];
}

async function main() {
  const { firm, show, change } = parseArgs(process.argv.slice(2));
  const url = process.env.HUIS_MIGRATION_DATABASE_URL;
  if (!url) throw new Error("HUIS_MIGRATION_DATABASE_URL is not set");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    if (show || Object.keys(change).length === 0) {
      const r = (await client.query("SELECT slug, name, plan, seat_limit, trial_ends_at, paid_through, status FROM huis.firms WHERE slug = $1", [firm])).rows[0];
      if (!r) throw new Error(`no firm with the slug ${firm}`);
      console.log(r);
      return;
    }
    console.log(await setSubscription(client, firm, change));
  } finally {
    await client.end();
  }
}

if (process.argv[1] && /set-subscription\.ts$/.test(process.argv[1])) {
  main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
}
