import type pg from "pg";
import { UserFacingError } from "../errors";

/**
 * Phase 10 part 6: the Huis admin portal's reads and changes. `platform` is the portal's own connection (a login
 * in the huis_platform role), which can call only the account functions in db/migrations/0037_admin_portal.sql:
 * no Matter, document, evidence, email or note is ever within its reach.
 */
export interface AdminFirm {
  firmId: string; name: string; slug: string; stateCode: string; createdAt: Date; status: string; plan: string;
  trialEndsAt: Date | null; paidThrough: Date | null; seatLimit: number | null; seatsUsed: number; externalUsers: number;
  matters: number; storageBytes: number; aiQuestions: number; stripeStatus: string | null; billingInterval: string | null;
  hasStripeCustomer: boolean; firstPaidAt: Date | null; accessEndedAt: Date | null; deleteAfter: Date | null;
  writeBlock: string | null; ownerName: string | null; ownerEmail: string | null;
}

export interface AdminHistoryItem { at: Date; source: string; action: string; byWhom: string; note: string | null; detail: unknown }

function toFirm(r: Record<string, unknown>): AdminFirm {
  const d = (v: unknown) => (v ? new Date(v as string) : null);
  return {
    firmId: r.firm_id as string, name: r.name as string, slug: r.slug as string, stateCode: r.state_code as string,
    createdAt: new Date(r.created_at as string), status: r.status as string, plan: r.plan as string,
    trialEndsAt: d(r.trial_ends_at), paidThrough: d(r.paid_through),
    seatLimit: r.seat_limit === null ? null : Number(r.seat_limit), seatsUsed: Number(r.seats_used), externalUsers: Number(r.external_users),
    matters: Number(r.matters), storageBytes: Number(r.storage_bytes), aiQuestions: Number(r.ai_questions),
    stripeStatus: (r.stripe_status as string | null) ?? null, billingInterval: (r.billing_interval as string | null) ?? null,
    hasStripeCustomer: Boolean(r.has_stripe_customer), firstPaidAt: d(r.first_paid_at), accessEndedAt: d(r.access_ended_at),
    deleteAfter: d(r.delete_after), writeBlock: (r.write_block as string | null) ?? null,
    ownerName: (r.owner_name as string | null) ?? null, ownerEmail: (r.owner_email as string | null) ?? null,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listFirms(platform: pg.Pool, search?: string): Promise<AdminFirm[]> {
  const { rows } = await platform.query("SELECT * FROM huis.platform_firm_rows(NULL, $1)", [(search ?? "").slice(0, 200)]);
  return rows.map(toFirm);
}

export async function getFirm(platform: pg.Pool, firmId: string): Promise<{ firm: AdminFirm; history: AdminHistoryItem[] } | null> {
  if (!UUID.test(firmId)) return null;
  const { rows } = await platform.query("SELECT * FROM huis.platform_firm_rows($1, NULL)", [firmId]);
  if (!rows[0]) return null;
  const h = await platform.query("SELECT * FROM huis.platform_firm_history($1)", [firmId]);
  return {
    firm: toFirm(rows[0]),
    history: h.rows.map((r) => ({ at: new Date(r.at), source: r.source, action: r.action, byWhom: r.by_whom, note: r.note, detail: r.detail })),
  };
}

/** Database messages raised for staff (HU400) are shown as they are; anything else stays generic. */
async function change(platform: pg.Pool, sql: string, params: unknown[]): Promise<void> {
  try {
    await platform.query(sql, params);
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e.code === "HU400" && e.message) throw new UserFacingError(e.message);
    throw err;
  }
}

export function setTrialEnd(platform: pg.Pool, staff: string, firmId: string, trialEnds: Date, note: string) {
  return change(platform, "SELECT huis.platform_set_trial_end($1, $2, $3, $4)", [staff, firmId, trialEnds, note]);
}
export function setStatus(platform: pg.Pool, staff: string, firmId: string, status: "active" | "suspended", note: string) {
  return change(platform, "SELECT huis.platform_set_status($1, $2, $3, $4)", [staff, firmId, status, note]);
}
export function setAgreement(platform: pg.Pool, staff: string, firmId: string,
  p: { plan: "professional" | "enterprise"; seats: number | null; paidThrough: Date }, note: string) {
  return change(platform, "SELECT huis.platform_set_agreement($1, $2, $3, $4, $5, $6)", [staff, firmId, p.plan, p.seats, p.paidThrough, note]);
}
