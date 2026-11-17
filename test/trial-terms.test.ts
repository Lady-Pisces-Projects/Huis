import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deletionNotice } from "../src/billing/trialDeletion";
import { TRIAL_TERMS, TRIAL_TERMS_EMAIL, TRIAL_TERMS_VERSION } from "../src/billing/trialTerms";
import { signUpFirm } from "../src/services/firms";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

/* The free trial's non-payment and deletion terms: shown, accepted at sign-up, recorded, and repeated in warnings. */

let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });

describe("free trial terms", () => {
  it("state the deletion rules the database enforces", () => {
    const all = TRIAL_TERMS.join(" ");
    expect(all).toMatch(/at least 30 days after the trial ends/);
    expect(all).toMatch(/14 days, 7 days and 1 day before/);
    expect(all).toMatch(/solely responsible for exporting/);
    expect(all).toMatch(/never deleted for non-payment/);
  });

  it("are recorded with the firm and in its audit log when the owner accepts them, and can't be changed later", async () => {
    const slug = `terms-${randomBytes(3).toString("hex")}`;
    const r = await signUpFirm(t.db, { firmName: "Terms Firm", slug, stateCode: "UT", ownerEmail: `o@${slug}.example`, ownerName: "Owner One",
      authProvider: "google", authSubject: `s-${slug}`, trialTermsVersion: TRIAL_TERMS_VERSION });
    const ctx = { firmId: r.firmId, userId: r.ownerUserId };
    const row = await t.db.withFirm(ctx, async (s) => (await s.client.query("SELECT trial_terms_version, trial_terms_accepted_at FROM huis.firms")).rows[0]);
    expect(row.trial_terms_version).toBe(TRIAL_TERMS_VERSION);
    expect(row.trial_terms_accepted_at).toBeInstanceOf(Date);
    const audit = await t.admin.query("SELECT metadata FROM huis.audit_events WHERE firm_id = $1 AND action = 'firm.trial_terms_accepted'", [r.firmId]);
    expect(audit.rows).toEqual([{ metadata: { version: TRIAL_TERMS_VERSION } }]);
    await expect(t.db.withFirm(ctx, (s) => s.client.query("UPDATE huis.firms SET trial_terms_version = '2020-01-01'"))).rejects.toThrow();
    await expect(t.db.withFirm(ctx, (s) => s.client.query("SELECT huis.record_trial_terms($1, $2, '2030-01-01')", [r.firmId, r.ownerUserId])))
      .rejects.toThrow(/only be recorded when the firm is created/);
  });

  it("can't be recorded for another firm", async () => {
    const a = await newFirm(t.db);
    const b = await newFirm(t.db);
    await expect(t.db.withFirm(a.owner, (s) => s.client.query("SELECT huis.record_trial_terms($1, $2, $3)", [b.firmId, a.ownerUserId, TRIAL_TERMS_VERSION])))
      .rejects.toThrow();
  });

  it("are repeated in every deletion warning, with a link to the full terms", () => {
    const m = deletionNotice({ email: "o@x.example", firm_name: "Smith Law", delete_after: new Date("2026-12-31T12:00:00Z"), time_zone: "America/Denver", days_before: 7 }, "https://app.huislaw.ai/");
    expect(m.text).toContain(TRIAL_TERMS_EMAIL);
    expect(m.text).toContain("https://app.huislaw.ai/trial-terms");
  });
});

/* Review 39 legal-accuracy fixes that are easy to regress. */
describe("review 39 legal accuracy", () => {
  it("L39-4: disability claim names map to ADA employment (445) in any capitalisation, and Ada County still doesn't", async () => {
    const { nosFor } = await import("../src/benchmarks/federal");
    for (const n of ["Americans with Disabilities Act discrimination", "Disability discrimination", "Failure to Accommodate", "failure to accommodate", "ADA retaliation"]) {
      expect(nosFor(n)?.nos, n).toBe(445);
    }
    expect(nosFor("Breach of contract with Ada County")?.nos).toBe(190);
  });
});
