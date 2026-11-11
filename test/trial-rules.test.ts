import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { descriptionNoteText, MAX_SUGGESTIONS, suggestFromDescription } from "../src/dna/describe";
import { askMatter } from "../src/services/brain";
import { saveCaseDescription } from "../src/services/caseDescription";
import { createClient } from "../src/services/clients";
import { listNodes } from "../src/services/dna";
import { createMatter } from "../src/services/matters";
import { getSubscription } from "../src/services/subscription";
import { inviteUser } from "../src/services/users";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

let t: TestDatabase;
let db: HuisDb;
const DAY = 86_400_000;

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

const deleteAfter = async (owner: RequestContext) => (await db.withFirm(owner, (s) => getSubscription(s))).deleteAfter;

describe("deletion applies only to a trial that ends unpaid", () => {
  it("an unpaid trial: deleted 30 days after the trial's end", async () => {
    const f = await firmWithMatter();
    await asHuis("UPDATE huis.firms SET trial_ends_at = now() - interval '3 days' WHERE id = $1", [f.firmId]);
    const ends = (await t.admin.query("SELECT trial_ends_at FROM huis.firms WHERE id = $1", [f.firmId])).rows[0].trial_ends_at as Date;
    expect((await deleteAfter(f.owner))!.getTime() - ends.getTime()).toBe(30 * DAY);
  });

  it("a trial still running has no date", async () => {
    const f = await firmWithMatter();
    expect(await deleteAfter(f.owner)).toBeNull();
  });

  it("a firm that paid by agreement and then stopped is held, never deleted", async () => {
    const f = await firmWithMatter();
    await t.admin.query("SELECT huis.operator_set_subscription($1, 'professional', 5, NULL, now() - interval '60 days', 'active', 'invoice 1')", [f.firmId]);
    const sub = await db.withFirm(f.owner, (s) => getSubscription(s));
    expect(sub.paused).toMatch(/overdue/);
    expect(sub.deleteAfter).toBeNull();
  });

  it("once a firm has paid, moving it back to the trial doesn't make it deletable, and the app can't clear that", async () => {
    const f = await firmWithMatter();
    await t.admin.query("SELECT huis.operator_set_subscription($1, 'professional', 5, NULL, now() + interval '30 days', 'active', 'paid')", [f.firmId]);
    const paid = (await t.admin.query("SELECT first_paid_at FROM huis.firms WHERE id = $1", [f.firmId])).rows[0].first_paid_at as Date;
    expect(paid).not.toBeNull();
    await t.admin.query("SELECT huis.operator_set_subscription($1, 'trial', NULL, now() - interval '5 days', NULL, 'active', 'demo again')", [f.firmId]);
    expect((await t.admin.query("SELECT first_paid_at FROM huis.firms WHERE id = $1", [f.firmId])).rows[0].first_paid_at).toEqual(paid);
    expect(await deleteAfter(f.owner)).toBeNull();
    await expect(db.withFirm(f.owner, (s) => s.client.query("UPDATE huis.firms SET first_paid_at = NULL WHERE id = $1", [f.firmId])))
      .rejects.toThrow(/managed by Huis/);
  });
});

describe("the trial's 100 AI questions are for the whole trial", () => {
  it("counts questions since sign-up on the trial (not per calendar month), with a plain message", async () => {
    await t.admin.query("UPDATE huis.plans SET ai_questions_per_month = 2 WHERE code = 'trial'");
    try {
      const f = await firmWithMatter();
      // One question asked last month still counts on the trial.
      await db.withFirm(f.owner, (s) => askMatter(s, f.matter.id, "What happened first?"));
      await t.admin.query("UPDATE huis.brain_answers SET created_at = date_trunc('month', now()) - interval '2 days' WHERE firm_id = $1", [f.firmId]);
      await asHuis("UPDATE huis.firms SET created_at = date_trunc('month', now()) - interval '5 days' WHERE id = $1", [f.firmId]);
      await db.withFirm(f.owner, (s) => askMatter(s, f.matter.id, "Who is the witness?"));
      await expect(db.withFirm(f.owner, (s) => askMatter(s, f.matter.id, "One more?")))
        .rejects.toThrow(/free trial includes 2 AI questions \(questions you ask Matter Brain or an AI agent\)/);
      expect((await db.withFirm(f.owner, (s) => getSubscription(s))).aiQuestions).toEqual({ usedThisMonth: 2, limitPerMonth: 2 });
    } finally {
      await t.admin.query("UPDATE huis.plans SET ai_questions_per_month = NULL WHERE code = 'trial'");
    }
  });
});

const DESCRIPTION = "Our client, Maria Lopez, was fired by Acme Trucking, Inc. on March 3, 2026, two weeks after returning from FMLA leave. " +
  "Her supervisor, Mr. Dale Hunt, had complained about her absences. She also says Dr. Alan Chu advised the leave.";

describe("reading a case description", () => {
  it("suggests the organization, people, dates and possible claims, each pointing to its words", () => {
    const { text } = descriptionNoteText(DESCRIPTION);
    const got = suggestFromDescription(text);
    const by = (k: string) => got.filter((g) => g.kind === k).map((g) => g.label);
    expect(by("organization")).toContain("Acme Trucking, Inc.");
    expect(by("person")).toEqual(expect.arrayContaining(["Mr. Dale Hunt", "Dr. Alan Chu"]));
    expect(by("claim")).toContain("FMLA retaliation");
    const event = got.find((g) => g.kind === "event")!;
    expect(event.date).toBe("2026-03-03");
    for (const g of got) expect(text.slice(g.start, g.end).length).toBeGreaterThan(0);
    expect(text.slice(got.find((g) => g.label === "Acme Trucking, Inc.")!.start).startsWith("Acme Trucking")).toBe(true);
  });

  it("covers other practice areas and stays bounded", () => {
    const pi = suggestFromDescription("Client was rear-ended on I-15 and suffered whiplash; she was hospitalized overnight.");
    expect(pi.map((g) => g.label)).toContain("Negligence (personal injury)");
    const family = suggestFromDescription("Wife seeks a divorce and primary custody of two children, plus child support.");
    expect(family.map((g) => g.label)).toEqual(expect.arrayContaining(["Divorce or legal separation", "Child custody and parent-time", "Child support or alimony"]));
    const many = Array.from({ length: 200 }, (_, i) => `Mr. Person${String.fromCharCode(65 + (i % 26))}${i} met on January ${(i % 28) + 1}, 2026.`).join(" ");
    expect(suggestFromDescription(many).length).toBeLessThanOrEqual(MAX_SUGGESTIONS);
    expect(suggestFromDescription("Nothing much to say here.")).toEqual([]);
  });

  it("creating a Matter with a description saves it as a note and adds suggestions to confirm in Case DNA, without using an AI question", async () => {
    const f = await firmWithMatter();
    const r = await db.withFirm(f.owner, (s) => saveCaseDescription(s, f.matter.id, DESCRIPTION));
    expect(r!.suggested).toBeGreaterThanOrEqual(5);
    const nodes = await db.withFirm(f.owner, (s) => listNodes(s, f.matter.id));
    const huis = nodes.filter((n) => n.origin === "huis" && n.status === "suggested");
    expect(huis.map((n) => n.label)).toEqual(expect.arrayContaining(["Acme Trucking, Inc.", "Mr. Dale Hunt", "FMLA retaliation"]));
    const cites = await t.admin.query("SELECT quote, note_id FROM huis.dna_citations WHERE matter_id = $1", [f.matter.id]);
    expect(cites.rows.every((c) => c.note_id === r!.noteId)).toBe(true);
    expect(cites.rows.map((c) => c.quote)).toContain("Acme Trucking, Inc.");
    const note = await t.admin.query("SELECT title, body FROM huis.matter_notes WHERE id = $1", [r!.noteId]);
    expect(note.rows[0]).toEqual({ title: "Case description", body: DESCRIPTION });
    expect((await db.withFirm(f.owner, (s) => getSubscription(s))).aiQuestions.usedThisMonth).toBe(0);
    // An empty description changes nothing.
    expect(await db.withFirm(f.owner, (s) => saveCaseDescription(s, f.matter.id, "   "))).toBeNull();
  });

  it("the quotes come from the stored note, never from the caller; offsets outside it are ignored", async () => {
    const f = await firmWithMatter();
    const r = await db.withFirm(f.owner, (s) => saveCaseDescription(s, f.matter.id, "A short note about nothing."));
    const n = await db.withFirm(f.owner, (s) => s.client.query("SELECT huis.suggest_from_case_description($1, $2::jsonb) AS n", [r!.noteId, JSON.stringify([
      { kind: "person", label: "Injected", start: 0, end: 4, quote: "something else entirely" },
      { kind: "person", label: "Out of range", start: 10, end: 999999 },
      { kind: "evidence", label: "Wrong kind", start: 0, end: 4 },
    ])]));
    expect(n.rows[0].n).toBe(1);
    const q = await t.admin.query("SELECT c.quote FROM huis.dna_citations c JOIN huis.dna_nodes d ON d.id = c.node_id WHERE d.label = 'Injected' AND c.matter_id = $1", [f.matter.id]);
    expect(q.rows[0].quote).toBe("Case");
  });

  it("only the note's own author, at the firm, can have it read; clients can't", async () => {
    const f = await firmWithMatter();
    await asHuis("UPDATE huis.firms SET seat_limit = 5 WHERE id = $1", [f.firmId]);
    const r = await db.withFirm(f.owner, (s) => saveCaseDescription(s, f.matter.id, DESCRIPTION));
    const para = await db.withFirm(f.owner, (s) => inviteUser(s, { email: `p@${f.slug}.example`, fullName: "Pat Para", role: "paralegal", locationId: f.locationId }));
    const client = await db.withFirm(f.owner, (s) => inviteUser(s, { email: `c@${f.slug}.example`, fullName: "Casey Client", role: "client", locationId: f.locationId }));
    const call = (ctx: RequestContext) => db.withFirm(ctx, (s) => s.client.query("SELECT huis.suggest_from_case_description($1, '[]'::jsonb)", [r!.noteId]));
    await expect(call(ctxOf(f.firmId, para.id))).rejects.toThrow();
    await expect(call(ctxOf(f.firmId, client.id))).rejects.toThrow();
    const other = await newFirm(db);
    await expect(call(other.owner)).rejects.toThrow();
  });
});
