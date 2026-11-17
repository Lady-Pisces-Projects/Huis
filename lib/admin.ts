import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import pg from "pg";
import { staffMember, type StaffMember } from "../src/admin/staff";
import { authConfig } from "../src/auth/config";
import { COOKIE, unseal, type AdminPayload } from "../src/auth/tokens";

/**
 * Phase 10 part 6: the admin portal's own database connection (a login in huis_platform: account functions only)
 * and who is signed in to it. A staff member is re-checked against HUIS_STAFF on every request, so removing
 * someone from the list ends their access at once.
 */
const g = globalThis as unknown as { huisPlatformPool?: pg.Pool };

export function platformPool(): pg.Pool | null {
  const url = process.env.HUIS_PLATFORM_DATABASE_URL;
  if (!url) return null;
  g.huisPlatformPool ??= new pg.Pool({ connectionString: url, max: 3 });
  return g.huisPlatformPool;
}

export async function getStaff(): Promise<StaffMember | null> {
  const jar = await cookies();
  const a = await unseal<AdminPayload>(jar.get(COOKIE.admin)?.value, authConfig().sessionKey, "admin");
  return a ? staffMember(a.provider, a.subject) : null;
}

/** For admin pages and actions: the signed-in staff member and the portal's connection, or off to sign-in. */
export async function requireStaff(): Promise<{ staff: StaffMember; platform: pg.Pool }> {
  const staff = await getStaff();
  if (!staff) redirect("/admin/signin");
  const platform = platformPool();
  if (!platform) throw new Error("The admin portal's database connection (HUIS_PLATFORM_DATABASE_URL) is not set.");
  return { staff, platform };
}
