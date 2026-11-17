import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { addTime, createDraftInvoice, issueInvoice, matterBilling, setRate } from "../src/services/billing";
import { createClient } from "../src/services/clients";
import { createMatter } from "../src/services/matters";
import { inviteUser } from "../src/services/users";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

// Security review 25 (Phase 10.3 firm billing). Each test asserts the CORRECT behaviour and fails on the
// code as reviewed.

let t: TestDatabase;
let db: HuisDb;
beforeAll(async () => { t = await createTestDatabase(); db = t.db; });
afterAll(async () => { await t?.drop(); });

const today = () => new Date().toISOString().slice(0, 10);
const daysFromNow = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function setup() {
  const f = await newFirm(db);
  const x = await db.withFirm(f.owner, async (s) => {
    const client = await createClient(s, { kind: "person", displayName: "Pat Smith" });
    const attorney = await inviteUser(s, { email: `a@${f.slug}.example`, fullName: "Avery Attorney", role: "attorney", locationId: f.locationId });
    const para = await inviteUser(s, { email: `p@${f.slug}.example`, fullName: "Pat Para", role: "paralegal", locationId: f.locationId });
    const billing = await inviteUser(s, { email: `b@${f.slug}.example`, fullName: "Bo Billing", role: "billing_admin", locationId: f.locationId });
    const matter = await createMatter(s, { title: "Smith v. Acme", clientId: client.id, leadAttorneyId: attorney.id, jurisdictionState: "UT" });
    return { attorney, para, billing, matter };
  });
  const ctx = (id: string): RequestContext => ({ firmId: f.firmId, userId: id });
  await db.withFirm(ctx(x.billing.id), async (s) => {
    await setRate(s, { userId: x.para.id, rate: "150", effectiveFrom: "2026-01-01" });
    await setRate(s, { userId: x.attorney.id, rate: "300", effectiveFrom: "2026-01-01" });
  });
  return { ...f, ...x, attCtx: ctx(x.attorney.id), paraCtx: ctx(x.para.id), billCtx: ctx(x.billing.id) };
}

describe("R25-1: an item can leave a draft while it is being issued (billed on the invoice AND unbilled)", () => {
  it("an item changed concurrently with issue_invoice stays consistent with the issued lines", async () => {
    const x = await setup();
    const entryId = await db.withFirm(x.paraCtx, (s) => addTime(s, x.matter.id, { workDate: today(), duration: "1", description: "Research memo" }));
    const invoiceId = await db.withFirm(x.attCtx, (s) => createDraftInvoice(s, x.matter.id));

    // The timekeeper takes their own time off the draft (allowed by time_entries_update + the guard) and the
    // transaction is still open when the lead attorney issues the invoice.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let updated!: () => void;
    const didUpdate = new Promise<void>((r) => { updated = r; });
    // (After R25-6 only an invoicer can take time off a draft: here the lead attorney holds that change open
    // while billing staff issue the invoice. The issue must wait for it, then see the item gone.)
    const t1 = db.withFirm(x.attCtx, async (s) => {
      await s.client.query("UPDATE huis.time_entries SET invoice_id = NULL WHERE id = $1", [entryId]);
      updated();
      await gate;
    });
    await didUpdate;
    const issuing = db.withFirm(x.billCtx, (s) => issueInvoice(s, invoiceId, { issuedOn: today(), dueOn: daysFromNow(30) }));
    await new Promise((r) => setTimeout(r, 300)); // the issue is now waiting on the item
    release();
    await t1;
    // With its only item gone, there's nothing billable left to issue.
    await expect(issuing).rejects.toThrow(/nothing billable/);

    const lines = (await t.admin.query("SELECT description FROM huis.invoice_lines WHERE invoice_id = $1", [invoiceId])).rows;
    const entry = (await t.admin.query("SELECT invoice_id FROM huis.time_entries WHERE id = $1", [entryId])).rows[0];
    const onIssuedLines = lines.some((l) => l.description === "Research memo");
    const stillAttached = entry.invoice_id === invoiceId;
    // Billed once: either it's on the invoice and locked to it, or it's on neither.
    expect({ onIssuedLines, stillAttached }).toEqual({ onIssuedLines: stillAttached, stillAttached });
  });
});

describe("R25-2: a timekeeper undoes a billing manager's rate override (write-down) on their own time", () => {
  it("keeps the billing manager's rate when the timekeeper touches rate_cents", async () => {
    const x = await setup();
    const entryId = await db.withFirm(x.paraCtx, (s) => addTime(s, x.matter.id, { workDate: today(), duration: "2", description: "Doc review" }));
    // Billing staff write the entry down to $0/h (the documented override).
    await db.withFirm(x.billCtx, (s) => s.client.query("UPDATE huis.time_entries SET rate_cents = 0 WHERE id = $1", [entryId]));
    // The paralegal "sets" any rate: the guard re-reads the rate table and puts the full $150 back.
    await db.withFirm(x.paraCtx, (s) => s.client.query("UPDATE huis.time_entries SET rate_cents = 1 WHERE id = $1", [entryId]));
    expect((await t.admin.query("SELECT rate_cents FROM huis.time_entries WHERE id = $1", [entryId])).rows[0].rate_cents).toBe(0);
    await db.withFirm(x.paraCtx, (s) => s.client.query("UPDATE huis.time_entries SET work_date = work_date - 1 WHERE id = $1", [entryId]));
    expect((await t.admin.query("SELECT rate_cents FROM huis.time_entries WHERE id = $1", [entryId])).rows[0].rate_cents).toBe(0);
  });
});

describe("R25-3: the lead attorney (not billing staff) editing a colleague's time wipes its rate", () => {
  it("changing the date of someone else's entry keeps a real rate", async () => {
    const x = await setup();
    const entryId = await db.withFirm(x.paraCtx, (s) => addTime(s, x.matter.id, { workDate: today(), duration: "1", description: "Calendar hearing" }));
    // rate_for() only returns the caller's own rate unless they're billing staff, so this becomes NULL ($0).
    await db.withFirm(x.attCtx, (s) => s.client.query("UPDATE huis.time_entries SET work_date = work_date - 1 WHERE id = $1", [entryId]));
    const r = await t.admin.query("SELECT rate_cents FROM huis.time_entries WHERE id = $1", [entryId]);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0]!.rate_cents).toBe(15000);
  });
});

describe("R25-4: a draft whose items are all non-billable is issued as a numbered $0 invoice with no lines", () => {
  it("refuses to issue an invoice with nothing billable on it", async () => {
    const x = await setup();
    const entryId = await db.withFirm(x.attCtx, (s) => addTime(s, x.matter.id, { workDate: today(), duration: "1", description: "Strategy" }));
    const invoiceId = await db.withFirm(x.attCtx, (s) => createDraftInvoice(s, x.matter.id));
    await db.withFirm(x.attCtx, (s) => s.client.query("UPDATE huis.time_entries SET billable = false WHERE id = $1", [entryId]));
    await expect(db.withFirm(x.attCtx, (s) => issueInvoice(s, invoiceId, { issuedOn: today(), dueOn: daysFromNow(30) }))).rejects.toThrow();
  });
});

describe("R25-5: other people's rates are readable through time_entries.rate_cents", () => {
  it("a paralegal can't read the attorney's rate", async () => {
    const x = await setup();
    await db.withFirm(x.attCtx, (s) => addTime(s, x.matter.id, { workDate: today(), duration: "1", description: "Draft complaint" }));
    // billing_rates hides it and rate_for() refuses it...
    const viaRates = await db.withFirm(x.paraCtx, (s) => s.client.query("SELECT huis.rate_for($1, $2, $3, current_date) AS r", [x.firmId, x.attorney.id, x.matter.id]));
    expect(viaRates.rows[0].r).toBeNull();
    // ...but the snapshot on the time entry (and matterBilling / the Matter billing page) shows it.
    // The rate column isn't readable by the app at all; rates come through time_entry_rates(), which leaves others' out.
    await expect(db.withFirm(x.paraCtx, (s) => s.client.query("SELECT rate_cents FROM huis.time_entries WHERE user_id = $1", [x.attorney.id]))).rejects.toThrow(/permission/i);
    const b = await db.withFirm(x.paraCtx, (s) => matterBilling(s, x.matter.id));
    const theirs = b.time.find((e) => e.userId === x.attorney.id)!;
    expect(theirs).toMatchObject({ rateCents: null, rateHidden: true, amountCents: null });
    // The lead attorney (who invoices the Matter) sees it.
    const lead = (await db.withFirm(x.attCtx, (s) => matterBilling(s, x.matter.id))).time.find((e) => e.userId === x.attorney.id)!;
    expect(lead.rateHidden).toBe(false);
  });
});

describe("R25-6: a timekeeper who can't invoice the Matter moves items on and off its drafts", () => {
  it("only those who can invoice the Matter change what a draft holds", async () => {
    const x = await setup();
    const entryId = await db.withFirm(x.paraCtx, (s) => addTime(s, x.matter.id, { workDate: today(), duration: "3", description: "Privilege log" }));
    const invoiceId = await db.withFirm(x.attCtx, (s) => createDraftInvoice(s, x.matter.id));
    await expect(db.withFirm(x.paraCtx, (s) => s.client.query("UPDATE huis.time_entries SET invoice_id = NULL WHERE id = $1", [entryId]))).rejects.toThrow();
    const late = await db.withFirm(x.paraCtx, (s) => addTime(s, x.matter.id, { workDate: today(), duration: "1", description: "Late add" }));
    await expect(db.withFirm(x.paraCtx, (s) => s.client.query("UPDATE huis.time_entries SET invoice_id = $2 WHERE id = $1", [late, invoiceId]))).rejects.toThrow();
  });
});
