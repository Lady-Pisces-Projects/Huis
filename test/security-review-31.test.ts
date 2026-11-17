import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignInRuleError, UnauthenticatedError } from "../src/errors";
import { acceptInvitation, signInAccounts, signUpFirm } from "../src/services/firms";
import { setSignInRule } from "../src/services/signinRule";
import { inviteUser, issueInvitation } from "../src/services/users";
import { createTestDatabase, type TestDatabase } from "./helpers";

/*
 * Independent security review 31: Sign-in security (db/migrations/0039_signin_rules.sql).
 * Each test fails today and passes once its problem is fixed.
 */

let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });

const TENANT = "11111111-2222-4333-8444-555555555555";
const OTHER_TENANT = "99999999-8888-4777-8666-555555555555";
const ms = (tenant: string) => `${tenant}:${randomUUID()}`;
const gid = () => String(10n ** 20n + BigInt(randomBytes(6).readUIntBE(0, 6)));

async function firmOwnedBy(provider: "microsoft" | "google", subject: string, org = "") {
  const slug = `r31-${randomBytes(4).toString("hex")}`;
  if (provider === "google") await signInAccounts(t.db, "google", subject, org);
  const res = await signUpFirm(t.db, { firmName: `R31 Firm ${slug}`, slug, stateCode: "UT", ownerEmail: `o@${slug}.example`, ownerName: "Olive Owner", authProvider: provider, authSubject: subject });
  return { ...res, slug, owner: { firmId: res.firmId, userId: res.ownerUserId } };
}

async function invite(f: Awaited<ReturnType<typeof firmOwnedBy>>, role: "attorney" | "firm_admin" | "managing_partner", name: string) {
  return t.db.withFirm(f.owner, (s) => inviteUser(s, { email: `${randomBytes(3).toString("hex")}@${f.slug}.example`, fullName: name, role, locationId: f.locationId }));
}

describe("R31-1: a firm administrator (or managing partner) can turn the rule on with an organization no owner uses, locking every owner out", () => {
  it("a firm admin on the firm's Google Workspace can't shut out the owner who signs in with Microsoft 365", async () => {
    const f = await firmOwnedBy("microsoft", ms(TENANT));
    const adm = await invite(f, "firm_admin", "Ada Admin");
    const admin = (await acceptInvitation(t.db, adm.invitationToken, "google", gid(), "smithlaw.com"))!;

    // Today this succeeds. The owner is then refused on every request, can't sign in again (their identity is
    // fixed to the Microsoft account and can't be re-linked), and can't turn the rule back off. disableUser and
    // changeUserRole both refuse to leave a firm without an active owner; this does it in one click.
    await t.db.withFirm(admin, (s) => setSignInRule(s, "google")).catch(() => undefined);
    await expect(t.db.withFirm(f.owner, async () => "owner still in")).resolves.toBe("owner still in");
  });

  it("the same for a sole owner on a personal Gmail account (common for small firms) and a managing partner on Microsoft 365", async () => {
    const f = await firmOwnedBy("google", gid(), "");
    const mp = await invite(f, "managing_partner", "Max Partner");
    const partner = (await acceptInvitation(t.db, mp.invitationToken, "microsoft", ms(TENANT)))!;
    await expect(t.db.withFirm(partner, (s) => setSignInRule(s, "microsoft"))).rejects.toThrow(/owner/i);
  });
});

describe("R31-2: staff the rule leaves out can never come back 'with the firm's account'", () => {
  it("an attorney who joined with another account can be given a new link and come back with the firm's Microsoft 365 account", async () => {
    const f = await firmOwnedBy("microsoft", ms(TENANT));
    const a = await invite(f, "attorney", "Bea Personal");
    const linked = (await acceptInvitation(t.db, a.invitationToken, "microsoft", ms(OTHER_TENANT)))!;
    await t.db.withFirm(f.owner, (s) => setSignInRule(s, "microsoft"));
    await expect(t.db.withFirm(linked, async () => "in")).rejects.toBeInstanceOf(SignInRuleError);

    // The page says "Signed out until they use your firm's account", and the docs "lets them back with the firm's
    // account". But the user row's identity can't change (users_guard), issueInvitation refuses anyone already
    // linked ("This person already has access or is disabled."), and accept_invitation requires an unlinked row.
    // Today the only way back is turning the rule off, or a brand-new user (losing Matter access, ethical-wall
    // membership, rates and history).
    const token = await t.db.withFirm(f.owner, (s) => issueInvitation(s, a.id)).catch(() => null);
    expect(token).not.toBeNull();
    const back = await acceptInvitation(t.db, token!, "microsoft", ms(TENANT));
    expect(back?.userId).toBe(a.id);
    await expect(t.db.withFirm(back!, async () => "in")).resolves.toBe("in");
  });
});

describe("R31-3: sessions the rule 'ended at once' come back when the rule is turned off, and signing out under the rule ends nothing", () => {
  it("a session cut off by the rule (and signed out) doesn't work again after the rule is turned off", async () => {
    const f = await firmOwnedBy("microsoft", ms(TENANT));
    const a = await invite(f, "attorney", "Gus Cookie");
    const linked = (await acceptInvitation(t.db, a.invitationToken, "microsoft", ms(OTHER_TENANT)))!;
    const sessionVersion = await t.db.withFirm(linked, async (s) => s.actor.sessionVersion);
    const cookie = { ...linked, sessionVersion };

    await t.db.withFirm(f.owner, (s) => setSignInRule(s, "microsoft"));
    await expect(t.db.withFirm(cookie, async () => "in")).rejects.toBeInstanceOf(SignInRuleError);

    // app/api/auth/signout/route.ts: withFirm throws SignInRuleError before end_my_sessions runs, and .catch()
    // hides it, so "sign out everywhere" ends nothing.
    await t.db.withFirm({ firmId: cookie.firmId, userId: cookie.userId }, async (s) => { await s.client.query("SELECT huis.end_my_sessions()"); })
      .catch(() => undefined);

    // Later the firm turns the rule off (e.g. to let someone back while sorting accounts out). Today the old
    // cookie (or a copy of it) is accepted again for the rest of its 8 hours.
    await t.db.withFirm(f.owner, (s) => setSignInRule(s, "any"));
    await expect(t.db.withFirm(cookie, async () => "in")).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});
