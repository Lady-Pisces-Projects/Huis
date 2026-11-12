/**
 * Security review 28: Phase 10 part 2a (deletion only for unpaid trials, the trial's 100 AI questions for the
 * whole trial, reading a case description into Case DNA). Each test here FAILS on the reviewed working tree and
 * shows one finding; it passes once the finding is fixed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { MAX_DESCRIPTION, MAX_SUGGESTIONS } from "../src/dna/describe";
import { addNote, askMatter, deleteAnswer } from "../src/services/brain";
import { saveCaseDescription } from "../src/services/caseDescription";
import { createClient } from "../src/services/clients";
import { createMatter } from "../src/services/matters";
import { getSubscription } from "../src/services/subscription";
import { inviteUser } from "../src/services/users";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

let t: TestDatabase;
let db: HuisDb;

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
});
afterAll(async () => {
  await t?.drop();
});

const ctxOf = (firmId: string, userId: string): RequestContext => ({ firmId, userId });

async function asHuis(sql: string, params: unknown[]) {
  const c = await t.admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE huis_security");
    await c.query(sql, params);
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
}

async function firmWithMatter() {
  const f = await newFirm(db);
  const matter = await db.withFirm(f.owner, async (s) => {
    const client = await createClient(s, { kind: "person", displayName: "Maria Lopez" });
    return createMatter(s, { title: "Lopez v. Acme Trucking", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
  });
  return { ...f, matter };
}

const suggest = (ctx: RequestContext, noteId: string, items: unknown[]) =>
  db.withFirm(ctx, (s) => s.client.query<{ n: number }>("SELECT huis.suggest_from_case_description($1, $2::jsonb) AS n", [noteId, JSON.stringify(items)]))
    .then((r) => Number(r.rows[0]!.n), () => 0);

describe("security review 28", () => {
  it("R28-1: a staff member can't plant 'Huis suggested' items whose label, kind or date the cited words don't support", async () => {
    const f = await firmWithMatter();
    await asHuis("UPDATE huis.firms SET seat_limit = 5 WHERE id = $1", [f.firmId]);
    const para = await db.withFirm(f.owner, (s) => inviteUser(s, { email: `p@${f.slug}.example`, fullName: "Pat Para", role: "paralegal", locationId: f.locationId }));
    const pctx = ctxOf(f.firmId, para.id);
    // Any note the paralegal writes (not a case description) will do.
    const noteId = await db.withFirm(pctx, (s) => addNote(s, f.matter.id, { title: "Call log", body: "Spoke with the client on Tuesday." }));
    await suggest(pctx, noteId, [
      { kind: "claim", label: "Client admitted committing the fraud", start: 0, end: 4 },
      { kind: "person", label: "Judge Hart (conflict of interest)", start: 0, end: 4 },
      { kind: "event", label: "Client destroyed the emails", date: "2026-02-14", start: 10, end: 14 },
    ]);
    // These show as Huis's own suggestions (origin 'huis', no creator recorded), can't be edited until confirmed and
    // can't be deleted by anyone at the firm; nothing in the cited words ("Call", "Spok") supports them.
    const planted = await t.admin.query(
      `SELECT d.label FROM huis.dna_nodes d WHERE d.matter_id = $1 AND d.origin = 'huis'
          AND d.label IN ('Client admitted committing the fraud', 'Judge Hart (conflict of interest)', 'Client destroyed the emails')`, [f.matter.id]);
    expect(planted.rows).toEqual([]);
  });

  it("R28-2: one case description can't be replayed into thousands of suggestions (filling the Matter's cap so Huis stops suggesting from evidence)", async () => {
    const f = await firmWithMatter();
    const body = "The client explained what happened at work over several months. ".repeat(16); // ~1,000 characters
    const r = await db.withFirm(f.owner, (s) => saveCaseDescription(s, f.matter.id, body));
    const noteId = r!.noteId;
    const kinds = ["person", "organization", "claim"];
    let start = 0;
    for (let call = 0; call < 34; call++) {
      const items = Array.from({ length: 60 }, () => {
        const i = start++;
        return { kind: kinds[i % 3], label: `Item ${i}`, start: Math.floor(i / 3), end: Math.floor(i / 3) + 5 };
      });
      await suggest(f.owner, noteId, items);
    }
    const n = (await t.admin.query(
      "SELECT count(*)::int AS n FROM huis.dna_nodes WHERE matter_id = $1 AND origin = 'huis' AND status = 'suggested'", [f.matter.id])).rows[0].n;
    // worker_save_dna_suggestions refuses to suggest anything more once a Matter has 2,000 Huis suggestions.
    expect(n).toBeLessThanOrEqual(MAX_SUGGESTIONS);
  }, 120_000);

  it("R28-3: deleting your own Matter Brain answers doesn't give back trial AI questions", async () => {
    await t.admin.query("UPDATE huis.plans SET ai_questions_per_month = 2 WHERE code = 'trial'");
    try {
      const f = await firmWithMatter();
      await db.withFirm(f.owner, (s) => askMatter(s, f.matter.id, "What happened first?"));
      await db.withFirm(f.owner, (s) => askMatter(s, f.matter.id, "Who is the witness?"));
      await expect(db.withFirm(f.owner, (s) => askMatter(s, f.matter.id, "A third?"))).rejects.toThrow(/2 AI questions/);
      // Delete both answers (the "remove" button on my questions) and ask again, as often as wanted.
      const ids = (await t.admin.query("SELECT id FROM huis.brain_answers WHERE firm_id = $1", [f.firmId])).rows.map((x) => x.id as string);
      for (const id of ids) await db.withFirm(f.owner, (s) => deleteAnswer(s, id));
      await expect(db.withFirm(f.owner, (s) => askMatter(s, f.matter.id, "A third, after deleting?"))).rejects.toThrow(/2 AI questions/);
    } finally {
      await t.admin.query("UPDATE huis.plans SET ai_questions_per_month = NULL WHERE code = 'trial'");
    }
  });

  it("R28-4: a suggestion still quotes its own words when the description has an emoji or other character outside the BMP before them", async () => {
    const f = await firmWithMatter();
    const r = await db.withFirm(f.owner, (s) => saveCaseDescription(s, f.matter.id,
      "Client texted 😡😡 about it. She was fired by Acme Trucking, Inc. after FMLA leave."));
    const q = await t.admin.query(
      "SELECT c.quote FROM huis.dna_citations c JOIN huis.dna_nodes d ON d.id = c.node_id WHERE c.note_id = $1 AND d.label = 'Acme Trucking, Inc.'", [r!.noteId]);
    expect(q.rows[0]?.quote).toBe("Acme Trucking, Inc.");
  });

  it("R28-5: a description the form accepts (5,000 characters with line breaks) doesn't make creating the Matter fail", async () => {
    const f = await firmWithMatter();
    // The textarea's maxLength counts a line break as 1 character; the browser submits it as CR LF (2).
    const asTyped = Array.from({ length: 500 }, (_, i) => `Fact ${String(i).padStart(3, "0")}.`).join("\n"); // 4,999 as typed
    expect(asTyped.length).toBeLessThanOrEqual(MAX_DESCRIPTION);
    const asSubmitted = asTyped.replace(/\n/g, "\r\n");
    await expect(db.withFirm(f.owner, (s) => saveCaseDescription(s, f.matter.id, asSubmitted))).resolves.not.toBeNull();
  });

  it("R28-6: the promise 'once your firm has subscribed, Huis never deletes its cases' matches the code (only a first payment counts)", async () => {
    const f = await firmWithMatter();
    // Subscribes during the trial (Stripe 'trialing'), then cancels before paying anything.
    await asHuis("UPDATE huis.firms SET stripe_customer_id = 'cus_R28six' WHERE id = $1", [f.firmId]);
    await t.admin.query("SELECT huis.billing_apply_subscription($1, 'cus_R28six', 'sub_R28six', 'trialing', 'month', now() + interval '7 days', true)", [f.firmId]);
    await t.admin.query("SELECT huis.billing_apply_subscription($1, 'cus_R28six', 'sub_R28six', 'canceled', 'month', now() + interval '7 days', true)", [f.firmId]);
    await asHuis("UPDATE huis.firms SET trial_ends_at = now() - interval '1 day' WHERE id = $1", [f.firmId]);
    // The firm subscribed, yet it will be deleted (correctly, per R27-1: nothing was paid)...
    expect((await db.withFirm(f.owner, (s) => getSubscription(s))).deleteAfter).not.toBeNull();
    // ...so the page and the FAQ must not promise that subscribing alone protects the firm's cases.
    const page = readFileSync(join(__dirname, "../app/(app)/subscription/page.tsx"), "utf8");
    const faq = readFileSync(join(__dirname, "../docs/FAQ.md"), "utf8");
    expect(page.includes("Once your firm has subscribed, Huis never deletes")).toBe(false);
    expect(faq.includes("never deletes a subscribing firm")).toBe(false);
  });
});
