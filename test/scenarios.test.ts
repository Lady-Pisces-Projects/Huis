import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyChanges, parseChanges, readiness, whatIf } from "../src/intelligence/scenarios";
import { analyze, type ElementIn, type FactIn, type MatterIn } from "../src/intelligence/strength";
import { trialReadiness, whatIfAnalysis } from "../src/services/caseStrength";
import { createClient } from "../src/services/clients";
import { addClaimFromTemplate, addNode, claimView, linkNodes } from "../src/services/dna";
import { acceptInvitation } from "../src/services/firms";
import { addMatterMember, createMatter } from "../src/services/matters";
import { inviteUser } from "../src/services/users";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

/* Phase 11 part 4: What-If Analysis and Trial Readiness (src/intelligence/scenarios.ts). */

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const src = (id: string) => ({ kind: "document" as const, id, title: `${id}.pdf`, quote: "q", evidenceId: id, noteId: null });
const fact = (id: string, label: string, sources: FactIn["sources"], witnesses: FactIn["witnesses"] = []): FactIn => ({ id, label, sources, witnesses });
const el = (id: string, label: string, supporting: FactIn[] = [], contradicting: FactIn[] = []): ElementIn => ({ id, label, details: "", supporting, contradicting, pendingSuggestions: 0 });

function matter(): MatterIn {
  return {
    matterId: "m1",
    claims: [{ id: U(1), kind: "claim", label: "FMLA retaliation", details: "", authorities: [{ citation: "29 U.S.C. § 2615", url: "", verified: true, stance: "supports" }], elements: [
      el(U(10), "Protected activity", [fact(U(20), "Pat requested FMLA leave", [src("e1"), src("e2")], [{ id: U(30), label: "Sam Coworker" }])]),
      el(U(11), "Adverse action", [fact(U(21), "Pat was terminated", [src("e3")])], [fact(U(22), "HR says it was planned in March", [src("e4")])]),
      el(U(12), "Causal connection"),
    ] }],
    damages: [{ id: "d1", label: "Lost wages", amount: 52000, sources: 1 }, { id: "d2", label: "Benefits", amount: null, sources: 0 }],
    contradictions: { confirmed: 0, potential: 0 },
    pending: { suggestedFacts: 0, suggestedLinks: 0, suggestedOther: 0 },
    evidence: { total: 4, unread: 1 },
  };
}

describe("What if? (rules)", () => {
  it("a new email on an unsupported element raises its score and closes the hole; nothing in the Matter changes", () => {
    const m = matter();
    const copy = JSON.stringify(m);
    const r = whatIf(m, [{ kind: "add-document", id: U(12) }]);
    expect(r.elements).toEqual([expect.objectContaining({ label: "Causal connection", before: 0, after: 65 })]);
    expect(r.claims[0]!.before.rating).toBe("Weak");
    expect(r.gapsClosed.map((g) => g.elementId)).toContain(U(12));
    expect(r.assumptions[0]).toContain('"Causal connection" (FMLA retaliation)');
    expect(JSON.stringify(m)).toBe(copy); // assumptions never touch the real evidence
  });

  it("losing a witness or a fact lowers the score; removing a contradicting fact raises it", () => {
    const m = matter();
    expect(whatIf(m, [{ kind: "lose-witness", id: U(30) }]).elements[0]).toMatchObject({ label: "Protected activity", before: 90, after: 80 });
    expect(whatIf(m, [{ kind: "lose-fact", id: U(21) }]).elements[0]).toMatchObject({ label: "Adverse action", after: 0 });
    const resolved = whatIf(m, [{ kind: "lose-fact", id: U(22) }]).elements[0]!;
    expect(resolved.after).toBeGreaterThan(resolved.before);
  });

  it("refuses assumptions that don't belong to the Matter and more than 20 at once; parses only well-formed input", () => {
    const m = matter();
    expect(() => applyChanges(m, [{ kind: "add-document", id: U(99) }])).toThrow(RangeError);
    expect(() => applyChanges(m, [{ kind: "lose-witness", id: U(10) }])).toThrow(RangeError); // an element isn't a witness
    expect(() => applyChanges(m, Array.from({ length: 21 }, () => ({ kind: "add-document" as const, id: U(12) })))).toThrow(/at most 20/);
    expect(parseChanges([`add-document:${U(12)}`, `add-document:${U(12)}`, "drop:x", `lose-fact:${U(21)}'--`, "add-witness:not-a-uuid"])).toEqual([{ kind: "add-document", id: U(12) }]);
  });
});

describe("Trial readiness (rules)", () => {
  it("scores only what it can measure, names the weakest category, and never guesses discovery", () => {
    const m = matter();
    const r = readiness(m, analyze(m), [{ id: "p", kind: "person", label: "Dr. Lee", role: "Damages expert", links: [] }]);
    const c = Object.fromEntries(r.categories.map((x) => [x.key, x.value]));
    expect(c).toEqual({ discovery: null, witnesses: 50, exhibits: 67, research: 100, experts: 100, damages: 50 });
    expect(r.score).toBe(73); // (50 + 67 + 100 + 100 + 50) / 5
    expect(r.weakest!.key).toBe("witnesses");
    expect(r.why).toMatch(/Discovery not measured/);
    expect(r.categories.find((x) => x.key === "exhibits")!.why).toMatch(/1 uploaded item hasn't been read/);
    expect(JSON.stringify(r)).not.toMatch(/probability|will win/i);
  });

  it("with no claim elements there is nothing to measure", () => {
    const m = { ...matter(), claims: [] };
    expect(readiness(m, analyze(m), []).score).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });

describe("on a Matter", () => {
  it("works from confirmed Case DNA, changes nothing, and only for firm staff who can see the Matter", async () => {
    const f = await newFirm(t.db);
    const x = await t.db.withFirm(f.owner, async (s) => {
      const client = await createClient(s, { kind: "person", displayName: "Pat Smith", email: "pat@example.com" });
      const matter = await createMatter(s, { title: "Smith v. Acme", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
      const portal = await inviteUser(s, { email: `c@${f.slug}.example`, fullName: "Casey Client", role: "client", locationId: f.locationId });
      const claimId = await addClaimFromTemplate(s, matter.id, "fmla_retaliation");
      const adverse = (await claimView(s, claimId)).elements[1]!.element;
      const firing = await addNode(s, matter.id, { kind: "fact", label: "Pat was terminated on April 18" });
      await linkNodes(s, firing, adverse.id, "supports");
      return { matter, portal, adverse: adverse.id };
    });
    const portal = (await acceptInvitation(t.db, x.portal.invitationToken, "google", String(10n ** 20n + BigInt(randomBytes(5).readUIntBE(0, 5)))))!;
    await t.db.withFirm(f.owner, (s) => addMatterMember(s, { matterId: x.matter.id, userId: x.portal.id, access: "view", acknowledgePrivilegeWaiverRisk: true }));

    const count = () => t.db.withFirm(f.owner, async (s) => (await s.client.query("SELECT count(*)::int AS n FROM huis.dna_nodes WHERE matter_id = $1", [x.matter.id])).rows[0].n);
    const before = await count();
    const r = await t.db.withFirm(f.owner, (s) => whatIfAnalysis(s, x.matter.id, [{ kind: "add-document", id: x.adverse }]));
    expect(r.result!.elements).toEqual([expect.objectContaining({ label: "Adverse action", before: 40, after: 65 })]);
    expect(await count()).toBe(before);
    await expect(t.db.withFirm(f.owner, (s) => whatIfAnalysis(s, x.matter.id, [{ kind: "add-document", id: U(5) }]))).rejects.toThrow(/doesn't belong/);

    const ready = await t.db.withFirm(f.owner, (s) => trialReadiness(s, x.matter.id));
    expect(ready.categories.find((c) => c.key === "discovery")!.value).toBeNull();
    expect(ready.score).not.toBeNull();

    await expect(t.db.withFirm(portal, (s) => whatIfAnalysis(s, x.matter.id, []))).rejects.toThrow();
    await expect(t.db.withFirm(portal, (s) => trialReadiness(s, x.matter.id))).rejects.toThrow();
  });
});
