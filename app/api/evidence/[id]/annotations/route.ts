import type { NextRequest } from "next/server";
import { api, readJson } from "../../../../../lib/api";
import { addAnnotation, listAnnotations } from "../../../../../src/services/workingCopies";

export const dynamic = "force-dynamic";

/** Highlights, notes and redaction marks on a document (firm staff only). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return api(req, async (s) => ({ annotations: await listAnnotations(s, id) }));
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return api(req, async (s) => {
    // A mark is small; the read stops at 16 KB whether or not the request says how big it is.
    const body = await readJson(req, 16 * 1024);
    return { id: await addAnnotation(s, id, body) };
  });
}
