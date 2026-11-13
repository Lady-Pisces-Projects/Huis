/**
 * Phase 10 part 2b check against the full made-up firm from seed.ts (mailboxes, integrations, working copies,
 * court dates, invoices, AI, Case DNA...): turns it into an unpaid trial past its deletion date with its warnings
 * sent, deletes it through the worker's function, and lists any row left anywhere. Made-up data only.
 *   npx tsx scripts/qa/seed.ts && npx tsx scripts/qa/deletion-check.ts
 */
import { readFile } from "node:fs/promises";
import pg from "pg";

async function main() {
  const state = JSON.parse(await readFile(process.env.HUIS_QA_STATE ?? "qa-state.json", "utf8"));
  const base = new URL(process.env.HUIS_QA_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5433/postgres");
  base.pathname = `/${state.dbName}`;
  const admin = new pg.Client({ connectionString: base.toString() });
  await admin.connect();
  const firmId = (await admin.query("SELECT firm_id FROM huis.matters WHERE id = $1", [state.matterId])).rows[0].firm_id as string;

  const counts = async () => {
    const tables = (await admin.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'huis' AND c.relkind IN ('r','p') AND c.relname NOT IN ('firm_deletions','platform_audit')
         AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'firm_id' AND NOT a.attisdropped)`)).rows;
    const out: Record<string, number> = {};
    for (const { relname } of tables) {
      const n = Number((await admin.query(`SELECT count(*) FROM huis.${relname} WHERE firm_id = $1`, [firmId])).rows[0].count);
      if (n) out[relname] = n;
    }
    out.firms = Number((await admin.query("SELECT count(*) FROM huis.firms WHERE id = $1", [firmId])).rows[0].count);
    for (const t of ["evidence_lsh", "unpack_counters", "bates_counters", "mail_credentials", "integration_credentials", "integration_listing_items"]) {
      out[`(all) ${t}`] = Number((await admin.query(`SELECT count(*) FROM huis.${t}`)).rows[0].count);
    }
    return out;
  };
  console.log("before:", JSON.stringify(await counts()));

  // Setup only (superuser, triggers off for this one statement set): an unpaid trial that ended 31 days ago.
  await admin.query("BEGIN; SET LOCAL session_replication_role = replica; UPDATE huis.firms SET plan = 'trial', first_paid_at = NULL, trial_ends_at = now() - interval '745 hours', paid_through = NULL WHERE id = $1; COMMIT;".replace("$1", `'${firmId}'`));
  // A deletion round that started 15 days ago, its date just passed, with its warnings sent on time.
  await admin.query(`INSERT INTO huis.firm_deletion_rounds (firm_id, base_after, delete_on, started_at)
      VALUES ($1, huis.firm_trial_delete_base($1), now() - interval '1 hour', now() - interval '15 days')`, [firmId]);
  await admin.query(`INSERT INTO huis.firm_deletion_notices (firm_id, user_id, days_before, for_delete_after, status, sent_at)
      SELECT $1, u.id, k.d, r.delete_on, 'sent', r.delete_on - make_interval(days => k.d)
        FROM huis.firm_deletion_rounds r JOIN huis.users u ON u.firm_id = r.firm_id AND u.role = 'firm_owner'
        CROSS JOIN (VALUES (14), (7), (1)) k(d) WHERE r.firm_id = $1`, [firmId]);

  await admin.query("SET ROLE huis_worker");
  const prefix = (await admin.query("SELECT huis.worker_delete_firm($1) AS p", [firmId])).rows[0].p;
  await admin.query("RESET ROLE");
  console.log("deleted, file prefix:", prefix);
  const after = await counts();
  console.log("after:", JSON.stringify(after));
  const left = Object.entries(after).filter(([k, v]) => !k.startsWith("(all)") && v > 0);
  console.log(left.length === 0 ? "OK: no rows left for the firm" : `LEFT: ${JSON.stringify(left)}`);
  console.log("tombstone:", JSON.stringify((await admin.query("SELECT * FROM huis.firm_deletions WHERE firm_id = $1", [firmId])).rows[0]));
  await admin.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
