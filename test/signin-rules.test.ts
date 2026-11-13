import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignInRuleError, UserFacingError } from "../src/errors";
import { hostedDomain } from "../src/mail/google";
import { acceptInvitation, signInAccounts, signUpFirm } from "../src/services/firms";
import { getSignInRule, setSignInRule } from "../src/services/signinRule";
import { inviteUser } from "../src/services/users";
import { createTestDatabase, type TestDatabase } from "./helpers";

/*
 * Sign-in security: a firm can require its staff to sign in with the firm's own Microsoft 365 organization or
 * Google Workspace domain (db/migrations/0039_signin_rules.sql).
 */
let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });

const TENANT = "11111111-2222-4333-8444-555555555555";
const OTHER_TENANT = "99999999-8888-4777-8666-555555555555";
const PERSONAL_MS = "9188040d-6c67-4c5b-b112-36a304b66dad";
const ms = (tenant: string) => `${tenant}:${randomUUID()}`;
const gid = () => String(10n ** 20n + BigInt(randomBytes(6).readUIntBE(0, 6)));

async function firmOwnedBy(provider: "microsoft" | "google", subject: string, org = "") {
  const slug = `rule-${randomBytes(4).toString("hex")}`;
  if (provider === "google") await signInAccounts(t.db, "google", subject, org); // records the Workspace domain, as sign-in does
  const res = await signUpFirm(t.db, { firmName: `Rule Firm ${slug}`, slug, stateCode: "UT", ownerEmail: `o@${slug}.example`, ownerName: "Olive Owner", authProvider: provider, authSubject: subject });
  return { ...res, slug, owner: { firmId: res.firmId, userId: res.ownerUserId } };
}

async function invite(f: Awaited<ReturnType<typeof firmOwnedBy>>, role: "attorney" | "client" | "firm_admin", name: string) {
  return t.db.withFirm(f.owner, (s) => inviteUser(s, { email: `${randomBytes(3).toString("hex")}@${f.slug}.example`, fullName: name, role, locationId: f.locationId }));
}

describe("Google's hosted domain claim", () => {
  it("is a plain lower-case domain, or nothing", () => {
    expect(hostedDomain("SmithLaw.com")).toBe("smithlaw.com");
    expect(hostedDomain(undefined)).toBeNull();
    expect(hostedDomain("")).toBeNull();
    expect(hostedDomain("evil.com/../x")).toBeNull();
    expect(hostedDomain("localhost")).toBeNull();
    expect(hostedDomain(["smithlaw.com"])).toBeNull();
  });
});

describe("turning the rule on", () => {
  it("takes the organization from the owner's own Microsoft 365 sign-in and lists who would be left out", async () => {
    const f = await firmOwnedBy("microsoft", ms(TENANT));
    const a = await invite(f, "attorney", "Ann Outsider");
    await acceptInvitation(t.db, a.invitationToken, "google", gid(), ""); // a personal Gmail account
    const before = await t.db.withFirm(f.owner, (s) => getSignInRule(s));
    expect(before.rule).toBeNull();
    expect(before.me).toEqual({ provider: "microsoft", org: TENANT });
    expect(before.staff.find((p) => p.fullName === "Ann Outsider")?.provider).toBe("google");

    await t.db.withFirm(f.owner, (s) => setSignInRule(s, "microsoft"));
    const after = await t.db.withFirm(f.owner, (s) => getSignInRule(s));
    expect(after.rule).toEqual({ provider: "microsoft", org: TENANT });
    expect(after.staff.find((p) => p.fullName === "Ann Outsider")?.allowed).toBe(false);
    expect(after.staff.find((p) => p.fullName === "Olive Owner")?.allowed).toBe(true);

    const audit = await t.admin.query("SELECT metadata FROM huis.audit_events WHERE firm_id = $1 AND action = 'firm.signin_rule_changed'", [f.firmId]);
    expect(audit.rows[0].metadata).toMatchObject({ from: { provider: "any" }, to: { provider: "microsoft", org: TENANT } });
  });

  it("can't be turned on from a personal account (nobody can lock their firm out), or for the other provider", async () => {
    const personalMs = await firmOwnedBy("microsoft", ms(PERSONAL_MS));
    await expect(t.db.withFirm(personalMs.owner, (s) => setSignInRule(s, "microsoft"))).rejects.toThrow(/personal account/);
    const gmail = await firmOwnedBy("google", gid(), "");
    await expect(t.db.withFirm(gmail.owner, (s) => setSignInRule(s, "google"))).rejects.toThrow(/personal account/);
    await expect(t.db.withFirm(gmail.owner, (s) => setSignInRule(s, "microsoft"))).rejects.toBeInstanceOf(UserFacingError);
    const legacy = await firmOwnedBy("microsoft", `subject-${randomBytes(3).toString("hex")}`); // no tenant in the identity
    await expect(t.db.withFirm(legacy.owner, (s) => setSignInRule(s, "microsoft"))).rejects.toThrow(/personal account/);
  });

  it("only the owner, managing partners and firm administrators can see or change it", async () => {
    const f = await firmOwnedBy("microsoft", ms(TENANT));
    const a = await invite(f, "attorney", "Al Attorney");
    const linked = (await acceptInvitation(t.db, a.invitationToken, "microsoft", ms(TENANT)))!;
    await expect(t.db.withFirm(linked, (s) => setSignInRule(s, "microsoft"))).rejects.toThrow();
    await expect(t.db.withFirm(linked, (s) => getSignInRule(s))).rejects.toThrow();
    // Nor by writing the tables directly.
    await expect(t.db.withFirm(f.owner, (s) => s.client.query("INSERT INTO huis.firm_signin_rules (firm_id, provider, org, set_by) VALUES ($1, 'google', 'x.com', $2)", [f.firmId, f.ownerUserId]))).rejects.toThrow();
    await expect(t.db.withFirm(f.owner, (s) => s.client.query("SELECT * FROM huis.identity_orgs"))).rejects.toThrow();
  });
});

describe("with the rule on", () => {
  it("ends other staff sign-ins at once (checked on every request), and lets them back with the firm's account", async () => {
    const f = await firmOwnedBy("microsoft", ms(TENANT));
    const a = await invite(f, "attorney", "Bea Personal");
    const linked = (await acceptInvitation(t.db, a.invitationToken, "microsoft", ms(OTHER_TENANT)))!;
    expect(await t.db.withFirm(linked, async (s) => s.actor.fullName)).toBe("Bea Personal");
    await t.db.withFirm(f.owner, (s) => setSignInRule(s, "microsoft"));
    await expect(t.db.withFirm(linked, async () => "in")).rejects.toBeInstanceOf(SignInRuleError);
    // The owner, on the firm's own tenant, carries on.
    expect(await t.db.withFirm(f.owner, async () => "in")).toBe("in");
  });

  it("leaves the firm out of the sign-in choices for an account from elsewhere", async () => {
    const f = await firmOwnedBy("microsoft", ms(TENANT));
    const subject = ms(OTHER_TENANT);
    const a = await invite(f, "attorney", "Cy Elsewhere");
    await acceptInvitation(t.db, a.invitationToken, "microsoft", subject);
    await t.db.withFirm(f.owner, (s) => setSignInRule(s, "microsoft"));
    const accounts = await signInAccounts(t.db, "microsoft", subject, OTHER_TENANT);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.allowed).toBe(false);
  });

  it("refuses a staff invitation accepted with an account from outside the organization, and doesn't use it up", async () => {
    const f = await firmOwnedBy("microsoft", ms(TENANT));
    await t.db.withFirm(f.owner, (s) => setSignInRule(s, "microsoft"));
    const a = await invite(f, "attorney", "Dee New");
    await expect(acceptInvitation(t.db, a.invitationToken, "google", gid(), "")).rejects.toMatchObject({ status: 403 });
    await expect(acceptInvitation(t.db, a.invitationToken, "microsoft", ms(OTHER_TENANT))).rejects.toMatchObject({ status: 403 });
    // Microsoft's tenant is read from the identity, so claiming the firm's tenant doesn't help.
    await expect(acceptInvitation(t.db, a.invitationToken, "microsoft", ms(OTHER_TENANT), TENANT)).rejects.toMatchObject({ status: 403 });
    const ok = await acceptInvitation(t.db, a.invitationToken, "microsoft", ms(TENANT));
    expect(ok?.userId).toBe(a.id);
  });

  it("never applies to clients and other outside people", async () => {
    const f = await firmOwnedBy("microsoft", ms(TENANT));
    await t.db.withFirm(f.owner, (s) => setSignInRule(s, "microsoft"));
    const c = await invite(f, "client", "Cal Client");
    const linked = (await acceptInvitation(t.db, c.invitationToken, "google", gid(), ""))!;
    expect(await t.db.withFirm(linked, async () => "in")).toBe("in");
  });

  it("Google Workspace: only accounts whose verified token names the firm's domain", async () => {
    const owner = gid();
    const f = await firmOwnedBy("google", owner, "smithlaw.com");
    await t.db.withFirm(f.owner, (s) => setSignInRule(s, "google"));
    expect((await t.db.withFirm(f.owner, (s) => getSignInRule(s))).rule).toEqual({ provider: "google", org: "smithlaw.com" });

    const a = await invite(f, "attorney", "Eve Workspace");
    const sub = gid();
    const linked = (await acceptInvitation(t.db, a.invitationToken, "google", sub, "SmithLaw.com"))!;
    expect(await t.db.withFirm(linked, async () => "in")).toBe("in");

    const b = await invite(f, "attorney", "Flo Lookalike");
    await expect(acceptInvitation(t.db, b.invitationToken, "google", gid(), "smithlaw.com.evil.example")).rejects.toMatchObject({ status: 403 });
    await expect(acceptInvitation(t.db, b.invitationToken, "google", gid(), "")).rejects.toMatchObject({ status: 403 });

    // If the same Google account later signs in without the domain (it left the Workspace), it's out at once.
    await signInAccounts(t.db, "google", sub, "");
    await expect(t.db.withFirm(linked, async () => "in")).rejects.toBeInstanceOf(SignInRuleError);
  });

  it("can be turned off again, which lets everyone back", async () => {
    const f = await firmOwnedBy("microsoft", ms(TENANT));
    const a = await invite(f, "attorney", "Gus Back");
    const linked = (await acceptInvitation(t.db, a.invitationToken, "microsoft", ms(OTHER_TENANT)))!;
    await t.db.withFirm(f.owner, (s) => setSignInRule(s, "microsoft"));
    await expect(t.db.withFirm(linked, async () => "in")).rejects.toBeInstanceOf(SignInRuleError);
    await t.db.withFirm(f.owner, (s) => setSignInRule(s, "any"));
    expect(await t.db.withFirm(linked, async () => "in")).toBe("in");
  });

  it("the app can't accept an invitation the old way, around the rule", async () => {
    const f = await firmOwnedBy("microsoft", ms(TENANT));
    await t.db.withFirm(f.owner, (s) => setSignInRule(s, "microsoft"));
    const a = await invite(f, "attorney", "Hal Around");
    await expect(t.db.withoutFirm((c) => c.query("SELECT * FROM huis.accept_invitation($1, 'microsoft', $2)", [a.invitationToken, ms(OTHER_TENANT)]))).rejects.toThrow();
  });
});
