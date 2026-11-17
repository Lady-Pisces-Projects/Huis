import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "../src/services/clients";
import { acceptInvitation, signUpFirm } from "../src/services/firms";
import { createMatter, listMatterFolders } from "../src/services/matters";
import { setSignInRule } from "../src/services/signinRule";
import { changeUserRole, disableUser, inviteUser, issueInvitation } from "../src/services/users";
import { createTestDatabase, type TestDatabase } from "./helpers";

/*
 * Independent security review 35: how the features merged in migrations 0036-0045 interact on main (Google
 * sign-in and invitations, the admin portal, firm sign-in rules, unpaid-trial deletion, white label, case strength).
 * Each test fails today and passes once its problem is fixed.
 */

let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });

const TENANT = "11111111-2222-4333-8444-555555555555";
const OTHER_TENANT = "99999999-8888-4777-8666-555555555555";
const ms = (tenant: string) => `${tenant}:${randomUUID()}`;
const gid = () => String(10n ** 20n + BigInt(randomBytes(6).readUIntBE(0, 6)));

async function firmOwnedBy(subject: string) {
  const slug = `r35-${randomBytes(4).toString("hex")}`;
  const res = await signUpFirm(t.db, { firmName: `R35 Firm ${slug}`, slug, stateCode: "UT", ownerEmail: `o@${slug}.example`, ownerName: "Olive Owner", authProvider: "microsoft", authSubject: subject });
  return { ...res, slug, owner: { firmId: res.firmId, userId: res.ownerUserId } };
}
type Firm = Awaited<ReturnType<typeof firmOwnedBy>>;

async function join(f: Firm, role: "attorney" | "firm_admin" | "firm_owner", name: string, provider: "microsoft" | "google", subject: string, org = "") {
  const inv = await t.db.withFirm(f.owner, (s) => inviteUser(s, { email: `${randomBytes(3).toString("hex")}@${f.slug}.example`, fullName: name, role, locationId: f.locationId }));
  const linked = (await acceptInvitation(t.db, inv.invitationToken, provider, subject, org))!;
  return { ...linked, id: inv.id };
}

/*
 * Sign-in rule x user management. R31-1 made turning the rule on refuse to leave no owner able to sign in, but
 * disableUser and changeUserRole only check that *some* active owner remains, not one the rule lets in. Re-link
 * links (R31-2) can only be issued by an owner who can sign in, so the excluded owner can't be brought back either.
 */
describe("R35-1: with the sign-in rule on, a firm administrator can disable or demote the only owner the rule lets in", () => {
  async function setup() {
    const f = await firmOwnedBy(ms(TENANT));
    // A second owner who joined with a personal Microsoft account before the rule.
    const o2 = await join(f, "firm_owner", "Pat Personal", "microsoft", ms(OTHER_TENANT));
    const admin = await join(f, "firm_admin", "Ada Admin", "microsoft", ms(TENANT));
    await t.db.withFirm(f.owner, (s) => setSignInRule(s, "microsoft")); // allowed: Olive signs in with the firm's tenant
    return { f, o2, admin };
  }

  it("disabling the only rule-allowed owner is refused (the other owner can't sign in)", async () => {
    const { f, admin } = await setup();
    // Today this succeeds: Pat is still an active owner, so assertAnotherActiveOwner is satisfied, but Pat is
    // refused on every request by the rule. No owner can sign in, issue a re-link link, or manage owners.
    await expect(t.db.withFirm(admin, (s) => disableUser(s, f.ownerUserId))).rejects.toThrow(/owner/i);
  });

  it("demoting the only rule-allowed owner is refused too", async () => {
    const { f, admin } = await setup();
    await expect(t.db.withFirm(admin, (s) => changeUserRole(s, f.ownerUserId, "attorney"))).rejects.toThrow(/owner/i);
  });
});

/*
 * Re-link links x turning the rule off. A re-link link (R31-2) is "only for staff the firm's sign-in rule leaves
 * out" and "accepted only with an account that meets the rule". Turning the rule off leaves the 7-day links live,
 * and with no rule every account "meets" it: whoever holds the link moves an existing account (its Matter access,
 * ethical-wall membership and history) to any sign-in at all, even after its owner is signing in normally again.
 */
describe("R35-2: an outstanding re-link link still moves the account after the rule is turned off", () => {
  it("a re-link link issued under the rule can't be used once the rule is off (the person signs in as before)", async () => {
    const f = await firmOwnedBy(ms(TENANT));
    const a = await join(f, "attorney", "Bea Personal", "microsoft", ms(OTHER_TENANT));
    await t.db.withFirm(f.owner, (s) => setSignInRule(s, "microsoft"));
    const token = await t.db.withFirm(f.owner, (s) => issueInvitation(s, a.id));
    await t.db.withFirm(f.owner, (s) => setSignInRule(s, "any"));
    // Bea can sign in again with her own account; the link is no longer needed.
    await expect(t.db.withFirm({ firmId: a.firmId, userId: a.userId }, async () => "in")).resolves.toBe("in");

    // Today: anyone holding the link takes over Bea's account with a personal Gmail account.
    const taken = await acceptInvitation(t.db, token, "google", gid(), "");
    expect(taken).toBeNull();
    const row = (await t.admin.query("SELECT auth_provider FROM huis.users WHERE id = $1", [a.id])).rows[0];
    expect(row.auth_provider).toBe("microsoft");
  });
});

/*
 * Sign-in rule x background work. Migration 0041 stopped mailbox sync for people the rule leaves out (review 31's
 * open item), but the worker still claims cloud-drive imports they requested and runs them as them
 * (huis.integration_import_allowed sets app.user_id to the requester), from their own connected account.
 */
describe("R35-3: imports requested by someone the sign-in rule now leaves out still run as them", () => {
  it("the worker doesn't claim an import whose requester the rule refuses", async () => {
    const f = await firmOwnedBy(ms(TENANT));
    const a = await join(f, "attorney", "Ivy Import", "microsoft", ms(OTHER_TENANT));
    const { matter } = await t.db.withFirm(f.owner, async (s) => {
      const client = await createClient(s, { kind: "person", displayName: "Pat Smith" });
      return { matter: await createMatter(s, { title: "Smith v. Acme", clientId: client.id, leadAttorneyId: a.id, jurisdictionState: "UT" }) };
    });
    const folder = (await t.db.withFirm({ firmId: a.firmId, userId: a.userId }, (s) => listMatterFolders(s, matter.id))).find((g) => g.name === "Correspondence")!;
    // Ivy's own Dropbox connection and an import she queued (recorded directly; the queueing path is tested elsewhere).
    const conn = (await t.admin.query(
      `INSERT INTO huis.integration_connections (firm_id, owner_user_id, provider, account_subject, account_label, verified_at)
       VALUES ($1, $2, 'dropbox', $3, 'ivy@personal.example', now()) RETURNING id`, [f.firmId, a.id, `dbid:${randomUUID()}`])).rows[0].id;
    await t.admin.query(
      `INSERT INTO huis.integration_imports (firm_id, connection_id, matter_id, folder_id, external_id, external_name, shared_outside_firm, requested_by)
       VALUES ($1, $2, $3, $4, 'id:abc', 'memo.txt', false, $5)`, [f.firmId, conn, matter.id, folder.id, a.id]);

    await t.db.withFirm(f.owner, (s) => setSignInRule(s, "microsoft")); // Ivy is now refused on every request
    const claimed = (await t.worker.query("SELECT * FROM huis.worker_claim_integration_import()")).rows;
    expect(claimed).toHaveLength(0);
  });
});
