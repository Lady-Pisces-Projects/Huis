import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discovery, opposition, productionRequest, type PersonIn } from "../src/intelligence/discovery";
import { analyze, type ElementIn, type FactIn, type MatterIn } from "../src/intelligence/strength";
import { discoveryAndOpposition } from "../src/services/caseStrength";
import { createClient } from "../src/services/clients";
import { addClaimFromTemplate, addNode, claimView, linkNodes } from "../src/services/dna";
import { acceptInvitation } from "../src/services/firms";
import { addMatterMember, createMatter } from "../src/services/matters";
import { inviteUser } from "../src/services/users";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

/* Phase 11 part 2: "What are we missing?" and "If I were opposing counsel" (src/intelligence/discovery.ts). */

const src = (id: string, kind: "document" | "email" | "note" = "document") => ({ kind, id, title: `${id}.pdf`, quote: "q", evidenceId: kind === "note" ? null : id, noteId: kind === "note" ? id : null });
const fact = (id: string, label: string, sources: FactIn["sources"], witnesses: FactIn["witnesses"] = []): FactIn => ({ id, label, sources, witnesses });
const el = (id: string, label: string, supporting: FactIn[] = [], contradicting: FactIn[] = []): ElementIn => ({ id, label, details: "", supporting, contradicting, pendingSuggestions: 0 });

function matter(): { m: MatterIn; people: PersonIn[] } {
  const m: MatterIn = {
    matterId: "m1",
    claims: [
      { id: "c1", kind: "claim", label: "FMLA retaliation", details: "", authorities: [], elements: [
        el("e1", "Protected activity", [fact("f1", "Pat requested FMLA leave on April 2", [src("leave-email", "email"), src("hr-form")])]),
        el("e2", "Adverse action", [fact("f2", "Pat was terminated on April 18", [src("termination-letter")])], [fact("f3", "HR says the termination was planned in March", [src("hr-notes")])]),
        el("e3", "Causal connection"),
      ] },
      { id: "d1", kind: "defense", label: "Legitimate business reason", details: "", authorities: [], elements: [
        el("e9", "Performance problems", [fact("f9", "A written warning in January", [src("warning")])]),
      ] },
    ],
    damages: [{ id: "dm1", label: "Lost wages", amount: 52000, sources: 1 }],
    contradictions: { confirmed: 0, potential: 0 },
    pending: { suggestedFacts: 0, suggestedLinks: 0, suggestedOther: 0 },
    evidence: { total: 5, unread: 0 },
  };
  const people: PersonIn[] = [
    { id: "p1", kind: "person", label: "Cindy Manager", role: "HR Director", links: [{ factId: "f2", relation: "involves" }, { factId: "f3", relation: "witness_to" }] },
    { id: "p2", kind: "person", label: "Sam Supervisor", role: null, links: [{ factId: "f9", relation: "witness_to" }] },
    { id: "p3", kind: "person", label: "Unlinked Person", role: null, links: [] },
    { id: "o1", kind: "organization", label: "Acme Payroll Services", role: null, links: [] },
  ];
  return { m, people };
}

describe("What are we missing? (rules)", () => {
  it("drafts requests for the elements without enough documents, and admissions from documented facts", () => {
    const { m, people } = matter();
    const d = discovery(m, analyze(m), people, 2);
    expect(d.documents.map((x) => x.text)).toEqual(expect.arrayContaining([productionRequest("Causal connection", ""), productionRequest("Adverse action", "")]));
    expect(d.documents.some((x) => x.basis.includes("Protected activity"))).toBe(false); // two sources already
    expect(d.admissions[0]!.text).toBe("Admit that Pat requested FMLA leave on April 2.");
    expect(d.admissions.some((a) => a.text.includes('"termination-letter.pdf" is a true and correct copy'))).toBe(true);
    expect(d.admissions.every((a) => a.basis.length > 0)).toBe(true);
  });

  it("names deposition targets with the reasons, witness gaps, organizations, experts and documents to authenticate", () => {
    const { m, people } = matter();
    const d = discovery(m, analyze(m), people, 2);
    expect(d.depositions[0]!.title).toBe("Cindy Manager");
    expect(d.depositions[0]!.reasons.join(" ")).toMatch(/contradicting "Adverse action"/);
    expect(d.depositions.map((p) => p.title)).toContain("Sam Supervisor"); // tied to the defense
    expect(d.witnessGaps.map((w) => w.title)).toEqual(expect.arrayContaining(["Unlinked Person", "2 people suggested by Huis"]));
    expect(d.organizations[0]!.detail).toMatch(/subpoena/);
    expect(d.experts[0]!.detail).toMatch(/\$52,000/);
    expect(d.authentication.map((a) => a.title)).toEqual(expect.arrayContaining(["leave-email.pdf (email)", "termination-letter.pdf"]));
    expect(d.notTracked.join(" ")).toMatch(/doesn't track/); // what it can't see is said, not invented
  });
});

describe("If I were opposing counsel (rules)", () => {
  it("leads with the strongest argument, explains why, and says how to counter it", () => {
    const { m } = matter();
    const o = opposition(m, analyze(m));
    expect(o.points[0]).toMatchObject({ severity: "Critical" });
    expect(o.points[0]!.argument).toContain("Causal connection");
    const keys = o.points.map((p) => p.key);
    expect(keys).toEqual(expect.arrayContaining(["single:e2", "credibility:e2", "defense:d1", "alternative-cause", "mitigation"]));
    expect(o.points.every((p) => p.why.length && p.counter.length)).toBe(true);
    expect(o.points.find((p) => p.key === "credibility:e2")!.why[0]).toContain("planned in March");
    expect(o.notChecked.join(" ")).toMatch(/limitations/);
    expect(JSON.stringify(o)).not.toMatch(/probability|will win|likely to lose/i);
  });

  it("doesn't flag mitigation once a job search is recorded, and flags speculative damages when none are recorded", () => {
    const { m } = matter();
    m.damages.push({ id: "dm2", label: "Mitigation: job search costs", amount: 300, sources: 1 });
    expect(opposition(m, analyze(m)).points.map((p) => p.key)).not.toContain("mitigation");
    m.damages = [];
    expect(opposition(m, analyze(m)).points.map((p) => p.key)).toContain("damages-speculative");
  });
});

// ---------------------------------------------------------------------------------------------------------------
let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });

describe("on a Matter", () => {
  it("works from confirmed Case DNA, and only for firm staff who can see the Matter", async () => {
    const f = await newFirm(t.db);
    const x = await t.db.withFirm(f.owner, async (s) => {
      const client = await createClient(s, { kind: "person", displayName: "Pat Smith", email: "pat@example.com" });
      const matter = await createMatter(s, { title: "Smith v. Acme", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
      const portal = await inviteUser(s, { email: `c@${f.slug}.example`, fullName: "Casey Client", role: "client", locationId: f.locationId });
      const claimId = await addClaimFromTemplate(s, matter.id, "fmla_retaliation");
      const view = await claimView(s, claimId);
      const adverse = view.elements[1]!.element;
      const firing = await addNode(s, matter.id, { kind: "fact", label: "Pat was terminated on April 18" });
      await linkNodes(s, firing, adverse.id, "supports");
      const planned = await addNode(s, matter.id, { kind: "fact", label: "HR says it was planned in March" });
      await linkNodes(s, planned, adverse.id, "contradicts");
      const cindy = await addNode(s, matter.id, { kind: "person", label: "Cindy Manager", role: "HR Director" });
      await linkNodes(s, cindy, planned, "witness_to");
      return { matter, portal };
    });
    const portal = (await acceptInvitation(t.db, x.portal.invitationToken, "google", String(10n ** 20n + BigInt(randomBytes(5).readUIntBE(0, 5)))))!;
    await t.db.withFirm(f.owner, (s) => addMatterMember(s, { matterId: x.matter.id, userId: x.portal.id, access: "view", acknowledgePrivilegeWaiverRisk: true }));

    const r = await t.db.withFirm(f.owner, (s) => discoveryAndOpposition(s, x.matter.id));
    expect(r.discovery.depositions.map((p) => p.title)).toEqual(["Cindy Manager"]);
    expect(r.opposition.points.map((p) => p.key)).toEqual(expect.arrayContaining([`credibility:${(await t.db.withFirm(f.owner, async (s) => (await s.client.query("SELECT id FROM huis.dna_nodes WHERE label = 'Adverse action' AND matter_id = $1", [x.matter.id])).rows[0].id))}`]));
    expect(r.opposition.points[0]!.severity).toBe("Critical");
    await expect(t.db.withFirm(portal, (s) => discoveryAndOpposition(s, x.matter.id))).rejects.toThrow();
  });
});
