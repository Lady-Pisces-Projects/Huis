import type { NextRequest } from "next/server";
import { api, readJson } from "../../../lib/api";
import { startUpload } from "../../../src/services/evidence";

export const dynamic = "force-dynamic";

/** Start an upload: returns the session id and how to split the file. */
export async function POST(req: NextRequest) {
  return api(req, async (s) => {
    // Read only after the origin and session checks, and never more than a small JSON body.
    const input = ((await readJson(req, 16 * 1024)) ?? {}) as Parameters<typeof startUpload>[1];
    const u = await startUpload(s, input);
    return { id: u.id, chunkSize: u.chunkSize, chunkCount: u.chunkCount, receivedChunks: u.receivedChunks };
  });
}
