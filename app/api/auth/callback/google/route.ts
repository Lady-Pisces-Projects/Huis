import { NextResponse, type NextRequest } from "next/server";
import { authConfig } from "../../../../../src/auth/config";
import { exchangeGoogleSignInCode, verifyGoogleSignIn } from "../../../../../src/auth/google";
import { finishSignIn } from "../../../../../lib/signin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cfg = authConfig();
  const g = cfg.google;
  if (!g) return NextResponse.redirect(new URL("/signin?reason=invalid", cfg.baseUrl));
  return finishSignIn(req, "google", async ({ code, verifier, nonce, redirectUri }) => {
    const idToken = await exchangeGoogleSignInCode({ clientId: g.clientId, clientSecret: g.clientSecret, redirectUri, code, verifier });
    return verifyGoogleSignIn(idToken, { clientId: g.clientId, nonce });
  });
}
