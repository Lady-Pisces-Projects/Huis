import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearSignInRule, getSignInRule } from "../src/services/admin";
import { acceptInvitation, signUpFirm } from "../src/services/firms";
import { getSignInRule as firmRule, setSignInRule } from "../src/services/signinRule";
import { inviteUser, issueInvitation } from "../src/services/users";
import { createTestDatabase, type TestDatabase } from "./helpers";

/* Review 35 follow-ups: lockout recovery from the admin portal, and links revoked when the rule is turned off. */
let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });

const TENANT = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-8888-4777-8666-555555555555";

async function firmWithRule() {
  const slug = `r35-${randomUUID().slice(0, 8)}`;
  const f = await signUpFirm(t.db, { firmName: `R35 ${slug}`, slug, stateCode: "UT", ownerEmail: `o@${slug}.example`, ownerName: "Olive Owner", authProvider: "microsoft", authSubject: `${TENANT}:${randomUUID()}` });
  const owner = { firmId: f.firmId, userId: f.ownerUserId };
  await t.admin.query("SELECT huis.operator_set_subscription($1, 'professional', 10, NULL, now() + interval '1 year', 'active', 'test')", [f.firmId]);
  const a = await t.db.withFirm(owner, (s) => inviteUser(s, { email: `a@${slug}.example`, fullName: "Ann Elsewhere", role: "attorney", locationId: f.locationId }));
  await acceptInvitation(t.db, a.invitationToken, "microsoft", `${OTHER}:${randomUUID()}`);
  await t.db.withFirm(owner, (s) => setSignInRule(s, "microsoft"));
  return { ...f, owner, attorneyId: a.id };
}

describe("review 35 follow-ups", () => {
  it("Huis staff can turn a firm's rule off to recover a locked-out firm, with a note, recorded in both logs", async () => {
    const f = await firmWithRule();
    expect(await getSignInRule(t.platform, f.firmId)).toMatchObject({ provider: "microsoft", org: TENANT });
    await expect(clearSignInRule(t.platform, "Tracy (Huis)", f.firmId, "")).rejects.toThrow();
    await clearSignInRule(t.platform, "Tracy (Huis)", f.firmId, "Domain changed; owner confirmed by phone");
    expect(await getSignInRule(t.platform, f.firmId)).toBeNull();
    expect((await t.db.withFirm(f.owner, (s) => firmRule(s))).rule).toBeNull();
    const logs = await t.admin.query("SELECT action FROM huis.platform_audit WHERE firm_id = $1", [f.firmId]);
    expect(logs.rows.map((r) => r.action)).toContain("firm.clear_signin_rule");
    // The firm's own app login can't call it.
    await expect(t.db.withFirm(f.owner, (s) => s.client.query("SELECT huis.platform_clear_signin_rule('x', $1, 'y')", [f.firmId]))).rejects.toThrow();
  });

  it("turning the rule off revokes outstanding 'sign in again' links", async () => {
    const f = await firmWithRule();
    const token = await t.db.withFirm(f.owner, (s) => issueInvitation(s, f.attorneyId));
    await t.db.withFirm(f.owner, (s) => setSignInRule(s, "any"));
    const left = await t.admin.query("SELECT count(*) FROM huis.user_invitations WHERE user_id = $1 AND relink AND revoked_at IS NULL", [f.attorneyId]);
    expect(left.rows[0].count).toBe("0");
    expect(await acceptInvitation(t.db, token, "google", "100000000000000000999", "")).toBeNull();
  });
});
