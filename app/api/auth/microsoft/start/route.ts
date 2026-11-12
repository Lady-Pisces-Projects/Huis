import { NextResponse, type NextRequest } from "next/server";
import { authConfig } from "../../../../../src/auth/config";
import { microsoftAuthorizeUrl } from "../../../../../src/auth/microsoft";
import { startSignIn, startSignInFromInvite } from "../../../../../lib/signin";

export const dynamic = "force-dynamic";

/** Sign in with Microsoft. An invitation is accepted only by POST from the invitation page. */
export async function GET() {
  const ms = authConfig().microsoft;
  if (!ms) return new NextResponse("Microsoft sign-in is not configured yet.", { status: 503 });
  return startSignIn("microsoft", (p) => microsoftAuthorizeUrl({ clientId: ms.clientId, ...p }));
}

export async function POST(req: NextRequest) {
  const ms = authConfig().microsoft;
  if (!ms) return new NextResponse("Microsoft sign-in is not configured yet.", { status: 503 });
  return startSignInFromInvite(req, "microsoft", (p) => microsoftAuthorizeUrl({ clientId: ms.clientId, ...p }));
}
