import { NextResponse, type NextRequest } from "next/server";
import { authConfig } from "../../../../../src/auth/config";
import { exchangeMicrosoftCode, verifyMicrosoftIdToken } from "../../../../../src/auth/microsoft";
import { finishSignIn } from "../../../../../lib/signin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cfg = authConfig();
  const ms = cfg.microsoft;
  if (!ms) return NextResponse.redirect(new URL("/signin?reason=invalid", cfg.baseUrl));
  return finishSignIn(req, "microsoft", async ({ code, verifier, nonce, redirectUri }) => {
    const idToken = await exchangeMicrosoftCode({ clientId: ms.clientId, clientSecret: ms.clientSecret, redirectUri, code, verifier });
    const id = await verifyMicrosoftIdToken(idToken, { clientId: ms.clientId, nonce });
    return { provider: "microsoft", subject: id.subject, name: id.name, email: id.email };
  });
}
