import { z } from "zod";
import type { FirmSession } from "../db/tenant";
import { NotFoundError, PermissionDeniedError, UserFacingError } from "../errors";
import { INTERNAL_ROLES } from "../security/permissions";
import { recordAudit } from "./audit";
import { getMatter } from "./matters";

/**
 * Phase 10 part 3: firm billing — time, rates, expenses and invoices to clients.
 *
 * The rules (who sees and changes what, locking, numbering, totals) are enforced by the database
 * (db/migrations/0030_firm_billing.sql); this is the app's side. Money: payments are recorded here,
 * received outside Huis (a legal payment processor is open item O-10). Audit entries never carry
 * descriptions, only kinds and amounts.
 */
export const BILLING_MANAGERS = new Set(["firm_owner", "managing_partner", "firm_admin", "billing_admin"]);
export const PAYMENT_METHODS = ["check", "card", "ach", "wire", "cash", "other"] as const;
export const PAYMENT_METHOD_LABELS: Record<(typeof PAYMENT_METHODS)[number], string> = {
  check: "Check", card: "Card", ach: "ACH / bank transfer", wire: "Wire", cash: "Cash", other: "Other",
};

const uuid = z.uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date").refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), "Use a real date");
/** Dollars typed by a person ("1,250.50", "$75") to cents. */
export const dollars = z.preprocess((v) => (typeof v === "string" ? v.replace(/[$,\s]/g, "") : v),
  z.string().regex(/^\d{1,9}(\.\d{1,2})?$/, "Use an amount like 125.00").transform((v) => Math.round(Number(v) * 100)));
/** Time typed as hours ("1.5", "0.25") or h:mm ("1:30"), to minutes. */
export const duration = z.string().trim().transform((v, ctx) => {
  const hm = /^(\d{1,2}):([0-5]\d)$/.exec(v);
  const minutes = hm ? Number(hm[1]) * 60 + Number(hm[2]) : /^\d{0,2}(\.\d{1,2})?$/.test(v) && v !== "" && v !== "." ? Math.round(Number(v) * 60) : NaN;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    ctx.addIssue({ code: "custom", message: "Use hours like 1.5 or 1:30 (up to 24 hours)" });
    return z.NEVER;
  }
  return minutes;
});

function staff(s: FirmSession) {
  if (!INTERNAL_ROLES.has(s.actor.role)) throw new PermissionDeniedError("see billing");
}
const isManager = (s: FirmSession) => BILLING_MANAGERS.has(s.actor.role);
const cents = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export const tenths = (minutes: number) => Math.ceil(minutes / 6);
export const timeAmount = (minutes: number, rateCents: number | null) => Math.round((tenths(minutes) * (rateCents ?? 0)) / 10);
export const hours = (minutes: number) => (tenths(minutes) / 10).toFixed(1);

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------
export interface Rate { id: string; userId: string; userName: string; matterId: string | null; matterTitle: string | null; rateCents: number; effectiveFrom: string }

export const RateInput = z.object({ userId: uuid, matterId: uuid.nullish(), rate: dollars, effectiveFrom: day });

export async function setRate(s: FirmSession, input: unknown): Promise<string> {
  if (!isManager(s)) throw new PermissionDeniedError("set billing rates");
  const v = RateInput.parse(input);
  const id = (await s.client.query<{ id: string }>(
    `INSERT INTO huis.billing_rates (firm_id, user_id, matter_id, rate_cents, effective_from) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, coalesce(matter_id, '00000000-0000-0000-0000-000000000000'::uuid), effective_from) DO NOTHING RETURNING id`,
    [s.actor.firmId, v.userId, v.matterId ?? null, v.rate, v.effectiveFrom])).rows[0]?.id;
  if (!id) throw new UserFacingError("There's already a rate for this person from that date. Remove it first.");
  await recordAudit(s, "billing.rate_set", { targetType: "user", targetId: v.userId, matterId: v.matterId ?? undefined, metadata: { rate_cents: v.rate, from: v.effectiveFrom } });
  return id;
}

export async function removeRate(s: FirmSession, rateId: string): Promise<void> {
  if (!isManager(s)) throw new PermissionDeniedError("set billing rates");
  if (!uuid.safeParse(rateId).success) throw new NotFoundError("Rate");
  const r = (await s.client.query<{ user_id: string }>("DELETE FROM huis.billing_rates WHERE id = $1 RETURNING user_id", [rateId])).rows[0];
  if (!r) throw new NotFoundError("Rate");
  await recordAudit(s, "billing.rate_removed", { targetType: "user", targetId: r.user_id });
}

/** Billing staff see every rate; others see their own. */
export async function listRates(s: FirmSession): Promise<Rate[]> {
  staff(s);
  const { rows } = await s.client.query(
    `SELECT r.id, r.user_id, u.full_name, r.matter_id, m.title, r.rate_cents, r.effective_from::text AS effective_from
       FROM huis.billing_rates r JOIN huis.users u ON u.id = r.user_id LEFT JOIN huis.matters m ON m.id = r.matter_id
      ORDER BY u.full_name, r.matter_id NULLS FIRST, r.effective_from DESC`);
  return rows.map((r) => ({ id: r.id, userId: r.user_id, userName: r.full_name, matterId: r.matter_id, matterTitle: r.title, rateCents: r.rate_cents, effectiveFrom: r.effective_from }));
}

// ---------------------------------------------------------------------------
// Time and expenses
// ---------------------------------------------------------------------------
export interface TimeEntry {
  id: string; userId: string; userName: string; workDate: string; minutes: number; description: string; billable: boolean;
  rateCents: number | null; amountCents: number; invoiceId: string | null; invoiceStatus: string | null; mine: boolean;
}
export interface Expense {
  id: string; incurredOn: string; description: string; amountCents: number; billable: boolean;
  invoiceId: string | null; invoiceStatus: string | null; mine: boolean;
}

export const TimeInput = z.object({
  workDate: day, duration, description: z.string().trim().min(1).max(2000),
  billable: z.boolean().default(true), userId: uuid.optional(), rate: dollars.optional(),
});
export const ExpenseInput = z.object({
  incurredOn: day, description: z.string().trim().min(1).max(500), amount: dollars.refine((c) => c >= 1, "Use an amount above zero"),
  billable: z.boolean().default(true),
});

export async function addTime(s: FirmSession, matterId: string, input: unknown): Promise<string> {
  staff(s);
  await getMatter(s, matterId);
  const v = TimeInput.parse(input);
  // Only billing staff record time for someone else or set a rate (the database checks both too).
  const userId = isManager(s) && v.userId ? v.userId : s.actor.userId;
  const rate = isManager(s) ? (v.rate ?? null) : null;
  const id = (await s.client.query<{ id: string }>(
    `INSERT INTO huis.time_entries (firm_id, matter_id, user_id, work_date, minutes, description, billable, rate_cents)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [s.actor.firmId, matterId, userId, v.workDate, v.duration, v.description, v.billable, rate])).rows[0]!.id;
  await recordAudit(s, "billing.time_added", { targetType: "matter", targetId: matterId, matterId, metadata: { minutes: v.duration, billable: v.billable } });
  return id;
}

export async function deleteTime(s: FirmSession, entryId: string): Promise<void> {
  staff(s);
  if (!uuid.safeParse(entryId).success) throw new NotFoundError("Time entry");
  const r = (await s.client.query<{ matter_id: string }>("DELETE FROM huis.time_entries WHERE id = $1 RETURNING matter_id", [entryId])).rows[0];
  if (!r) throw new NotFoundError("Time entry");
  await recordAudit(s, "billing.time_removed", { targetType: "matter", targetId: r.matter_id, matterId: r.matter_id });
}

export async function addExpense(s: FirmSession, matterId: string, input: unknown): Promise<string> {
  staff(s);
  await getMatter(s, matterId);
  const v = ExpenseInput.parse(input);
  const id = (await s.client.query<{ id: string }>(
    `INSERT INTO huis.expenses (firm_id, matter_id, incurred_on, description, amount_cents, billable)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [s.actor.firmId, matterId, v.incurredOn, v.description, v.amount, v.billable])).rows[0]!.id;
  await recordAudit(s, "billing.expense_added", { targetType: "matter", targetId: matterId, matterId, metadata: { amount_cents: v.amount, billable: v.billable } });
  return id;
}

export async function deleteExpense(s: FirmSession, expenseId: string): Promise<void> {
  staff(s);
  if (!uuid.safeParse(expenseId).success) throw new NotFoundError("Expense");
  const r = (await s.client.query<{ matter_id: string }>("DELETE FROM huis.expenses WHERE id = $1 RETURNING matter_id", [expenseId])).rows[0];
  if (!r) throw new NotFoundError("Expense");
  await recordAudit(s, "billing.expense_removed", { targetType: "matter", targetId: r.matter_id, matterId: r.matter_id });
}

export interface MatterBilling {
  time: TimeEntry[];
  expenses: Expense[];
  unbilled: { timeCents: number; expenseCents: number; minutes: number; missingRates: number };
  invoices: InvoiceSummary[];
  canInvoice: boolean;
  isManager: boolean;
  /** People whose time billing staff may record (firm staff). */
  timekeepers: { id: string; name: string }[];
}

export async function matterBilling(s: FirmSession, matterId: string): Promise<MatterBilling> {
  staff(s);
  await getMatter(s, matterId);
  const t = await s.client.query(
    `SELECT t.*, u.full_name, i.status AS invoice_status, t.work_date::text AS day FROM huis.time_entries t
       JOIN huis.users u ON u.id = t.user_id LEFT JOIN huis.invoices i ON i.id = t.invoice_id
      WHERE t.matter_id = $1 ORDER BY t.work_date DESC, t.created_at DESC LIMIT 2000`, [matterId]);
  const e = await s.client.query(
    `SELECT e.*, i.status AS invoice_status, e.incurred_on::text AS day FROM huis.expenses e LEFT JOIN huis.invoices i ON i.id = e.invoice_id
      WHERE e.matter_id = $1 ORDER BY e.incurred_on DESC, e.created_at DESC LIMIT 2000`, [matterId]);
  const time: TimeEntry[] = t.rows.map((r) => ({
    id: r.id, userId: r.user_id, userName: r.full_name, workDate: r.day, minutes: r.minutes, description: r.description,
    billable: r.billable, rateCents: cents(r.rate_cents), amountCents: r.billable ? timeAmount(r.minutes, cents(r.rate_cents)) : 0,
    invoiceId: r.invoice_id, invoiceStatus: r.invoice_status, mine: r.user_id === s.actor.userId,
  }));
  const expenses: Expense[] = e.rows.map((r) => ({
    id: r.id, incurredOn: r.day, description: r.description, amountCents: Number(r.amount_cents), billable: r.billable,
    invoiceId: r.invoice_id, invoiceStatus: r.invoice_status, mine: r.created_by === s.actor.userId,
  }));
  const open = (x: { invoiceId: string | null; billable: boolean }) => x.billable && !x.invoiceId;
  const canInvoice = (await s.client.query<{ ok: boolean }>("SELECT huis.can_invoice_matter($1) AS ok", [matterId])).rows[0]?.ok ?? false;
  const timekeepers = isManager(s)
    ? (await s.client.query("SELECT id, full_name FROM huis.users WHERE status = 'active' AND huis.is_internal_role(role) ORDER BY full_name")).rows
        .map((r) => ({ id: r.id, name: r.full_name }))
    : [];
  return {
    time, expenses, canInvoice, isManager: isManager(s), timekeepers,
    unbilled: {
      timeCents: time.filter(open).reduce((a, x) => a + x.amountCents, 0),
      expenseCents: expenses.filter(open).reduce((a, x) => a + x.amountCents, 0),
      minutes: time.filter(open).reduce((a, x) => a + x.minutes, 0),
      missingRates: time.filter((x) => open(x) && x.rateCents === null).length,
    },
    invoices: await listInvoices(s, matterId),
  };
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------
export interface InvoiceSummary {
  id: string; matterId: string; matterTitle: string; clientName: string; number: string | null; status: "draft" | "issued" | "paid" | "void";
  issuedOn: string | null; dueOn: string | null; totalCents: number | null; paidCents: number; overdue: boolean;
}
export interface InvoiceLine { position: number; kind: "time" | "expense"; date: string; who: string; description: string; tenths: number | null; rateCents: number | null; amountCents: number }
export interface Invoice extends InvoiceSummary {
  notes: string; timeCents: number | null; expenseCents: number | null;
  lines: InvoiceLine[];
  /** For a draft: what it holds now (not yet copied into lines). */
  draft: { time: TimeEntry[]; expenses: Expense[]; timeCents: number; expenseCents: number } | null;
  payments: { amountCents: number; receivedOn: string; method: (typeof PAYMENT_METHODS)[number]; reference: string }[];
  canInvoice: boolean;
  firmName: string;
  matterNumber: string;
}

const SUMMARY = `SELECT i.id, i.matter_id, m.title AS matter_title, c.display_name AS client_name, i.number, i.status,
    i.issued_on::text AS issued_on, i.due_on::text AS due_on, i.total_cents, i.notes, i.time_cents, i.expense_cents,
    coalesce((SELECT sum(p.amount_cents) FROM huis.invoice_payments p WHERE p.invoice_id = i.id), 0) AS paid_cents
  FROM huis.invoices i JOIN huis.matters m ON m.id = i.matter_id LEFT JOIN huis.clients c ON c.id = i.client_id`;

function summary(r: Record<string, any>): InvoiceSummary {
  const total = cents(r.total_cents);
  const paid = Number(r.paid_cents);
  return {
    id: r.id, matterId: r.matter_id, matterTitle: r.matter_title, clientName: r.client_name ?? "", number: r.number, status: r.status,
    issuedOn: r.issued_on, dueOn: r.due_on, totalCents: total, paidCents: paid,
    overdue: r.status === "issued" && !!r.due_on && r.due_on < new Date().toISOString().slice(0, 10),
  };
}

/** Invoices on a Matter (firm staff), or the firm's open invoices across the Matters the person can see. */
export async function listInvoices(s: FirmSession, matterId?: string): Promise<InvoiceSummary[]> {
  if (matterId) {
    const { rows } = await s.client.query(`${SUMMARY} WHERE i.matter_id = $1 ORDER BY i.created_at DESC`, [matterId]);
    return rows.map(summary);
  }
  staff(s);
  const { rows } = await s.client.query(`${SUMMARY} WHERE i.status IN ('draft', 'issued') ORDER BY i.due_on NULLS FIRST, i.created_at DESC LIMIT 500`);
  return rows.map(summary);
}

/** A draft invoice holding the Matter's unbilled billable time and expenses (up to a date, if given). */
export async function createDraftInvoice(s: FirmSession, matterId: string, throughDate?: string | null): Promise<string> {
  staff(s);
  await getMatter(s, matterId);
  const through = throughDate ? day.parse(throughDate) : null;
  const id = (await s.client.query<{ id: string }>(
    "INSERT INTO huis.invoices (firm_id, matter_id, client_id) VALUES ($1, $2, (SELECT client_id FROM huis.matters WHERE id = $2)) RETURNING id",
    [s.actor.firmId, matterId])).rows[0]!.id;
  const t = await s.client.query(
    `UPDATE huis.time_entries SET invoice_id = $1 WHERE matter_id = $2 AND invoice_id IS NULL AND billable AND ($3::date IS NULL OR work_date <= $3::date)`,
    [id, matterId, through]);
  const e = await s.client.query(
    `UPDATE huis.expenses SET invoice_id = $1 WHERE matter_id = $2 AND invoice_id IS NULL AND billable AND ($3::date IS NULL OR incurred_on <= $3::date)`,
    [id, matterId, through]);
  if ((t.rowCount ?? 0) + (e.rowCount ?? 0) === 0) throw new UserFacingError("There's no unbilled time or expense to put on an invoice.");
  await recordAudit(s, "billing.invoice_drafted", { targetType: "invoice", targetId: id, matterId, metadata: { time: t.rowCount, expenses: e.rowCount } });
  return id;
}

export async function getInvoice(s: FirmSession, invoiceId: string): Promise<Invoice> {
  if (!uuid.safeParse(invoiceId).success) throw new NotFoundError("Invoice");
  const r = (await s.client.query(`${SUMMARY} WHERE i.id = $1`, [invoiceId])).rows[0];
  if (!r) throw new NotFoundError("Invoice");
  const m = (await s.client.query<{ huis_number: string }>("SELECT huis_number FROM huis.matters WHERE id = $1", [r.matter_id])).rows[0];
  const firm = (await s.client.query<{ name: string }>("SELECT name FROM huis.firms")).rows[0];
  const lines = (await s.client.query(
    "SELECT position, kind, line_date::text AS d, who, description, tenths, rate_cents, amount_cents FROM huis.invoice_lines WHERE invoice_id = $1 ORDER BY position",
    [invoiceId])).rows.map((l) => ({
      position: l.position, kind: l.kind, date: l.d, who: l.who, description: l.description, tenths: l.tenths,
      rateCents: cents(l.rate_cents), amountCents: Number(l.amount_cents),
    }));
  const payments = (await s.client.query(
    "SELECT amount_cents, received_on::text AS d, method, reference FROM huis.invoice_payments WHERE invoice_id = $1 ORDER BY received_on, recorded_at",
    [invoiceId])).rows.map((p) => ({ amountCents: Number(p.amount_cents), receivedOn: p.d, method: p.method, reference: p.reference }));
  let draft: Invoice["draft"] = null;
  if (r.status === "draft") {
    const all = await matterBilling(s, r.matter_id);
    const time = all.time.filter((x) => x.invoiceId === invoiceId);
    const expenses = all.expenses.filter((x) => x.invoiceId === invoiceId);
    draft = { time, expenses, timeCents: time.reduce((a, x) => a + x.amountCents, 0), expenseCents: expenses.reduce((a, x) => a + (x.billable ? x.amountCents : 0), 0) };
  }
  const canInvoice = INTERNAL_ROLES.has(s.actor.role)
    && ((await s.client.query<{ ok: boolean }>("SELECT huis.can_invoice_matter($1) AS ok", [r.matter_id])).rows[0]?.ok ?? false);
  return {
    ...summary(r), notes: r.notes, timeCents: cents(r.time_cents), expenseCents: cents(r.expense_cents), lines, draft, payments,
    canInvoice, firmName: firm?.name ?? "", matterNumber: m?.huis_number ?? "",
  };
}

export async function updateDraftNotes(s: FirmSession, invoiceId: string, notes: unknown): Promise<void> {
  staff(s);
  const v = z.string().max(2000).parse(notes ?? "");
  const r = await s.client.query("UPDATE huis.invoices SET notes = $2 WHERE id = $1 AND status = 'draft'", [invoiceId, v]);
  if (!r.rowCount) throw new NotFoundError("Draft invoice");
}

/** Takes an item off a draft invoice (back to unbilled). */
export async function removeFromDraft(s: FirmSession, kind: "time" | "expense", itemId: string): Promise<void> {
  staff(s);
  if (!uuid.safeParse(itemId).success) throw new NotFoundError("Item");
  const table = kind === "time" ? "huis.time_entries" : "huis.expenses";
  const r = await s.client.query(
    `UPDATE ${table} x SET invoice_id = NULL WHERE x.id = $1 AND x.invoice_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM huis.invoices i WHERE i.id = x.invoice_id AND i.status = 'draft' AND huis.can_invoice_matter(i.matter_id))`, [itemId]);
  if (!r.rowCount) throw new NotFoundError("Item on a draft invoice");
}

export async function deleteDraftInvoice(s: FirmSession, invoiceId: string): Promise<string> {
  staff(s);
  if (!uuid.safeParse(invoiceId).success) throw new NotFoundError("Invoice");
  const r = (await s.client.query<{ matter_id: string }>("DELETE FROM huis.invoices WHERE id = $1 AND status = 'draft' RETURNING matter_id", [invoiceId])).rows[0];
  if (!r) throw new NotFoundError("Draft invoice");
  await recordAudit(s, "billing.invoice_draft_deleted", { targetType: "invoice", targetId: invoiceId, matterId: r.matter_id });
  return r.matter_id;
}

export const IssueInput = z.object({ issuedOn: day, dueOn: day });

export async function issueInvoice(s: FirmSession, invoiceId: string, input: unknown): Promise<string> {
  staff(s);
  if (!uuid.safeParse(invoiceId).success) throw new NotFoundError("Invoice");
  const v = IssueInput.parse(input);
  const number = (await s.client.query<{ n: string }>("SELECT huis.issue_invoice($1, $2, $3) AS n", [invoiceId, v.issuedOn, v.dueOn])).rows[0]!.n;
  const i = (await s.client.query<{ matter_id: string; total_cents: string }>("SELECT matter_id, total_cents FROM huis.invoices WHERE id = $1", [invoiceId])).rows[0]!;
  await recordAudit(s, "billing.invoice_issued", { targetType: "invoice", targetId: invoiceId, matterId: i.matter_id, metadata: { number, total_cents: Number(i.total_cents) } });
  return number;
}

export async function voidInvoice(s: FirmSession, invoiceId: string): Promise<void> {
  staff(s);
  if (!uuid.safeParse(invoiceId).success) throw new NotFoundError("Invoice");
  await s.client.query("SELECT huis.void_invoice($1)", [invoiceId]);
  const i = (await s.client.query<{ matter_id: string; number: string }>("SELECT matter_id, number FROM huis.invoices WHERE id = $1", [invoiceId])).rows[0]!;
  await recordAudit(s, "billing.invoice_voided", { targetType: "invoice", targetId: invoiceId, matterId: i.matter_id, metadata: { number: i.number } });
}

export const PaymentInput = z.object({
  amount: dollars.refine((c) => c >= 1, "Use an amount above zero"), receivedOn: day,
  method: z.enum(PAYMENT_METHODS), reference: z.string().trim().max(100).default(""),
});

export async function recordPayment(s: FirmSession, invoiceId: string, input: unknown): Promise<"paid" | "issued"> {
  staff(s);
  if (!uuid.safeParse(invoiceId).success) throw new NotFoundError("Invoice");
  const v = PaymentInput.parse(input);
  const status = (await s.client.query<{ s: "paid" | "issued" }>("SELECT huis.record_invoice_payment($1, $2, $3, $4, $5) AS s",
    [invoiceId, v.amount, v.receivedOn, v.method, v.reference])).rows[0]!.s;
  const i = (await s.client.query<{ matter_id: string; number: string }>("SELECT matter_id, number FROM huis.invoices WHERE id = $1", [invoiceId])).rows[0]!;
  await recordAudit(s, "billing.payment_recorded", { targetType: "invoice", targetId: invoiceId, matterId: i.matter_id, metadata: { number: i.number, amount_cents: v.amount, method: v.method } });
  return status;
}

/** The firm's billing at a glance, across the Matters the person can see (walls applied). */
export async function billingOverview(s: FirmSession) {
  staff(s);
  const unbilled = (await s.client.query(
    `SELECT m.id, m.title,
            coalesce((SELECT sum(huis.time_amount(t.minutes, t.rate_cents)) FROM huis.time_entries t WHERE t.matter_id = m.id AND t.invoice_id IS NULL AND t.billable), 0) AS time_cents,
            coalesce((SELECT sum(e.amount_cents) FROM huis.expenses e WHERE e.matter_id = m.id AND e.invoice_id IS NULL AND e.billable), 0) AS expense_cents
       FROM huis.matters m WHERE huis.dna_readable(m.id)`)).rows
    .map((r) => ({ matterId: r.id, title: r.title, cents: Number(r.time_cents) + Number(r.expense_cents) }))
    .filter((r) => r.cents > 0).sort((a, b) => b.cents - a.cents);
  const invoices = await listInvoices(s);
  const outstanding = invoices.filter((i) => i.status === "issued");
  return {
    unbilled,
    unbilledCents: unbilled.reduce((a, r) => a + r.cents, 0),
    drafts: invoices.filter((i) => i.status === "draft"),
    outstanding,
    outstandingCents: outstanding.reduce((a, i) => a + (i.totalCents ?? 0) - i.paidCents, 0),
    overdueCents: outstanding.filter((i) => i.overdue).reduce((a, i) => a + (i.totalCents ?? 0) - i.paidCents, 0),
  };
}
