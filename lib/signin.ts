import "server-only";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { authConfig } from "../src/auth/config";
import { randomToken } from "../src/auth/microsoft";
import { ADMIN_TTL_SECONDS, COOKIE, OAUTH_TTL_SECONDS, seal, unseal, type OAuthPayload } from "../src/auth/tokens";
import { staffMember } from "../src/admin/staff";
import { postFromHuis, signInReturnMatches } from "../src/auth/signin-check";
import { acceptInvitation, resolveIdentity } from "../src/services/firms";
import { db, setPendingCookie, setSessionCookie } from "./server";

/**
 * What every sign-in provider (Microsoft, Google) shares: the one-time state, nonce and PKCE verifier kept in an
 * encrypted cookie on the way out, and on the way back the check of that state and what happens next
 * (accept an invitation, sign in to the one firm, choose a firm, or create one). The providers differ only
 * in their own URLs and token checks.
 */
const INVITE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export type { SignInProvider } from "../src/auth/signin-check";
import type { SignInProvider } from "../src/auth/signin-check";

export interface VerifiedSignIn { provider: SignInProvider; subject: string; name: string; email: string | null }


/**
 * Starts sign-in: remembers state, nonce and verifier (and the provider), then sends the person to the provider.
 * `invite` is accepted only from the invitation page's button (startSignInFromInvite), never from a link, so
 * nobody can be sent a "sign in" link that quietly joins their account to a firm (security review 29).
 */
export async function startSignIn(provider: SignInProvider,
  authorizeUrl: (p: { state: string; nonce: string; verifier: string; redirectUri: string }) => string,
  invite?: string, purpose?: "admin"): Promise<NextResponse> {
  const cfg = authConfig();
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken(48);
  const jar = await cookies();
  jar.set(
    COOKIE.oauth,
    await seal({ state, nonce, verifier, provider, ...(purpose === "admin" ? { purpose } : invite && INVITE_TOKEN.test(invite) ? { invite } : {}) },
      cfg.sessionKey, "oauth", OAUTH_TTL_SECONDS),
    { httpOnly: true, secure: cfg.secureCookies, sameSite: "lax", path: "/api/auth", maxAge: OAUTH_TTL_SECONDS },
  );
  return NextResponse.redirect(authorizeUrl({ state, nonce, verifier, redirectUri: `${cfg.baseUrl}/api/auth/callback/${provider}` }), 303);
}

/** The invitation page's "Accept and sign in" button: a POST that must come from Huis's own page. */
export async function startSignInFromInvite(req: NextRequest, provider: SignInProvider,
  authorizeUrl: (p: { state: string; nonce: string; verifier: string; redirectUri: string }) => string): Promise<NextResponse> {
  const cfg = authConfig();
  if (!postFromHuis(req.headers.get("origin"), req.headers.get("sec-fetch-site"), cfg.baseUrl)) {
    return new NextResponse("Open your invitation link and use the button on that page.", { status: 403 });
  }
  const form = await req.formData().catch(() => null);
  const invite = form?.get("invite");
  if (typeof invite !== "string" || !INVITE_TOKEN.test(invite)) return NextResponse.redirect(new URL("/signin?reason=invite", cfg.baseUrl), 303);
  return startSignIn(provider, authorizeUrl, invite);
}

/**
 * Finishes sign-in. `verify` exchanges the code and checks the provider's token; it is called only after the
 * state matches and only for the provider this sign-in was started with.
 */
export async function finishSignIn(req: NextRequest, provider: SignInProvider,
  verify: (p: { code: string; verifier: string; nonce: string; redirectUri: string }) => Promise<VerifiedSignIn>): Promise<NextResponse> {
  const cfg = authConfig();
  const go = (path: string) => NextResponse.redirect(new URL(path, cfg.baseUrl));
  const jar = await cookies();
  const oauth = await unseal<OAuthPayload>(jar.get(COOKIE.oauth)?.value, cfg.sessionKey, "oauth");
  jar.delete({ name: COOKIE.oauth, path: "/api/auth" });

  const params = req.nextUrl.searchParams;
  if (params.get("error")) return go("/signin?reason=cancelled");
  const code = params.get("code");
  const state = params.get("state");
  // A sign-in started with one provider can't be finished at another's callback (sign-ins from before
  // Google sign-in carry no provider: those were Microsoft).
  if (!signInReturnMatches(oauth, provider, code, state)) {
    return go("/signin?reason=invalid");
  }

  try {
    const identity = await verify({ code: code!, verifier: oauth!.verifier, nonce: oauth!.nonce, redirectUri: `${cfg.baseUrl}/api/auth/callback/${provider}` });
    if (identity.provider !== provider) throw new Error("provider mismatch");

    // Huis staff signing in to the admin portal: never creates, joins or opens a firm.
    if (oauth!.purpose === "admin") {
      if (!staffMember(identity.provider, identity.subject)) return go("/admin/signin?reason=denied");
      jar.set(COOKIE.admin, await seal({ provider: identity.provider, subject: identity.subject }, cfg.sessionKey, "admin", ADMIN_TTL_SECONDS),
        { httpOnly: true, secure: cfg.secureCookies, sameSite: "lax", path: "/", maxAge: ADMIN_TTL_SECONDS });
      return go("/admin");
    }

    if (oauth!.invite) {
      const linked = await acceptInvitation(db(), oauth!.invite, identity.provider, identity.subject);
      if (!linked) return go("/signin?reason=invite");
      await setSessionCookie({ ...linked, provider: identity.provider, subject: identity.subject });
      return go("/dashboard");
    }

    const accounts = await resolveIdentity(db(), identity.provider, identity.subject);
    if (accounts.length === 1) {
      const a = accounts[0]!;
      await setSessionCookie({ firmId: a.firmId, userId: a.userId, provider: identity.provider, subject: identity.subject });
      return go("/dashboard");
    }
    await setPendingCookie({ provider: identity.provider, subject: identity.subject, name: identity.name, email: identity.email });
    return go(accounts.length === 0 ? "/onboarding" : "/select-firm");
  } catch (err) {
    console.error(`[huis] ${provider} sign-in failed:`, err instanceof Error ? err.message : "unknown");
    return go(`/signin?reason=failed-${provider}`);
  }
}
