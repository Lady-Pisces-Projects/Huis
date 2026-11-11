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

/** A position in a JavaScript string (UTF-16 units) as the database counts it (characters). R28-4. */
function charIndex(text: string, utf16Index: number): number {
  let n = 0;
  for (let i = 0; i < utf16Index && i < text.length; i++) {
    const c = text.charCodeAt(i);
    // The second half of a surrogate pair (an emoji, say) isn't a character of its own.
    if (!(c >= 0xdc00 && c <= 0xdfff && i > 0 && text.charCodeAt(i - 1) >= 0xd800 && text.charCodeAt(i - 1) <= 0xdbff)) n++;
  }
  return n;
}

export async function saveCaseDescription(s: FirmSession, matterId: string, description: string | undefined): Promise<CaseDescriptionResult | null> {
  // Browsers send a line break as two characters; the form counted it as one (R28-5).
  const body = (description ?? "").replace(/\r\n?/g, "\n").trim();
  if (!body) return null;
  if (body.length > MAX_DESCRIPTION) throw new UserFacingError(`Keep the case description under ${MAX_DESCRIPTION.toLocaleString("en-US")} characters; add more detail as notes afterwards.`);
  const { title } = descriptionNoteText(body);
  const noteId = await addNote(s, matterId, { title, body });
  // Read back exactly what was stored: the database quotes each suggestion from it.
  const stored = (await s.client.query<{ title: string; body: string }>("SELECT title, body FROM huis.matter_notes WHERE id = $1", [noteId])).rows[0]!;
  const text = `${stored.title}\n\n${stored.body}`;
  const suggestions = suggestFromDescription(text).map((x) => ({ ...x, start: charIndex(text, x.start), end: charIndex(text, x.end) }));
  // Always recorded (even with nothing to suggest): each description is read once.
  const suggested = (await s.client.query<{ n: number }>(
    "SELECT huis.suggest_from_case_description($1, $2::jsonb) AS n", [noteId, JSON.stringify(suggestions)])).rows[0]!.n;
  return { noteId, suggested: Number(suggested) };
}
