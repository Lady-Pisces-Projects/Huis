import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrainWorker } from "../src/brain/worker";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import type { MalwareScanner } from "../src/storage/scanner";
import { analyze, rateClaim, scoreElement, type ElementIn, type FactIn, type MatterIn } from "../src/intelligence/strength";
import { caseStrength, reviewGap } from "../src/services/caseStrength";
import { createClient } from "../src/services/clients";
import { addClaimFromTemplate, addFactFromPassage, addNode, claimView, findEvidenceFor, linkNodes } from "../src/services/dna";
import { assembleOriginal, getUploadSession, markChunkReceived, newEvidenceId, recordEvidence, startUpload, storeChunk } from "../src/services/evidence";
import { addMatterMember, createMatter } from "../src/services/matters";
import { inviteUser } from "../src/services/users";
import { acceptInvitation } from "../src/services/firms";
import { MasterKeyProvider } from "../src/storage/encryption";
import { EvidenceVault, LocalObjectStore } from "../src/storage/store";
import { EvidenceProcessor } from "../src/worker/processor";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

/* Phase 11 part 1: Case Outcome Intelligence (src/intelligence/strength.ts, src/services/caseStrength.ts). */

const doc = (id: string, kind: "document" | "email" | "note" = "document") => ({
  kind, id, title: `${id}.txt`, quote: "quote", evidenceId: kind === "note" ? null : id, noteId: kind === "note" ? id : null,
});
const fact = (id: string, sources: FactIn["sources"], witnesses: FactIn["witnesses"] = []): FactIn => ({ id, label: `Fact ${id}`, sources, witnesses });
const el = (label: string, supporting: FactIn[] = [], contradicting: FactIn[] = []): ElementIn => ({ id: `el-${label}`, label, details: "", supporting, contradicting, pendingSuggestions: 0 });

describe("the rules (fixed and explainable)", () => {
  it("scores an element by what supports it, and every point has a reason", () => {
    expect(scoreElement(el("Protected activity")).score).toBe(0);
    expect(scoreElement(el("A", [fact("f1", [])])).score).toBe(40); // a confirmed fact, no source
    expect(scoreElement(el("A", [fact("f1", [doc("n1", "note")])])).score).toBe(40); // attorney notes only
    expect(scoreElement(el("A", [fact("f1", [doc("d1")])])).score).toBe(65); // one document
    expect(scoreElement(el("A", [fact("f1", [doc("d1")]), fact("f2", [doc("e1", "email")])])).score).toBe(80); // two sources
    const best = scoreElement(el("A", [fact("f1", [doc("d1"), doc("d2"), doc("e1", "email")], [{ id: "p1", label: "Jordan Lee" }])]));
    expect(best.score).toBe(100);
    expect(best.lines.reduce((a, l) => a + l.points, 0)).toBe(100);
    expect(best.lines.every((l) => l.why.length > 0)).toBe(true);
    // Contradictions take points away, but a supported element never falls below 10.
    const disputed = scoreElement(el("A", [fact("f1", [doc("d1")])], [fact("c1", [doc("d9")]), fact("c2", []), fact("c3", []), fact("c4", [])]));
    expect(disputed.score).toBe(10);
    expect(disputed.disputed).toBe(true);
    // The same document cited twice is one source, not two.
    expect(scoreElement(el("A", [fact("f1", [doc("d1")]), fact("f2", [doc("d1")])])).independentSources).toBe(1);
  });

  it("rates a claim by its weakest points, and says why", () => {
    const claim = (elements: ElementIn[]) => rateClaim({ id: "c", kind: "claim", label: "FMLA retaliation", details: "", elements, authorities: [] });
    expect(claim([]).rating).toBe("Insufficient information");
    const weak = claim([el("Protected activity", [fact("f", [doc("d")])]), el("Causal connection")]);
    expect(weak.rating).toBe("Weak");
    expect(weak.why).toContain("Causal connection");
    expect(claim([el("A", [fact("f", [doc("n", "note")])]), el("B", [fact("g", [doc("d")])])]).rating).toBe("Moderate");
    expect(claim([el("A", [fact("f", [doc("d")])]), el("B", [fact("g", [doc("e", "email")])])]).rating).toBe("Strong");
    const w = [{ id: "p", label: "Jordan" }];
    expect(claim([el("A", [fact("f", [doc("d1"), doc("d2")], w)]), el("B", [fact("g", [doc("e1", "email"), doc("d3")], w)])]).rating).toBe("Very strong");
  });

  it("finds the holes, ranks them, and suggests next steps; never calls a score a probability", () => {
    const m: MatterIn = {
      matterId: "m1",
      claims: [
        { id: "c1", kind: "claim", label: "FMLA retaliation", details: "", authorities: [], elements: [
          el("Protected activity", [fact("f1", [doc("e1", "email")], [{ id: "p", label: "Jordan" }])]),
          el("Adverse action", [fact("f2", [doc("n1", "note")])]),
          el("Causal connection"),
        ] },
        { id: "c2", kind: "claim", label: "Empty claim", details: "", authorities: [], elements: [] },
        { id: "d1", kind: "defense", label: "Legitimate business reason", details: "", authorities: [], elements: [el("Performance problems", [fact("f9", [doc("d9")])])] },
      ],
      damages: [{ id: "dm1", label: "Lost wages", amount: null, sources: 0 }],
      contradictions: { confirmed: 1, potential: 2 },
      pending: { suggestedFacts: 3, suggestedLinks: 0, suggestedOther: 1 },
      evidence: { total: 10, unread: 1 },
    };
    const r = analyze(m);
    const keys = r.gaps.map((g) => g.key);
    expect(r.gaps[0]).toMatchObject({ key: "unsupported:el-Causal connection", severity: "Critical", impact: "Causation" });
    expect(r.gaps[0]!.actions.some((a) => /decision-maker/.test(a))).toBe(true);
    expect(keys).toEqual(expect.arrayContaining([
      "notes-only:el-Adverse action", "no-elements:c2", "defense:d1", "damage-undocumented:dm1", "contradictions", "pending-review", "no-witness:el-Adverse action",
    ]));
    // Most severe first.
    const order = { Critical: 0, High: 1, Medium: 2, Low: 3 } as const;
    expect(r.gaps.map((g) => order[g.severity])).toEqual([...r.gaps.map((g) => order[g.severity])].sort((a, b) => a - b));
    // Never better than the weakest claim: the claim with no elements makes it Insufficient information.
    expect(r.overall.rating).toBe("Insufficient information");
    expect(r.overall.why).toContain("capped at the weakest claim");
    expect(r.categories.find((c) => c.key === "discovery")!.value).toBeNull(); // not measured: said so, not invented
    expect(r.confidence.level).toBe("Medium");
    expect(JSON.stringify(r)).not.toMatch(/probability|chance of winning|likely to win/i);
  });

  it("says there isn't enough information rather than inventing a score", () => {
    const r = analyze({ matterId: "m", claims: [], damages: [], contradictions: { confirmed: 0, potential: 0 }, pending: { suggestedFacts: 0, suggestedLinks: 0, suggestedOther: 0 }, evidence: { total: 0, unread: 0 } });
    expect(r.overall).toMatchObject({ score: null, rating: "Insufficient information" });
    expect(r.confidence.level).toBe("Low");
    expect(r.categories.every((c) => c.value === null || c.key === "elements" || c.key === "documentation" || c.key === "witnesses")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
let t: TestDatabase;
let db: HuisDb;
let vault: EvidenceVault;
let vaultDir: string;
let processor: EvidenceProcessor;
let brain: BrainWorker;
const scanner: MalwareScanner = { name: "test", async scan(stream) { for await (const _ of stream) { /* drain */ } return { status: "clean", detail: "No threats found" }; } };

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
  vaultDir = await mkdtemp(path.join(os.tmpdir(), "huis-strength-vault-"));
  vault = new EvidenceVault(new LocalObjectStore(vaultDir), new MasterKeyProvider(randomBytes(32).toString("base64")));
  processor = new EvidenceProcessor(t.worker, vault, scanner);
  brain = new BrainWorker(t.worker);
});
afterAll(async () => {
  await t?.drop();
  if (vaultDir) await rm(vaultDir, { recursive: true, force: true });
});

async function upload(ctx: RequestContext, matterId: string, filename: string, text: string) {
  const content = Buffer.from(text);
  const session = await db.withFirm(ctx, (s) => startUpload(s, { matterId, filename, totalSize: content.length }));
  for (let i = 0; i < session.chunkCount; i++) {
    await storeChunk(vault, session, i, content.subarray(i * session.chunkSize, (i + 1) * session.chunkSize));
    await db.withFirm(ctx, (s) => markChunkReceived(s, session.id, i));
  }
  const fresh = await db.withFirm(ctx, (s) => getUploadSession(s, session.id));
  const id = newEvidenceId();
  const stored = await assembleOriginal(vault, fresh, id);
  return db.withFirm(ctx, (s) => recordEvidence(s, fresh, id, stored));
}

async function setup() {
  const f = await newFirm(db);
  await t.admin.query("SELECT huis.operator_set_subscription($1, 'professional', 10, NULL, now() + interval '1 year', 'active', 'test')", [f.firmId]);
  const x = await db.withFirm(f.owner, async (s) => {
    const client = await createClient(s, { kind: "person", displayName: "Pat Smith", email: "pat.smith@example.com" });
    const reader = await inviteUser(s, { email: `r@${f.slug}.example`, fullName: "Rae Reader", role: "read_only", locationId: f.locationId });
    const portal = await inviteUser(s, { email: `c@${f.slug}.example`, fullName: "Casey Client", role: "client", locationId: f.locationId });
    const matter = await createMatter(s, { title: "Smith v. Acme", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
    const walled = await createMatter(s, { title: "Walled", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT", restricted: true });
    return { reader, portal, matter, walled };
  });
  const r = (await acceptInvitation(db, x.reader.invitationToken, "google", String(10n ** 20n + BigInt(randomBytes(5).readUIntBE(0, 5)))))!;
  const p = (await acceptInvitation(db, x.portal.invitationToken, "google", String(10n ** 20n + BigInt(randomBytes(5).readUIntBE(0, 5)))))!;
  await db.withFirm(f.owner, (s) => addMatterMember(s, { matterId: x.matter.id, userId: x.portal.id, access: "view", acknowledgePrivilegeWaiverRisk: true }));
  return { ...f, ...x, readerCtx: r, portalCtx: p };
}

const LETTER = "Termination letter. Dear Ms. Smith, your employment with Acme Corporation is terminated effective April 18, 2026. Signed, Cindy Manager, Human Resources.";
const LEAVE = "Leave request. On April 2, 2026 Pat Smith requested FMLA leave for surgery. Approved by HR the same day.";

describe("Case Outcome Intelligence on a Matter", () => {
  it("measures the claim against the confirmed evidence, links every point to its source, and lists the holes", async () => {
    const x = await setup();
    await upload(x.owner, x.matter.id, "termination.txt", LETTER);
    await upload(x.owner, x.matter.id, "leave.txt", LEAVE);
    await processor.drain();
    while (await brain.indexOnce()) { /* index */ }
    const claimId = await db.withFirm(x.owner, (s) => addClaimFromTemplate(s, x.matter.id, "fmla_retaliation"));
    const view = await db.withFirm(x.owner, (s) => claimView(s, claimId));
    const [protectedActivity, adverse] = view.elements.map((e) => e.element);
    await db.withFirm(x.owner, async (s) => {
      const p1 = (await findEvidenceFor(s, protectedActivity!.id)).find((p) => p.sourceTitle === "leave.txt")!;
      const f1 = await addFactFromPassage(s, protectedActivity!.id, { chunkId: p1.chunkId, relation: "supports", label: "Pat requested FMLA leave on April 2" });
      const hr = await addNode(s, x.matter.id, { kind: "person", label: "Cindy Manager" });
      await linkNodes(s, hr, f1, "witness_to");
      const p2 = (await findEvidenceFor(s, adverse!.id)).find((p) => p.sourceTitle === "termination.txt")!;
      await addFactFromPassage(s, adverse!.id, { chunkId: p2.chunkId, relation: "supports", label: "Pat was terminated effective April 18" });
    });

    const r = await db.withFirm(x.owner, (s) => caseStrength(s, x.matter.id));
    const c = r.claims[0]!;
    expect(c.label).toBe("FMLA retaliation");
    expect(c.rating).toBe("Weak"); // causation has nothing yet
    expect(c.elements.map((e) => e.score)).toEqual([75, 65, 0]);
    expect(c.elements[0]!.supporting[0]!.sources[0]).toMatchObject({ kind: "document", title: "leave.txt" });
    expect(c.elements[0]!.witnesses.map((w) => w.label)).toEqual(["Cindy Manager"]);
    expect(r.open[0]).toMatchObject({ severity: "Critical", impact: "Causation" });
    expect(r.open.map((g) => g.key)).toContain("no-damages");
    expect(r.categories.find((k) => k.key === "elements")!.value).toBe(67);

    // An attorney sets a gap aside with a reason: off the priority list, the score unchanged, audited.
    const gap = r.open.find((g) => g.key === "no-damages")!;
    await db.withFirm(x.owner, (s) => reviewGap(s, x.matter.id, { gapKey: gap.key, decision: "set_aside", note: "Damages to be pleaded later." }));
    const after = await db.withFirm(x.owner, (s) => caseStrength(s, x.matter.id));
    expect(after.open.map((g) => g.key)).not.toContain("no-damages");
    expect(after.setAside[0]!.review.note).toBe("Damages to be pleaded later.");
    expect(after.overall.score).toBe(r.overall.score);
    await expect(db.withFirm(x.owner, (s) => reviewGap(s, x.matter.id, { gapKey: r.open[0]!.key, decision: "set_aside", note: "" }))).rejects.toThrow(/why/);
    await db.withFirm(x.owner, (s) => reviewGap(s, x.matter.id, { gapKey: gap.key, decision: "reopen" }));
    expect((await db.withFirm(x.owner, (s) => caseStrength(s, x.matter.id))).open.map((g) => g.key)).toContain("no-damages");
    const audit = await t.admin.query("SELECT count(*) FROM huis.audit_events WHERE matter_id = $1 AND action = 'case_strength.gap_reviewed'", [x.matter.id]);
    expect(Number(audit.rows[0].count)).toBe(2);
  });

  it("is for firm staff only: clients never see it, read-only staff can read but not set gaps aside, nobody outside an ethical wall", async () => {
    const x = await setup();
    await expect(db.withFirm(x.portalCtx, (s) => caseStrength(s, x.matter.id))).rejects.toThrow();
    expect((await db.withFirm(x.readerCtx, (s) => caseStrength(s, x.matter.id))).overall.rating).toBe("Insufficient information");
    await expect(db.withFirm(x.readerCtx, (s) => reviewGap(s, x.matter.id, { gapKey: "no-damages", decision: "set_aside", note: "x" }))).rejects.toThrow();
    await expect(db.withFirm(x.readerCtx, (s) => caseStrength(s, x.walled.id))).rejects.toThrow();
    // Gap reviews can't be read or written around the rules, nor for another firm's Matter.
    await expect(db.withFirm(x.readerCtx, (s) => s.client.query(
      "INSERT INTO huis.case_gap_reviews (firm_id, matter_id, gap_key, decision, note, decided_by) VALUES ($1, $2, 'no-damages', 'set_aside', 'x', $3)",
      [x.firmId, x.matter.id, x.reader.id]))).rejects.toThrow();
    const other = await setup();
    await expect(db.withFirm(x.owner, (s) => reviewGap(s, other.matter.id, { gapKey: "no-damages", decision: "context", note: "x" }))).rejects.toThrow();
  });
});
