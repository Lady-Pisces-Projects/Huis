import { NextResponse, type NextRequest } from "next/server";
import { authConfig } from "../../../../../src/auth/config";
import { googleSignInAuthorizeUrl } from "../../../../../src/auth/google";
import { startSignIn, startSignInFromInvite } from "../../../../../lib/signin";

export const dynamic = "force-dynamic";

/** Sign in with Google (the same Google OAuth client as Gmail; redirect URI /api/auth/callback/google). */
export async function GET(req: NextRequest) {
  const g = authConfig().google;
  if (!g) return new NextResponse("Google sign-in is not configured yet.", { status: 503 });
  // ?purpose=admin: Huis staff signing in to the admin portal.
  return startSignIn("google", (p) => googleSignInAuthorizeUrl({ clientId: g.clientId, ...p }), undefined, req.nextUrl.searchParams.get("purpose") === "admin" ? "admin" : undefined);
}

/** An invitation is accepted only by POST from the invitation page. */
export async function POST(req: NextRequest) {
  const g = authConfig().google;
  if (!g) return new NextResponse("Google sign-in is not configured yet.", { status: 503 });
  return startSignInFromInvite(req, "google", (p) => googleSignInAuthorizeUrl({ clientId: g.clientId, ...p }));
}
