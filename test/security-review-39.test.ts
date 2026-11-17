/**
 * Independent security review 39: whole-product, end-to-end review before launch (17 November 2026).
 *
 * The first block is the standing check asked for in this review (row-level security on every firm table); it
 * passes today and guards against a future table being added without it. Every test after that FAILS on the
 * reviewed tree and shows one finding; it passes once that finding is fixed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { HuisDb } from "../src/db/tenant";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

// Route handlers import server-only modules; stand them in so the routes themselves can be exercised.
const fake = vi.hoisted(() => ({ session: null as null | Record<string, unknown>, db: null as unknown }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock("../lib/server", () => ({
  getSession: async () => fake.session,
  db: () => fake.db,
  clientIp: () => undefined,
  userMessage: () => "Something went wrong. Please try again.",
  setFlash: async () => "f",
  setPendingCookie: async () => undefined,
  setSessionCookie: async () => undefined,
}));

const BASE = "https://app.huis.test";
let t: TestDatabase;
let db: HuisDb;

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
  fake.db = db;
  process.env.HUIS_BASE_URL = BASE;
  process.env.HUIS_SESSION_SECRET = Buffer.alloc(32, 7).toString("base64");
  process.env.MICROSOFT_CLIENT_ID = "00000000-0000-4000-8000-000000000001";
  process.env.MICROSOFT_CLIENT_SECRET = "test-only";
  (await import("../src/auth/config")).resetAuthConfig();
});
afterAll(async () => { await t?.drop(); });

/** A 16 MB request body that counts how much of it the server pulls. */
function countingBody(total = 16 * 1024 * 1024, chunk = 64 * 1024) {
  const state = { pulled: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (state.pulled >= total) { c.close(); return; }
      state.pulled += chunk;
      c.enqueue(new Uint8Array(chunk).fill(0x61));
    },
  });
  return { body, state };
}
const post = (path: string, body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
  new Request(`${BASE}${path}`, { method: "POST", body, headers, duplex: "half" } as RequestInit) as never;

// ---------------------------------------------------------------------------------------------------------------
describe("Standing check: row-level security on every table holding firm data", () => {
  const APP_ROLES = ["huis_app", "huis_worker", "huis_billing", "huis_platform"];

  it("every table in schema huis with a firm_id column has RLS enabled AND forced, or no role but huis_security can touch it", async () => {
    const { rows } = await t.admin.query<{ t: string; rls: boolean; forced: boolean; reachable: string[] }>(`
      SELECT c.relname AS t, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             ARRAY(SELECT r FROM unnest($1::text[]) r
                    WHERE has_table_privilege(r, c.oid, 'SELECT') OR has_table_privilege(r, c.oid, 'INSERT')
                       OR has_table_privilege(r, c.oid, 'UPDATE') OR has_table_privilege(r, c.oid, 'DELETE')
                       OR has_any_column_privilege(r, c.oid, 'SELECT') OR has_any_column_privilege(r, c.oid, 'UPDATE')) AS reachable
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'huis' AND c.relkind IN ('r', 'p')
         AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'firm_id' AND NOT a.attisdropped)
       ORDER BY 1`, [APP_ROLES]);
    expect(rows.length).toBeGreaterThan(50);
    const bad = rows.filter((r) => !(r.rls && r.forced) && r.reachable.length > 0).map((r) => `${r.t} (reachable by ${r.reachable.join(", ")})`);
    expect(bad).toEqual([]);
    // The private ones (no RLS, reached only through SECURITY DEFINER functions) are exactly these today.
    expect(rows.filter((r) => !(r.rls && r.forced)).map((r) => r.t).sort()).toEqual([
      "ai_question_tally", "case_description_runs", "firm_deletion_failures", "firm_deletion_in_progress",
      "firm_deletions", "firm_signin_rules", "invoice_counters", "platform_audit",
    ].filter((x) => rows.some((r) => r.t === x)));
  });

  it("every other table any Huis login role can reach has RLS enabled and forced (except public reference data)", async () => {
    const REFERENCE = ["plans", "federal_cases", "federal_imports"];
    const { rows } = await t.admin.query<{ t: string }>(`
      SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'huis' AND c.relkind IN ('r', 'p') AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
         AND EXISTS (SELECT 1 FROM unnest($1::text[]) r WHERE has_table_privilege(r, c.oid, 'SELECT')
                     OR has_table_privilege(r, c.oid, 'INSERT') OR has_table_privilege(r, c.oid, 'UPDATE')
                     OR has_table_privilege(r, c.oid, 'DELETE') OR has_any_column_privilege(r, c.oid, 'SELECT'))`, [[...APP_ROLES, "public"]]);
    expect(rows.map((r) => r.t).filter((x) => !REFERENCE.includes(x))).toEqual([]);
  });

  it("no Huis login role is a superuser, bypasses RLS, or can create objects in the database or the huis schema", async () => {
    const { rows } = await t.admin.query(`
      SELECT r.rolname, r.rolsuper, r.rolbypassrls, has_schema_privilege(r.rolname, 'huis', 'CREATE') AS mk,
             has_database_privilege(r.rolname, current_database(), 'CREATE') AS mkdb
        FROM pg_roles r WHERE r.rolname = ANY ($1)`, [APP_ROLES]);
    expect(rows.length).toBe(4);
    for (const r of rows) expect([r.rolsuper, r.rolbypassrls, r.mk, r.mkdb]).toEqual([false, false, false, false]);
  });

  it("every SECURITY DEFINER function pins its search_path and is owned by huis_security", async () => {
    const { rows } = await t.admin.query(`
      SELECT p.oid::regprocedure::text AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'huis' AND p.prosecdef
         AND (pg_get_userbyid(p.proowner) <> 'huis_security'
              OR NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%'))`);
    expect(rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("R39-1: routes read a request body of any size before checking who is asking (memory exhaustion; three need no sign-in)", () => {
  it("POST /api/uploads buffers the whole body (req.json) before the origin and session checks", async () => {
    const { POST } = await import("../app/api/uploads/route");
    const { body, state } = countingBody();
    // No cookie, no Origin: an anonymous request from anywhere.
    const res: Response = await POST(post("/api/uploads", body, { "content-type": "application/json" }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(state.pulled).toBeLessThanOrEqual(1024 * 1024);
  });

  it("POST /api/matters/[id]/export buffers the whole form (req.formData) before the origin and session checks", async () => {
    const { POST } = await import("../app/api/matters/[id]/export/route");
    const { body, state } = countingBody();
    const res: Response = await POST(post("/api/matters/00000000-0000-4000-8000-000000000000/export", body,
      { "content-type": "application/x-www-form-urlencoded" }), { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000000" }) });
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(state.pulled).toBeLessThanOrEqual(1024 * 1024);
  });

  it("POST /api/auth/microsoft/start (invitation button) buffers the whole form once the Origin header matches, which any non-browser client can send", async () => {
    const { POST } = await import("../app/api/auth/microsoft/start/route");
    const { body, state } = countingBody();
    await POST(post("/api/auth/microsoft/start", body, { "content-type": "application/x-www-form-urlencoded", origin: BASE })).catch(() => undefined);
    expect(state.pulled).toBeLessThanOrEqual(1024 * 1024);
  });

  it("POST /api/evidence/[id]/annotations: a chunked body (no Content-Length) skips the 16 KB check and is read whole", async () => {
    const f = await newFirm(db);
    const sessionVersion = await db.withFirm(f.owner, async (s) => s.actor.sessionVersion);
    fake.session = { firmId: f.firmId, userId: f.ownerUserId, provider: "microsoft", subject: "s", sessionVersion };
    try {
      const { POST } = await import("../app/api/evidence/[id]/annotations/route");
      const { body, state } = countingBody();
      const res: Response = await POST(post("/api/evidence/00000000-0000-4000-8000-000000000000/annotations", body,
        { "content-type": "application/json", origin: BASE }), { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000000" }) });
      expect(res.status).toBe(413);
      // Bounded: one 64 KB piece past the limit plus the stream's own read-ahead, never the whole 16 MB.
      expect(state.pulled).toBeLessThanOrEqual(256 * 1024);
    } finally {
      fake.session = null;
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("R39-2: dependencies — next 16.4.3 is inside GHSA-mfr8-8qww-v76h (16.3.0–16.4.4)", () => {
  it("the installed next is 16.4.5 or later", () => {
    const v = JSON.parse(readFileSync(join(__dirname, "..", "node_modules", "next", "package.json"), "utf8")).version as string;
    const [maj, min, pat] = v.split(/[.-]/).map(Number) as [number, number, number];
    const ok = maj > 16 || (maj === 16 && (min > 4 || (min === 4 && pat >= 5)));
    expect(ok, `next ${v}`).toBe(true);
  });
});
