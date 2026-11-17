/**
 * Who is Huis staff (Phase 10 part 6, the admin portal).
 *
 * HUIS_STAFF lists each staff member's sign-in identity and name, separated by commas:
 *   HUIS_STAFF="google:109876543210987654321=Tracy Peart, microsoft:<tenant id>:<object id>=Jordan Lee"
 * The identity is the same key Huis uses for sign-in (provider + the provider's stable account id), never an
 * email address. Anyone not listed can't open the portal, and removing someone from the list ends their access
 * at their next request.
 */
export interface StaffMember { key: string; name: string }

const KEY = /^(microsoft:[0-9a-f-]{36}:[0-9a-f-]{36}|google:[0-9]{1,64})$/i;

export function parseStaff(value: string | undefined): StaffMember[] {
  if (!value) return [];
  const out: StaffMember[] = [];
  for (const entry of value.split(",")) {
    const i = entry.indexOf("=");
    if (i < 0) continue;
    const key = entry.slice(0, i).trim().toLowerCase();
    const name = entry.slice(i + 1).trim().replace(/\s+/g, " ").slice(0, 120);
    if (KEY.test(key) && name) out.push({ key, name });
  }
  return out;
}

export function staffMember(provider: string, subject: string, value = process.env.HUIS_STAFF): StaffMember | null {
  const key = `${provider}:${subject}`.toLowerCase();
  return parseStaff(value).find((s) => s.key === key) ?? null;
}
