import type { JWTVerifyGetKey } from "jose";
import { googleAuthBase, googleTokenRequest, verifyGoogleIdToken } from "../mail/google";
import { pkceChallenge } from "./microsoft";

/**
 * Sign in with Google (OpenID Connect authorization-code flow with PKCE), for attorneys whose firm uses
 * Google Workspace, or a personal Google account.
 *
 * Asks only for the person's name and email (openid email profile): no access to Gmail, Drive or anything
 * else. (Connecting Gmail is a separate, later step with its own consent.) These are Google's non-sensitive
 * scopes, so sign-in needs no Google app verification beyond the consent screen's brand details.
 *
 * Identity key: Google's stable account id ("sub"). The email is for display only and NEVER used to find or
 * link an account, exactly as with Microsoft.
 */
export const GOOGLE_SIGNIN_SCOPES = ["openid", "email", "profile"];

export function googleSignInAuthorizeUrl(p: { clientId: string; redirectUri: string; state: string; nonce: string; verifier: string }): string {
  const url = new URL(`${googleAuthBase()}/o/oauth2/v2/auth`);
  url.search = new URLSearchParams({
    client_id: p.clientId,
    response_type: "code",
    redirect_uri: p.redirectUri,
    scope: GOOGLE_SIGNIN_SCOPES.join(" "),
    state: p.state,
    nonce: p.nonce,
    code_challenge: pkceChallenge(p.verifier),
    code_challenge_method: "S256",
    // Sign-in only: no refresh token, nothing kept after this request.
    access_type: "online",
    prompt: "select_account",
  }).toString();
  return url.toString();
}

/** Exchanges the code for Google's ID token (the access token is discarded). */
export async function exchangeGoogleSignInCode(p: { clientId: string; clientSecret: string; redirectUri: string; code: string; verifier: string }): Promise<string> {
  let body;
  try {
    body = await googleTokenRequest({
      client_id: p.clientId, client_secret: p.clientSecret, grant_type: "authorization_code",
      code: p.code, redirect_uri: p.redirectUri, code_verifier: p.verifier,
    });
  } catch (err) {
    // Google's short error code only (googleTokenRequest never keeps raw response text).
    throw new Error(`Google sign-in failed (${err instanceof Error ? err.message : "unknown"}).`);
  }
  if (!body.id_token) throw new Error("Google sign-in failed (no ID token).");
  return body.id_token;
}

export interface GoogleIdentity {
  provider: "google";
  subject: string;
  name: string;
  /** Only when Google says the address is verified. Display only. */
  email: string | null;
}

/** Verifies signature, audience, issuer, nonce and expiry (src/mail/google.ts), and keys the identity on Google's account id. */
export async function verifyGoogleSignIn(idToken: string, opts: { clientId: string; nonce: string; keys?: JWTVerifyGetKey }): Promise<GoogleIdentity> {
  const v = await verifyGoogleIdToken(idToken, opts);
  // Sign-up allows names up to 200 characters (security review 29).
  return { provider: "google", subject: v.subject, name: (v.name ?? v.email ?? "Google user").slice(0, 200), email: v.email };
}
