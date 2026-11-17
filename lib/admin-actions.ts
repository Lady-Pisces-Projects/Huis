"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { parseDate } from "../scripts/operator/set-subscription";
import { COOKIE } from "../src/auth/tokens";
import { clearSignInRule, setAgreement, setStatus, setTrialEnd } from "../src/services/admin";
import { requireStaff } from "./admin";
import { setFlash, userMessage } from "./server";
import { UserFacingError } from "../src/errors";

/** A date from the form (end of that day, Utah time), or a message staff can act on. */
function day(v: string, label: string): Date {
  let d: Date | null = null;
  try { d = parseDate(v, label); } catch (err) { throw new UserFacingError(err instanceof Error ? err.message : `${label}: choose a date`); }
  if (!d) throw new UserFacingError(`${label}: choose a date`);
  return d;
}

/*
 * Phase 10 part 6: the admin portal's changes. Each re-checks that the person is listed in HUIS_STAFF, and each
 * goes through a database function that requires a note and records the staff member's name. Server actions,
 * so Next's same-origin check applies.
 */
const UUID = z.uuid();
const text = (fd: FormData, k: string) => (typeof fd.get(k) === "string" ? String(fd.get(k)) : "");

async function run(firmId: string, ok: string, fn: (staff: string) => Promise<void>): Promise<never> {
  const id = UUID.parse(firmId);
  let flash: { kind: "success" | "error"; message: string };
  try {
    const { staff } = await requireStaff();
    await fn(staff.name);
    flash = { kind: "success", message: ok };
  } catch (err) {
    if ((err as { digest?: string })?.digest?.startsWith("NEXT_REDIRECT")) throw err;
    flash = { kind: "error", message: userMessage(err) };
  }
  const f = await setFlash(flash);
  redirect(`/admin/firms/${id}?f=${f}`);
}

export async function adminSetTrialEndAction(fd: FormData): Promise<void> {
  const firmId = text(fd, "firmId");
  return run(firmId, "Trial end updated.", async (staff) => {
    const { platform } = await requireStaff();
    await setTrialEnd(platform, staff, firmId, day(text(fd, "trialEnds"), "Trial end"), text(fd, "note"));
  });
}

export async function adminSetStatusAction(fd: FormData): Promise<void> {
  const firmId = text(fd, "firmId");
  const status = z.enum(["active", "suspended"]).parse(text(fd, "status"));
  return run(firmId, status === "suspended" ? "Firm suspended." : "Firm restored.", async (staff) => {
    const { platform } = await requireStaff();
    await setStatus(platform, staff, firmId, status, text(fd, "note"));
  });
}

export async function adminSetAgreementAction(fd: FormData): Promise<void> {
  const firmId = text(fd, "firmId");
  return run(firmId, "Plan updated.", async (staff) => {
    const { platform } = await requireStaff();
    const plan = z.enum(["professional", "enterprise"]).parse(text(fd, "plan"));
    const seatsRaw = text(fd, "seats").trim();
    const seats = seatsRaw === "" ? null : Number(seatsRaw);
    if (seats !== null && !Number.isInteger(seats)) throw new UserFacingError("Seats must be a whole number, or blank for no limit.");
    await setAgreement(platform, staff, firmId, { plan, seats, paidThrough: day(text(fd, "paidThrough"), "Paid through") }, text(fd, "note"));
  });
}

export async function adminSignOutAction(): Promise<void> {
  (await cookies()).delete(COOKIE.admin);
  redirect("/admin/signin?reason=signedout");
}

/** Lockout recovery: turn a firm's sign-in rule off (review 35). */
export async function adminClearSignInRuleAction(fd: FormData): Promise<void> {
  const firmId = text(fd, "firmId");
  return run(firmId, "Sign-in rule turned off.", async (staff) => {
    const { platform } = await requireStaff();
    await clearSignInRule(platform, staff, firmId, text(fd, "note"));
  });
}
