import type { NextRequest } from "next/server";
import { api } from "../../../../lib/api";
import { getLogo } from "../../../../src/services/branding";

export const dynamic = "force-dynamic";

/** The firm's logo (white label), only to people signed in to that firm. Served so a browser can't run it. */
export async function GET(req: NextRequest) {
  return api(req, async (s) => {
    const logo = await getLogo(s);
    if (!logo) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(logo.bytes), {
      headers: {
        "content-type": logo.type,
        "x-content-type-options": "nosniff",
        "cache-control": "private, max-age=3600",
        "content-security-policy": "default-src 'none'; sandbox",
        "content-disposition": "inline; filename=logo",
      },
    });
  });
}
