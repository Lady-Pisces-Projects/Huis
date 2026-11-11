import type { FirmSession } from "../db/tenant";
import { UserFacingError } from "../errors";
import { descriptionNoteText, MAX_DESCRIPTION, suggestFromDescription } from "../dna/describe";
import { addNote } from "./brain";

/**
 * When an attorney starts a Matter with a description of the case:
 *   1. it's saved as the Matter's first attorney note ("Case description"), so Matter Brain can search it;
 *   2. Huis reads it and suggests people, organizations, key dates and possible claims in Case DNA, each
 *      pointing to the words it came from, for the attorney to confirm or reject.
 * Automatic: it never counts as one of the firm's AI questions.
 */
export interface CaseDescriptionResult { noteId: string; suggested: number }

export async function saveCaseDescription(s: FirmSession, matterId: string, description: string | undefined): Promise<CaseDescriptionResult | null> {
  const body = (description ?? "").trim();
  if (!body) return null;
  if (body.length > MAX_DESCRIPTION) throw new UserFacingError(`Keep the case description under ${MAX_DESCRIPTION.toLocaleString("en-US")} characters; add more detail as notes afterwards.`);
  const { title } = descriptionNoteText(body);
  const noteId = await addNote(s, matterId, { title, body });
  // Read back exactly what was stored: the database quotes each suggestion from it.
  const stored = (await s.client.query<{ title: string; body: string }>("SELECT title, body FROM huis.matter_notes WHERE id = $1", [noteId])).rows[0]!;
  const suggestions = suggestFromDescription(`${stored.title}\n\n${stored.body}`);
  if (suggestions.length === 0) return { noteId, suggested: 0 };
  const suggested = (await s.client.query<{ n: number }>(
    "SELECT huis.suggest_from_case_description($1, $2::jsonb) AS n", [noteId, JSON.stringify(suggestions)])).rows[0]!.n;
  return { noteId, suggested: Number(suggested) };
}
