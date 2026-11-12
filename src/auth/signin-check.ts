import { timingSafeEqual } from "node:crypto";
import type { OAuthPayload } from "./tokens";

export type SignInProvider = "microsoft" | "google";

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Does this return from a provider belong to the sign-in this browser started? The state must match (in constant
 * time), and the sign-in must have been started with this same provider: one started with Microsoft can't be
 * finished at Google's callback, or the reverse. Sign-ins from before Google sign-in carry no provider (Microsoft).
 */
export function signInReturnMatches(oauth: OAuthPayload | null, provider: SignInProvider, code: string | null, state: string | null): boolean {
  if (!oauth || !code || !state) return false;
  if ((oauth.provider ?? "microsoft") !== provider) return false;
  return safeEqual(state, oauth.state);
}

/**
 * Did this POST come from a Huis page? The browser's Origin must be Huis's own, and (where the browser says)
 * the request must be same-origin. A form on another site that submits to Huis fails both.
 */
export function postFromHuis(origin: string | null, secFetchSite: string | null, baseUrl: string): boolean {
  let own: string;
  try { own = new URL(baseUrl).origin; } catch { return false; }
  if (!origin || origin !== own) return false;
  return secFetchSite === null || secFetchSite === "same-origin";
}
