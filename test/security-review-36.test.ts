import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discovery, opposition, productionRequest, type PersonIn } from "../src/intelligence/discovery";
import { analyze, type ElementIn, type FactIn, type MatterIn } from "../src/intelligence/strength";
import { discoveryAndOpposition } from "../src/services/caseStrength";
import { createClient } from "../src/services/clients";
import { addClaimFromTemplate, addNode, claimView, linkNodes } from "../src/services/dna";
import { createMatter } from "../src/services/matters";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

/*
 * Independent security review 36: Phase 11 part 2, "What are we missing?" and "If I were opposing counsel"
 * (src/intelligence/discovery.ts, src/services/caseStrength.ts discoveryAndOpposition/gather, the two pages).
 * Each test fails today and passes once its problem is fixed.
 */

const doc = (id: string, kind: "document" | "email" | "note" = "document") => ({
  kind, id, title: `${id}.pdf`, quote: "q", evidenceId: kind === "note" ? null : id, noteId: kind === "note" ? id : null,
});
const fact = (id: string, label: string, sources: FactIn["sources"] = [doc(`d-${id}`)], witnesses: FactIn["witnesses"] = []): FactIn => ({ id, label, sources, witnesses });
const el = (id: string, label: string, supporting: FactIn[] = [], contradicting: FactIn[] = []): ElementIn => ({ id, label, details: "", supporting, contradicting, pendingSuggestions: 0 });
const matter = (claims: MatterIn["claims"], damages: MatterIn["damages"] = [{ id: "dm", label: "Lost wages", amount: 52000, sources: 1 }]): MatterIn => ({
  matterId: "m1", claims, damages,
  contradictions: { confirmed: 0, potential: 0 }, pending: { suggestedFacts: 0, suggestedLinks: 0, suggestedOther: 0 }, evidence: { total: 5, unread: 0 },
});
const fmla = (protectedFact: FactIn): MatterIn["claims"][number] => ({
  id: "c1", kind: "claim", label: "FMLA retaliation", details: "", authorities: [], elements: [
    el("e1", "Protected activity", [protectedFact]),
    el("e2", "Adverse action", [fact("f2", "Pat was terminated on April 18")]),
    el("e3", "Causal connection", [fact("f3", "Cindy told Pat the leave was the problem")]),
  ],
});

describe("R36-1: the mitigation argument is silently dropped by ordinary facts that say nothing about a job search", () => {
  it("'applied for FMLA leave' (the protected activity in nearly every FMLA case) counts as a job search", () => {
    const m = matter([fmla(fact("f1", "Pat applied for FMLA leave on April 2"))]);
    // Nothing records a job search or new work, so opposing counsel's failure-to-mitigate argument should be listed.
    expect(opposition(m, analyze(m)).points.map((p) => p.key)).toContain("mitigation");
  });

  it("an HR investigation interview counts as a job interview", () => {
    const m = matter([fmla(fact("f1", "HR interviewed Pat about her complaint on March 3"))]);
    expect(opposition(m, analyze(m)).points.map((p) => p.key)).toContain("mitigation");
  });
});

describe("R36-2: a person tied to a contradicting fact is dropped from deposition targets when that fact is also linked elsewhere", () => {
  it("the fact contradicts 'Adverse action' in one claim and supports a plain element of another: only the last link is remembered", () => {
    const shared = fact("fx", "HR says the termination was planned in March");
    const m = matter([
      { id: "c1", kind: "claim", label: "FMLA retaliation", details: "", authorities: [], elements: [
        el("e1", "Protected activity", [fact("f1", "Pat requested FMLA leave")]),
        el("e2", "Adverse action", [fact("f2", "Pat was terminated on April 18")], [shared]),
      ] },
      { id: "c2", kind: "claim", label: "Title VII retaliation", details: "", authorities: [], elements: [
        el("e4", "Protected opposition or participation", [shared, fact("f4", "Pat complained of discrimination")]),
      ] },
    ]);
    const people: PersonIn[] = [{ id: "p1", kind: "person", label: "Cindy Manager", role: "HR Director", links: [{ factId: "fx", relation: "witness_to" }] }];
    const d = discovery(m, analyze(m), people, 0);
    // Cindy witnessed a fact that contradicts our "Adverse action" element: she is exactly who to depose.
    expect(d.depositions.map((p) => p.title)).toContain("Cindy Manager");
  });
});

describe("R36-3: the same request for admission is drafted more than once", () => {
  it("a fact supporting two elements yields two identical 'Admit that ...' drafts", () => {
    const shared = fact("fx", "Cindy told Pat on April 17 that her leave was the problem");
    const m = matter([{ id: "c1", kind: "claim", label: "FMLA retaliation", details: "", authorities: [], elements: [
      el("e1", "Protected activity", [shared]),
      el("e3", "Causal connection", [shared]),
    ] }]);
    const texts = discovery(m, analyze(m), [], 0).admissions.map((a) => a.text);
    expect(texts.length).toBe(new Set(texts).size);
  });
});

describe("R36-4: request-for-admission text is built from the fact label with broken punctuation", () => {
  it("a question label becomes 'Admit that Did ...?.' and a quoted label ends in '.\".'", () => {
    const m = matter([{ id: "c1", kind: "claim", label: "FMLA retaliation", details: "", authorities: [], elements: [
      el("e1", "Protected activity", [fact("f1", "Did HR know about the leave before April 18?")]),
      el("e2", "Adverse action", [fact("f2", 'Cindy wrote "We need to let Pat go."')]),
    ] }]);
    const texts = discovery(m, analyze(m), [], 0).admissions.map((a) => a.text).filter((t) => t.startsWith("Admit that ") && !t.includes("true and correct copy"));
    expect(texts.some((t) => /\?\.$/.test(t))).toBe(false);
    expect(texts.some((t) => /\."\.$/.test(t))).toBe(false);
  });
});

describe("R36-5: employment-only wording is applied to claims it doesn't fit", () => {
  it("the breach-of-contract template's 'Damages' element gets a request for payroll and benefits records, and mitigation is 'comparable work'", () => {
    // Breach of contract (Utah) is one of Huis's own claim templates (src/dna/templates.ts).
    expect(productionRequest("Damages", "Breach of contract (Utah)")).not.toMatch(/payroll|benefits/i);
    const m = matter([{ id: "c1", kind: "claim", label: "Breach of contract (Utah)", details: "", authorities: [], elements: [
      el("e1", "A contract", [fact("f1", "The supply agreement was signed on Jan 5")]),
      el("e2", "Breach", [fact("f2", "Acme stopped deliveries in March")]),
    ] }], [{ id: "dm", label: "Lost profits", amount: 80000, sources: 1 }]);
    const mit = opposition(m, analyze(m)).points.find((p) => p.key === "mitigation");
    expect(mit?.argument ?? "").not.toMatch(/comparable work/);
  });

  it("'Qualified for the position' (a Title VII discrimination element) is treated as a disability element and asks for a medical expert", () => {
    const m = matter([{ id: "c1", kind: "claim", label: "Title VII race discrimination", details: "", authorities: [], elements: [
      el("e1", "Member of a protected class", [fact("f1", "Pat is Black")]),
      el("e2", "Qualified for the position", [fact("f2", "Pat had ten years of experience")]),
    ] }]);
    expect(discovery(m, analyze(m), [], 0).experts.map((x) => x.title)).not.toContain("Medical");
  });
});

describe("R36-6: 'Documents to request' doesn't cover every thin element, unlike what the page and docs say", () => {
  it("two claims each with an unsupported causation element: only the first is named; the second claim gets no request or basis", () => {
    const m = matter([
      { id: "c1", kind: "claim", label: "FMLA retaliation", details: "", authorities: [], elements: [el("e1", "Causal connection")] },
      { id: "c2", kind: "claim", label: "Title VII retaliation", details: "", authorities: [], elements: [el("e2", "Causal connection")] },
    ]);
    const bases = discovery(m, analyze(m), [], 0).documents.map((x) => x.basis).join(" ");
    expect(bases).toContain("Title VII retaliation");
  });
});

// ---------------------------------------------------------------------------------------------------------------
let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });

describe("R36-7: 'not linked to any fact yet' is said of people who are linked", () => {
  it("a person who witnessed a confirmed fact (or event) that isn't behind a claim element is listed as linked to nothing", async () => {
    const f = await newFirm(t.db);
    const matterId = await t.db.withFirm(f.owner, async (s) => {
      const client = await createClient(s, { kind: "person", displayName: "Pat Smith", email: "pat@example.com" });
      const m = await createMatter(s, { title: "Smith v. Acme", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
      const claimId = await addClaimFromTemplate(s, m.id, "fmla_retaliation");
      const adverse = (await claimView(s, claimId)).elements[1]!.element;
      const firing = await addNode(s, m.id, { kind: "fact", label: "Pat was terminated on April 18" });
      await linkNodes(s, firing, adverse.id, "supports");
      // A confirmed fact on the timeline, not (yet) linked to an element, and a confirmed event.
      const meeting = await addNode(s, m.id, { kind: "fact", label: "Cindy and Sam met about Pat on April 10" });
      const call = await addNode(s, m.id, { kind: "event", label: "Phone call with Pat, April 16" });
      const sam = await addNode(s, m.id, { kind: "person", label: "Sam Supervisor" });
      await linkNodes(s, sam, meeting, "witness_to");
      await linkNodes(s, sam, call, "witness_to");
      return m.id;
    });
    const r = await t.db.withFirm(f.owner, (s) => discoveryAndOpposition(s, matterId));
    const sam = r.discovery.witnessGaps.find((w) => w.title === "Sam Supervisor");
    expect(sam?.detail ?? "").not.toMatch(/not linked to any fact/);
  });
});
