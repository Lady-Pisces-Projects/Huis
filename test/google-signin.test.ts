import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GOOGLE_SIGNIN_SCOPES, googleSignInAuthorizeUrl, verifyGoogleSignIn } from "../src/auth/google";
import { pkceChallenge } from "../src/auth/microsoft";
import { signInReturnMatches } from "../src/auth/signin-check";
import { acceptInvitation, resolveIdentity, signUpFirm } from "../src/services/firms";
import { inviteUser } from "../src/services/users";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

const CLIENT_ID = "1234567890-abc.apps.googleusercontent.com";
const SUB = "109876543210987654321";

let privateKey: CryptoKey;
let keys: ReturnType<typeof createLocalJWKSet>;
let t: TestDatabase;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "g-key", alg: "RS256" }] });
  t = await createTestDatabase();
});
afterAll(async () => { await t?.drop(); });

async function token(over: Record<string, unknown> = {}, opts: { iss?: string; aud?: string; exp?: string; key?: CryptoKey } = {}) {
  return new SignJWT({ sub: SUB, nonce: "n-1", name: "Maria Lopez", email: "maria@lopezlaw.example", email_verified: true, hd: "lopezlaw.example", ...over })
    .setProtectedHeader({ alg: "RS256", kid: "g-key" })
    .setIssuer(opts.iss ?? "https://accounts.google.com")
    .setAudience(opts.aud ?? CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "1h")
    .sign(opts.key ?? privateKey);
}

describe("Google ID token checks", () => {
  it("accepts a valid token and keys the identity on Google's account id, not the email", async () => {
    const id = await verifyGoogleSignIn(await token(), { clientId: CLIENT_ID, nonce: "n-1", keys });
    expect(id).toEqual({ provider: "google", subject: SUB, name: "Maria Lopez", email: "maria@lopezlaw.example" });
  });

  it("refuses another app's token, a replay (wrong nonce), another issuer, an expired token and another key", async () => {
    const v = (tk: string, nonce = "n-1") => verifyGoogleSignIn(tk, { clientId: CLIENT_ID, nonce, keys });
    await expect(v(await token({}, { aud: "other.apps.googleusercontent.com" }))).rejects.toThrow();
    await expect(v(await token(), "n-2")).rejects.toThrow(/nonce/);
    await expect(v(await token({}, { iss: "https://evil.example" }))).rejects.toThrow();
    await expect(v(await token({}, { exp: "-5m" }))).rejects.toThrow();
    const other = (await generateKeyPair("RS256")).privateKey;
    await expect(v(await token({}, { key: other }))).rejects.toThrow();
    await expect(v(await token({ sub: "not-a-number" }))).rejects.toThrow(/user id/);
  });

  it("an unverified email is never used, even for display", async () => {
    const id = await verifyGoogleSignIn(await token({ email_verified: false }), { clientId: CLIENT_ID, nonce: "n-1", keys });
    expect(id.email).toBeNull();
    expect(id.name).toBe("Maria Lopez");
  });

  it("asks Google only for name and email, with PKCE, state and nonce, and no offline access", () => {
    const url = new URL(googleSignInAuthorizeUrl({ clientId: CLIENT_ID, redirectUri: "https://app.huislaw.ai/api/auth/callback/google", state: "s-1", nonce: "n-1", verifier: "v".repeat(64) }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(GOOGLE_SIGNIN_SCOPES).not.toContain("https://www.googleapis.com/auth/gmail.readonly");
    expect(url.searchParams.get("code_challenge")).toBe(pkceChallenge("v".repeat(64)));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("s-1");
    expect(url.searchParams.get("nonce")).toBe("n-1");
    expect(url.searchParams.get("access_type")).toBe("online");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.huislaw.ai/api/auth/callback/google");
  });
});

describe("returning from the provider", () => {
  const oauth = (provider?: "microsoft" | "google") => ({ state: "state-abc", nonce: "n", verifier: "v", ...(provider ? { provider } : {}) });
  it("matches only the same sign-in, at the same provider's callback", () => {
    expect(signInReturnMatches(oauth("google"), "google", "code", "state-abc")).toBe(true);
    expect(signInReturnMatches(oauth("google"), "microsoft", "code", "state-abc")).toBe(false);
    expect(signInReturnMatches(oauth("microsoft"), "google", "code", "state-abc")).toBe(false);
    // Started before Google sign-in existed: Microsoft only.
    expect(signInReturnMatches(oauth(), "microsoft", "code", "state-abc")).toBe(true);
    expect(signInReturnMatches(oauth(), "google", "code", "state-abc")).toBe(false);
    expect(signInReturnMatches(oauth("google"), "google", "code", "state-abd")).toBe(false);
    expect(signInReturnMatches(oauth("google"), "google", null, "state-abc")).toBe(false);
    expect(signInReturnMatches(null, "google", "code", "state-abc")).toBe(false);
  });
});

describe("Google accounts in Huis", () => {
  it("a Google account can start a firm's trial and sign back in to it", async () => {
    const r = await signUpFirm(t.db, {
      firmName: "Lopez Law", slug: `lopez-${Date.now()}`, stateCode: "UT", timeZone: "America/Denver", ownerEmail: "maria@lopezlaw.example",
      ownerName: "Maria Lopez", authProvider: "google", authSubject: SUB,
    } as never);
    const accounts = await resolveIdentity(t.db, "google", SUB);
    expect(accounts.map((a) => a.firmId)).toContain(r.firmId);
    // The same id from Microsoft is a different person.
    expect(await resolveIdentity(t.db, "microsoft", SUB)).toEqual([]);
    const trial = (await t.admin.query("SELECT plan FROM huis.firms WHERE id = $1", [r.firmId])).rows[0].plan;
    expect(trial).toBe("trial");
  });

  it("an invitation can be accepted with a Google account, once", async () => {
    const f = await newFirm(t.db);
    await t.admin.query("BEGIN; SET LOCAL ROLE huis_security; UPDATE huis.firms SET seat_limit = 5 WHERE id = $1; COMMIT", [f.firmId]).catch(async () => {
      const c = await t.admin.connect();
      try { await c.query("BEGIN"); await c.query("SET LOCAL ROLE huis_security"); await c.query("UPDATE huis.firms SET seat_limit = 5 WHERE id = $1", [f.firmId]); await c.query("COMMIT"); } finally { c.release(); }
    });
    const u = await t.db.withFirm(f.owner, (s) => inviteUser(s, { email: `para@${f.slug}.example`, fullName: "Pat Para", role: "paralegal", locationId: f.locationId }));
    const linked = await acceptInvitation(t.db, u.invitationToken, "google", "200000000000000000001");
    expect(linked).toEqual({ firmId: f.firmId, userId: u.id });
    expect(await acceptInvitation(t.db, u.invitationToken, "google", "200000000000000000002")).toBeNull();
  });
});

describe("accepting an invitation only from the invitation page (security review 29)", () => {
  it("the page can name the firm and the person invited, and nothing for a bad, used or made-up link", async () => {
    const { previewInvitation } = await import("../src/services/firms");
    const f = await newFirm(t.db);
    const c = await t.admin.connect();
    try { await c.query("BEGIN"); await c.query("SET LOCAL ROLE huis_security"); await c.query("UPDATE huis.firms SET seat_limit = 5 WHERE id = $1", [f.firmId]); await c.query("COMMIT"); } finally { c.release(); }
    const u = await t.db.withFirm(f.owner, (s) => inviteUser(s, { email: `a@${f.slug}.example`, fullName: "Al Attorney", role: "attorney", locationId: f.locationId }));
    const firmName = (await t.admin.query("SELECT name FROM huis.firms WHERE id = $1", [f.firmId])).rows[0].name;
    expect(await previewInvitation(t.db, u.invitationToken)).toEqual({ firmName, inviteeName: "Al Attorney", role: "attorney" });
    expect(await previewInvitation(t.db, "A".repeat(43))).toBeNull();
    expect(await previewInvitation(t.db, "short")).toBeNull();
    await acceptInvitation(t.db, u.invitationToken, "google", "300000000000000000001");
    expect(await previewInvitation(t.db, u.invitationToken)).toBeNull();
  });

  it("a POST to start sign-in with an invitation must come from Huis's own page", async () => {
    const { postFromHuis } = await import("../src/auth/signin-check");
    const base = "https://app.huislaw.ai";
    expect(postFromHuis("https://app.huislaw.ai", "same-origin", base)).toBe(true);
    expect(postFromHuis("https://app.huislaw.ai", null, base)).toBe(true);
    expect(postFromHuis("https://evil.example", "cross-site", base)).toBe(false);
    expect(postFromHuis("https://app.huislaw.ai", "cross-site", base)).toBe(false);
    expect(postFromHuis(null, null, base)).toBe(false);
    expect(postFromHuis("https://app.huislaw.ai.evil.example", "same-site", base)).toBe(false);
  });
});
