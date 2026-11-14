import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readiness, whatIf, whatIfOptions } from "../src/intelligence/scenarios";
import type { PersonIn } from "../src/intelligence/discovery";
import { analyze, type ElementIn, type FactIn, type MatterIn } from "../src/intelligence/strength";

/*
 * Independent security review 37: Phase 11 part 4, What if? and Trial readiness
 * (src/intelligence/scenarios.ts, src/services/caseStrength.ts whatIfAnalysis/trialReadiness, the two pages).
 * Each test fails today and passes once its problem is fixed.
 */

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const doc = (id: string) => ({ kind: "document" as const, id, title: `${id}.pdf`, quote: "q", evidenceId: id, noteId: null });
const fact = (id: string, label: string, sources: FactIn["sources"], witnesses: FactIn["witnesses"] = []): FactIn => ({ id, label, sources, witnesses });
const el = (id: string, label: string, supporting: FactIn[] = [], contradicting: FactIn[] = []): ElementIn => ({ id, label, details: "", supporting, contradicting, pendingSuggestions: 0 });
const base = (claims: MatterIn["claims"], damages: MatterIn["damages"] = [{ id: "d1", label: "Lost wages", amount: 52000, sources: 1 }]): MatterIn => ({
  matterId: "m1", claims, damages,
  contradictions: { confirmed: 0, potential: 0 }, pending: { suggestedFacts: 0, suggestedLinks: 0, suggestedOther: 0 }, evidence: { total: 3, unread: 0 },
});

/** A claim whose one element is fully proved (two documents, a witness) and backed by a verified authority. */
const provedClaim: MatterIn["claims"][number] = {
  id: U(1), kind: "claim", label: "FMLA interference", details: "",
  authorities: [{ citation: "29 U.S.C. § 2615(a)(1)", url: "", verified: true, stance: "supports" }],
  elements: [el(U(10), "Denied FMLA benefits", [fact(U(20), "Leave request was refused", [doc("e1"), doc("e2")], [{ id: U(30), label: "Sam Coworker" }])])],
};
const expert: PersonIn = { id: U(40), kind: "person", label: "Dr. Lee", role: "Damages expert", links: [] };

describe("R37-1: trial readiness names a 'largest current weakness' even when every measured category is 100%", () => {
  it("everything measured is at 100%: there is no weakness to name", () => {
    const m = base([provedClaim]);
    const r = readiness(m, analyze(m), [expert]);
    expect(r.categories.filter((c) => c.value !== null).every((c) => c.value === 100)).toBe(true); // precondition
    // The page renders "Your largest current weakness is witnesses (100%)" whenever weakest is set.
    expect(r.weakest).toBeNull();
  });
});

describe("R37-2: trial readiness ignores a claim that has no elements, so a Matter with an unprepared claim reads 100% ready", () => {
  it("a second claim with no elements at all doesn't lower readiness (case strength caps at 'Insufficient information' for this)", () => {
    const m = base([provedClaim, { id: U(2), kind: "claim", label: "Breach of contract", details: "", authorities: [], elements: [] }]);
    expect(analyze(m).overall.rating).toBe("Insufficient information"); // case strength already refuses to look ready
    const r = readiness(m, analyze(m), [expert]);
    expect(r.score).not.toBe(100);
  });
});

describe("R37-3: What if? never reports that a defense gap became more severe", () => {
  it("supporting the defense's last unsupported element turns its gap from Medium to High, but nothing is listed as opened or changed", () => {
    const m = base([
      provedClaim,
      { id: U(3), kind: "defense", label: "Legitimate business reason", details: "", authorities: [], elements: [
        el(U(50), "Honest belief in misconduct", [fact(U(60), "Manager's write-up of absences", [doc("e9")])]),
        el(U(51), "Same decision without the leave"),
      ] },
    ]);
    expect(analyze(m).gaps.find((g) => g.key === `defense:${U(3)}`)!.severity).toBe("Medium"); // precondition
    const r = whatIf(m, [{ kind: "add-document", id: U(51) }]);
    const reported = [...r.gapsOpened, ...(((r as unknown as { gapsChanged?: typeof r.gapsOpened }).gapsChanged) ?? [])];
    expect(reported.some((g) => g.key === `defense:${U(3)}` && g.severity === "High")).toBe(true);
  });
});

describe("R37-4: What if? doesn't say an assumption is about the other side's defense, and its caveat about defenses is wrong", () => {
  const m = base([
    provedClaim,
    { id: U(3), kind: "defense", label: "Same decision", details: "", authorities: [], elements: [el(U(51), "Would have fired her anyway")] },
  ]);

  it("the option and the assumption text for a defense element say it's a defense", () => {
    const opt = whatIfOptions(m).elements.find((e) => e.id === U(51))!;
    expect(JSON.stringify(opt)).toMatch(/defen[cs]e/i);
    expect(whatIf(m, [{ kind: "add-document", id: U(51) }]).assumptions[0]).toMatch(/defen[cs]e/i);
  });

  it("the caveat says the defense's evidence isn't changed unless a fact is removed, right next to a defense that just changed", () => {
    const r = whatIf(m, [{ kind: "add-document", id: U(51) }]);
    expect(r.claims.some((c) => c.kind === "defense")).toBe(true); // the defense did move
    expect(r.notChecked.join(" ")).not.toMatch(/defense's evidence aren't changed/i);
  });
});

describe("R37-5: Trial readiness counts any 'expert' as expert support, and one expert as covering every flagged area", () => {
  const disability: MatterIn["claims"][number] = {
    id: U(4), kind: "claim", label: "ADA failure to accommodate", details: "", authorities: [],
    elements: [el(U(70), "Requested a reasonable accommodation", [fact(U(80), "Pat asked for a modified schedule", [doc("e5")])])],
  };

  it("the employer's expert is counted as our expert support", () => {
    const m = base([provedClaim]);
    const r = readiness(m, analyze(m), [{ id: U(41), kind: "person", label: "Dr. Roe", role: "Defendant's rebuttal expert", links: [] }]);
    expect(r.categories.find((c) => c.key === "experts")!.value).not.toBe(100);
  });

  it("two damages experts make medical (flagged, no medical expert) read as 100% covered", () => {
    const m = base([provedClaim, disability]);
    const people: PersonIn[] = [expert, { id: U(42), kind: "person", label: "Ms. Kay", role: "Vocational expert (damages)", links: [] }];
    const c = readiness(m, analyze(m), people).categories.find((x) => x.key === "experts")!;
    expect(c.why).toMatch(/medical/); // precondition: both areas flagged
    expect(c.value).not.toBe(100);
  });
});

describe("R37-6: the What if? and Trial readiness pages don't say items behind an ethical wall aren't counted", () => {
  it.each(["what-if", "readiness"])("%s page carries the case strength page's ethical wall notice", (p) => {
    const page = readFileSync(join(__dirname, `../app/(app)/matters/[id]/${p}/page.tsx`), "utf8");
    expect(page).toMatch(/ethical wall/i);
  });
});
