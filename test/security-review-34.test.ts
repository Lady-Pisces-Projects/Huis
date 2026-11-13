import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HuisDb } from "../src/db/tenant";
import { analyze, rateClaim, type ElementIn, type FactIn, type MatterIn } from "../src/intelligence/strength";
import { addAuthority, citeAuthority } from "../src/services/authorities";
import { caseStrength, reviewGap } from "../src/services/caseStrength";
import { createClient } from "../src/services/clients";
import { addClaimFromTemplate, addNode, claimView } from "../src/services/dna";
import { createMatter } from "../src/services/matters";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

/*
 * Independent security review 34: Case Outcome Intelligence, Phase 11 part 1 (src/intelligence/strength.ts,
 * src/services/caseStrength.ts, db/migrations/0045_case_strength.sql).
 * Each test fails today and passes once its problem is fixed.
 */

const doc = (id: string, kind: "document" | "email" | "note" = "document") => ({
  kind, id, title: `${id}.txt`, quote: "quote", evidenceId: kind === "note" ? null : id, noteId: kind === "note" ? id : null,
});
const fact = (id: string, sources: FactIn["sources"], witnesses: FactIn["witnesses"] = []): FactIn => ({ id, label: `Fact ${id}`, sources, witnesses });
const el = (label: string, supporting: FactIn[] = [], contradicting: FactIn[] = []): ElementIn => ({ id: `el-${label}`, label, details: "", supporting, contradicting, pendingSuggestions: 0 });
const W = [{ id: "p", label: "Jordan" }];
const full = (label: string) => el(label, [fact(`f-${label}`, [doc(`d1-${label}`), doc(`d2-${label}`), doc(`d3-${label}`)], W)]); // scores 100
const matter = (claims: MatterIn["claims"]): MatterIn => ({
  matterId: "m", claims, damages: [{ id: "dm", label: "Lost wages", amount: 1000, sources: 1 }],
  contradictions: { confirmed: 0, potential: 0 }, pending: { suggestedFacts: 0, suggestedLinks: 0, suggestedOther: 0 }, evidence: { total: 5, unread: 0 },
});

describe("R34-1: the overall rating can say Strong or Very strong while a claim is Weak or has nothing to measure", () => {
  it("one claim, one element with no support at all: the claim is Weak, the overall rating must not be Strong", () => {
    const r = analyze(matter([{ id: "c1", kind: "claim", label: "FMLA retaliation", details: "", authorities: [],
      elements: [full("Protected activity"), full("Adverse action"), el("Causal connection")] }]));
    expect(r.claims[0]!.rating).toBe("Weak");
    // Today: average 67 -> "Strong", on the same page as "FMLA retaliation — Weak" and a Critical gap.
    expect(["Strong", "Very strong"]).not.toContain(r.overall.rating);
  });

  it("a claim with no elements is left out of the average, so the overall reads Very strong on half the case", () => {
    const r = analyze(matter([
      { id: "c1", kind: "claim", label: "FMLA retaliation", details: "", authorities: [], elements: [full("A"), full("B")] },
      { id: "c2", kind: "claim", label: "ADA discrimination", details: "", authorities: [], elements: [] },
    ]));
    expect(r.overall.rating).not.toBe("Very strong");
  });
});

describe("R34-2: an attorney's own note is counted as an independent corroborating source", () => {
  it("one document plus an attorney note and a witness is rated Very strong as 'documents or emails from at least two independent sources'", () => {
    const c = rateClaim({ id: "c", kind: "claim", label: "FMLA retaliation", details: "", authorities: [], elements: [
      el("Adverse action", [fact("f1", [doc("d1")], W), fact("f2", [doc("n1", "note")])]),
    ] });
    // Only ONE document or email backs this element; the second "source" is the attorney's note.
    const claimsTwoDocuments = /documents or emails from at least two independent sources/.test(c.why);
    expect(c.rating === "Very strong" && claimsTwoDocuments).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
let t: TestDatabase;
let db: HuisDb;
beforeAll(async () => { t = await createTestDatabase(); db = t.db; });
afterAll(async () => { await t?.drop(); });

async function setup() {
  const f = await newFirm(db);
  await t.admin.query("SELECT huis.operator_set_subscription($1, 'professional', 10, NULL, now() + interval '1 year', 'active', 'test')", [f.firmId]);
  const m = await db.withFirm(f.owner, async (s) => {
    const client = await createClient(s, { kind: "person", displayName: "Pat Smith", email: "pat.smith@example.com" });
    return createMatter(s, { title: "Smith v. Acme", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
  });
  return { ...f, matter: m };
}

describe("R34-3: authorities cited for an element never reach 'Why did Huis say this?'", () => {
  it("the element's authority is dropped and the panel says 'No authorities cited for this claim yet'", async () => {
    const x = await setup();
    const claimId = await db.withFirm(x.owner, (s) => addClaimFromTemplate(s, x.matter.id, "fmla_retaliation"));
    const causal = (await db.withFirm(x.owner, (s) => claimView(s, claimId))).elements[2]!.element;
    await db.withFirm(x.owner, async (s) => {
      const a = await addAuthority(s, { kind: "case", citation: "Zephyrine v. Example Corp., 1 F.4th 2 (10th Cir. 2021)", url: "https://law.justia.com/cases/example/" });
      await citeAuthority(s, causal.id, { authorityId: a, stance: "supports", proposition: "Close timing can show causation." });
    });
    const r = await db.withFirm(x.owner, (s) => caseStrength(s, x.matter.id));
    // The claims matrix shows this authority on the element (and its "no legal authority cited" gap is gone);
    // the strength page's "Applicable law" for the same element says there are none.
    expect(JSON.stringify(r.claims[0])).toContain("Zephyrine");
  });
});

describe("R34-4: every claim is read twice, one query batch per claim, on every page view", () => {
  it("the number of queries grows with the number of claims (claimsMatrix's claimView loop plus caseStrength's own)", async () => {
    const x = await setup();
    const count = async () => db.withFirm(x.owner, async (s) => {
      let n = 0;
      const orig = s.client.query.bind(s.client);
      (s.client as unknown as { query: unknown }).query = (...a: unknown[]) => { n++; return (orig as (...b: unknown[]) => unknown)(...a); };
      await caseStrength(s, x.matter.id);
      return n;
    });
    await db.withFirm(x.owner, (s) => addClaimFromTemplate(s, x.matter.id, "fmla_retaliation"));
    const one = await count();
    for (let i = 0; i < 20; i++) await db.withFirm(x.owner, (s) => addNode(s, x.matter.id, { kind: "claim", label: `Claim ${i}` }));
    const many = await count();
    // Today 4 more queries per claim even with no elements (about 9 with facts); at 200 claims, thousands per view.
    expect(many - one).toBeLessThan(20);
  });
});

describe("R34-5: ALTER DEFAULT PRIVILEGES gives huis_security DELETE on every future table, add-only logs included", () => {
  it("a new platform-wide add-only table (no firm id, like platform_audit) is deletable by huis_security the moment it is created", async () => {
    const c = await t.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("CREATE TABLE huis.r34_platform_log (id bigserial PRIMARY KEY, what text NOT NULL)");
      const r = await c.query("SELECT has_table_privilege('huis_security', 'huis.r34_platform_log', 'DELETE') AS d");
      // Security review 32 (R32-5) revoked exactly this on platform_audit and firm_deletions; the default brings it back for
      // every new table. The trial deletion only needs tables with a firm id (already checked by test/trial-deletion.test.ts).
      expect(r.rows[0].d).toBe(false);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });
});

describe("R34-6: any gap key the regex allows can be stored, for gaps that don't exist", () => {
  it("staff can write unlimited made-up reviews (and the page loads all of them with no limit)", async () => {
    const x = await setup();
    await expect(db.withFirm(x.owner, (s) => reviewGap(s, x.matter.id, { gapKey: "made-up-gap", decision: "context", note: "x" }))).rejects.toThrow();
  });
});
