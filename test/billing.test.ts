import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { NotFoundError, PermissionDeniedError } from "../src/errors";
import {
  addExpense, addTime, billingOverview, createDraftInvoice, deleteDraftInvoice, deleteTime, duration, getInvoice, issueInvoice,
  listRates, matterBilling, recordPayment, removeFromDraft, setRate, timeAmount, voidInvoice,
} from "../src/services/billing";
import { createClient } from "../src/services/clients";
import { addMatterMember, createMatter } from "../src/services/matters";
import { inviteUser } from "../src/services/users";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

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
    const reader = await inviteUser(s, { email: `r@${f.slug}.example`, fullName: "Rae Reader", role: "read_only", locationId: f.locationId });
    const portal = await inviteUser(s, { email: `c@${f.slug}.example`, fullName: "Casey Client", role: "client", locationId: f.locationId });
    const matter = await createMatter(s, { title: "Smith v. Acme", clientId: client.id, leadAttorneyId: attorney.id, jurisdictionState: "UT" });
    const walled = await createMatter(s, { title: "Walled", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT", restricted: true });
    return { client, attorney, para, billing, reader, portal, matter, walled };
  });
  await db.withFirm(f.owner, (s) => addMatterMember(s, { matterId: x.matter.id, userId: x.portal.id, access: "view", acknowledgePrivilegeWaiverRisk: true }));
  const ctx = (id: string): RequestContext => ({ firmId: f.firmId, userId: id });
  return { ...f, ...x, attCtx: ctx(x.attorney.id), paraCtx: ctx(x.para.id), billCtx: ctx(x.billing.id), readerCtx: ctx(x.reader.id), portalCtx: ctx(x.portal.id) };
}

describe("time, rates and expenses", () => {
  it("bills in tenths of an hour, rounded up, at the rate in force that day (the Matter's own rate first)", async () => {
    expect(duration.parse("1:30")).toBe(90);
    expect(duration.parse("0.25")).toBe(15);
    expect(() => duration.parse("25")).toThrow();
    expect(timeAmount(7, 30000)).toBe(6000); // 7 minutes = 0.2 h
    expect(timeAmount(60, 30000)).toBe(30000);

    const x = await setup();
    await db.withFirm(x.billCtx, async (s) => {
      await setRate(s, { userId: x.para.id, rate: "150", effectiveFrom: "2026-01-01" });
      await setRate(s, { userId: x.para.id, rate: "175", effectiveFrom: daysFromNow(10) });
      await setRate(s, { userId: x.attorney.id, rate: "300", effectiveFrom: "2026-01-01" });
      await setRate(s, { userId: x.attorney.id, matterId: x.matter.id, rate: "250.00", effectiveFrom: "2026-01-01" });
    });
    await db.withFirm(x.paraCtx, (s) => addTime(s, x.matter.id, { workDate: today(), duration: "0:07", description: "Calendar the hearing" }));
    await db.withFirm(x.attCtx, (s) => addTime(s, x.matter.id, { workDate: today(), duration: "1.5", description: "Draft the complaint" }));
    const b = await db.withFirm(x.attCtx, (s) => matterBilling(s, x.matter.id));
    const para = b.time.find((e) => e.userName === "Pat Para")!;
    const att = b.time.find((e) => e.userName === "Avery Attorney")!;
    expect(para.rateCents).toBe(15000);
    expect(para.amountCents).toBe(3000);
    expect(att.rateCents).toBe(25000); // the Matter's own rate beats the standard one
    expect(att.amountCents).toBe(37500);
    expect(b.unbilled.timeCents).toBe(40500);
  });

  it("timekeepers can't set their own rate or record time for others; billing staff can", async () => {
    const x = await setup();
    await db.withFirm(x.billCtx, (s) => setRate(s, { userId: x.para.id, rate: "150", effectiveFrom: "2026-01-01" }));
    await db.withFirm(x.paraCtx, (s) => addTime(s, x.matter.id, { workDate: today(), duration: "1", description: "x", rate: "999", userId: x.attorney.id }));
    const e = (await db.withFirm(x.paraCtx, (s) => matterBilling(s, x.matter.id))).time[0]!;
    expect(e.userId).toBe(x.para.id);
    expect(e.rateCents).toBe(15000);
    // Directly in the database too.
    await db.withFirm(x.paraCtx, (s) => s.client.query("UPDATE huis.time_entries SET rate_cents = 99900 WHERE id = $1", [e.id]));
    expect((await t.admin.query("SELECT rate_cents FROM huis.time_entries WHERE id = $1", [e.id])).rows[0].rate_cents).toBe(15000);
    await expect(db.withFirm(x.paraCtx, (s) => s.client.query(
      "INSERT INTO huis.time_entries (firm_id, matter_id, user_id, work_date, minutes, description) VALUES ($1, $2, $3, current_date, 60, 'x')",
      [x.firmId, x.matter.id, x.attorney.id]))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(db.withFirm(x.paraCtx, (s) => setRate(s, { userId: x.para.id, rate: "500", effectiveFrom: "2026-01-01" }))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect((await db.withFirm(x.paraCtx, (s) => listRates(s))).every((r) => r.userId === x.para.id)).toBe(true);
    // Billing staff record time for someone else at a set rate.
    await db.withFirm(x.billCtx, (s) => addTime(s, x.matter.id, { workDate: today(), duration: "2", description: "y", rate: "200", userId: x.attorney.id }));
    const set = (await db.withFirm(x.billCtx, (s) => matterBilling(s, x.matter.id))).time.find((t) => t.userId === x.attorney.id)!;
    expect(set.rateCents).toBe(20000);
  });

  it("clients, read-only staff, walls and other firms are kept out", async () => {
    const x = await setup();
    await db.withFirm(x.paraCtx, (s) => addTime(s, x.matter.id, { workDate: today(), duration: "1", description: "Privileged strategy note" }));
    await expect(db.withFirm(x.portalCtx, (s) => matterBilling(s, x.matter.id))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect((await db.withFirm(x.portalCtx, (s) => s.client.query("SELECT id FROM huis.time_entries"))).rows).toHaveLength(0);
    await expect(db.withFirm(x.readerCtx, (s) => addTime(s, x.matter.id, { workDate: today(), duration: "1", description: "x" }))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect((await db.withFirm(x.readerCtx, (s) => matterBilling(s, x.matter.id))).time).toHaveLength(1);
    await expect(db.withFirm(x.paraCtx, (s) => addTime(s, x.walled.id, { workDate: today(), duration: "1", description: "x" }))).rejects.toBeInstanceOf(NotFoundError);
    const other = await newFirm(db);
    expect((await db.withFirm(other.owner, (s) => s.client.query("SELECT id FROM huis.time_entries"))).rows).toHaveLength(0);
    // A DELETE with no WHERE clause reaches only what the person may change.
    await db.withFirm(x.attCtx, (s) => addTime(s, x.matter.id, { workDate: today(), duration: "1", description: "mine" }));
    await db.withFirm(x.paraCtx, (s) => s.client.query("DELETE FROM huis.time_entries"));
    expect((await db.withFirm(x.attCtx, (s) => matterBilling(s, x.matter.id))).time.map((e) => e.description)).toEqual(["mine"]);
  });
});

describe("invoices", () => {
  async function billed() {
    const x = await setup();
    await db.withFirm(x.billCtx, (s) => setRate(s, { userId: x.attorney.id, rate: "300", effectiveFrom: "2026-01-01" }));
    await db.withFirm(x.attCtx, async (s) => {
      await addTime(s, x.matter.id, { workDate: today(), duration: "2", description: "Deposition prep" });
      await addTime(s, x.matter.id, { workDate: today(), duration: "0.5", description: "Internal only", billable: false });
      await addExpense(s, x.matter.id, { incurredOn: today(), description: "Filing fee", amount: "$375.00" });
    });
    return x;
  }

  it("a draft holds unbilled items; issuing numbers it, copies its lines and locks its items; clients see it once issued", async () => {
    const x = await billed();
    const id = await db.withFirm(x.attCtx, (s) => createDraftInvoice(s, x.matter.id));
    const draft = await db.withFirm(x.attCtx, (s) => getInvoice(s, id));
    expect(draft.status).toBe("draft");
    expect(draft.draft!.timeCents).toBe(60000);
    expect(draft.draft!.expenseCents).toBe(37500);
    expect(draft.draft!.time).toHaveLength(1); // not the non-billable time
    // Clients never see drafts.
    await expect(db.withFirm(x.portalCtx, (s) => getInvoice(s, id))).rejects.toBeInstanceOf(NotFoundError);

    const n1 = await db.withFirm(x.attCtx, (s) => issueInvoice(s, id, { issuedOn: today(), dueOn: daysFromNow(30) }));
    expect(n1).toMatch(new RegExp(`^INV-${new Date().getFullYear()}-0001$`));
    const issued = await db.withFirm(x.portalCtx, (s) => getInvoice(s, id));
    expect(issued.totalCents).toBe(97500);
    expect(issued.lines.map((l) => [l.kind, l.description, l.tenths, l.amountCents])).toEqual([
      ["time", "Deposition prep", 20, 60000], ["expense", "Filing fee", null, 37500],
    ]);
    // Locked: the time can't be changed, deleted, or taken off; the invoice can't be edited.
    const entry = (await db.withFirm(x.attCtx, (s) => matterBilling(s, x.matter.id))).time.find((e) => e.description === "Deposition prep")!;
    await expect(db.withFirm(x.attCtx, (s) => deleteTime(s, entry.id))).rejects.toThrow(/issued invoice/);
    await expect(db.withFirm(x.attCtx, (s) => s.client.query("UPDATE huis.time_entries SET minutes = 600 WHERE id = $1", [entry.id]))).rejects.toThrow(/issued invoice/);
    await expect(db.withFirm(x.billCtx, (s) => s.client.query("UPDATE huis.invoices SET notes = 'x' WHERE id = $1", [id]))).rejects.toThrow(/can't be changed/);
    await expect(db.withFirm(x.billCtx, (s) => s.client.query("UPDATE huis.invoices SET status = 'paid' WHERE id = $1", [id]))).rejects.toThrow();
    await expect(db.withFirm(x.billCtx, (s) => s.client.query("DELETE FROM huis.invoices WHERE id = $1", [id]))).resolves.toMatchObject({ rowCount: 0 });
    // Clients see invoices, not time sheets, and can't act on them.
    await expect(db.withFirm(x.portalCtx, (s) => recordPayment(s, id, { amount: "10", receivedOn: today(), method: "check" }))).rejects.toBeInstanceOf(PermissionDeniedError);
    // The next one gets the next number.
    await db.withFirm(x.attCtx, (s) => addTime(s, x.matter.id, { workDate: today(), duration: "1", description: "More work" }));
    const id2 = await db.withFirm(x.billCtx, (s) => createDraftInvoice(s, x.matter.id));
    expect(await db.withFirm(x.billCtx, (s) => issueInvoice(s, id2, { issuedOn: today(), dueOn: today() }))).toMatch(/-0002$/);
  });

  it("payments mark it paid when it's paid in full, never more than owed; voiding returns the items to unbilled", async () => {
    const x = await billed();
    const id = await db.withFirm(x.billCtx, (s) => createDraftInvoice(s, x.matter.id));
    await db.withFirm(x.billCtx, (s) => issueInvoice(s, id, { issuedOn: today(), dueOn: daysFromNow(30) }));
    expect(await db.withFirm(x.billCtx, (s) => recordPayment(s, id, { amount: "500", receivedOn: today(), method: "check", reference: "1042" }))).toBe("issued");
    await expect(db.withFirm(x.billCtx, (s) => recordPayment(s, id, { amount: "500", receivedOn: today(), method: "card" }))).rejects.toThrow(/more than what's still owed/);
    await expect(db.withFirm(x.billCtx, (s) => voidInvoice(s, id))).rejects.toThrow(/payments recorded/);
    expect(await db.withFirm(x.billCtx, (s) => recordPayment(s, id, { amount: "475", receivedOn: today(), method: "ach" }))).toBe("paid");
    expect((await db.withFirm(x.portalCtx, (s) => getInvoice(s, id))).paidCents).toBe(97500);

    // Void (no payments): kept, marked void; items back to unbilled.
    await db.withFirm(x.attCtx, (s) => addTime(s, x.matter.id, { workDate: today(), duration: "1", description: "After" }));
    const id2 = await db.withFirm(x.billCtx, (s) => createDraftInvoice(s, x.matter.id));
    await db.withFirm(x.billCtx, (s) => issueInvoice(s, id2, { issuedOn: today(), dueOn: daysFromNow(30) }));
    await db.withFirm(x.billCtx, (s) => voidInvoice(s, id2));
    const v = await db.withFirm(x.billCtx, (s) => getInvoice(s, id2));
    expect(v.status).toBe("void");
    expect(v.lines).toHaveLength(1);
    expect((await db.withFirm(x.billCtx, (s) => matterBilling(s, x.matter.id))).unbilled.timeCents).toBe(30000);
  });

  it("drafts can lose items or be deleted; only billing staff and the lead attorney prepare invoices", async () => {
    const x = await billed();
    await expect(db.withFirm(x.paraCtx, (s) => createDraftInvoice(s, x.matter.id))).rejects.toBeInstanceOf(PermissionDeniedError);
    const id = await db.withFirm(x.attCtx, (s) => createDraftInvoice(s, x.matter.id));
    const d = await db.withFirm(x.attCtx, (s) => getInvoice(s, id));
    await db.withFirm(x.attCtx, (s) => removeFromDraft(s, "expense", d.draft!.expenses[0]!.id));
    expect((await db.withFirm(x.attCtx, (s) => getInvoice(s, id))).draft!.expenseCents).toBe(0);
    await expect(db.withFirm(x.paraCtx, (s) => issueInvoice(s, id, { issuedOn: today(), dueOn: today() }))).rejects.toBeInstanceOf(PermissionDeniedError);
    await db.withFirm(x.attCtx, (s) => deleteDraftInvoice(s, id));
    const b = await db.withFirm(x.attCtx, (s) => matterBilling(s, x.matter.id));
    expect(b.invoices).toHaveLength(0);
    expect(b.unbilled).toMatchObject({ timeCents: 60000, expenseCents: 37500 });
    await expect(db.withFirm(x.attCtx, (s) => createDraftInvoice(s, x.walled.id))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("the firm's overview: unbilled, drafts and money owed, overdue included", async () => {
    const x = await billed();
    const id = await db.withFirm(x.billCtx, (s) => createDraftInvoice(s, x.matter.id));
    await db.withFirm(x.billCtx, (s) => issueInvoice(s, id, { issuedOn: daysFromNow(-40), dueOn: daysFromNow(-10) }));
    await db.withFirm(x.attCtx, (s) => addTime(s, x.matter.id, { workDate: today(), duration: "1", description: "Unbilled" }));
    const o = await db.withFirm(x.billCtx, (s) => billingOverview(s));
    expect(o.unbilledCents).toBe(30000);
    expect(o.outstandingCents).toBe(97500);
    expect(o.overdueCents).toBe(97500);
    const audit = (await t.admin.query("SELECT action, metadata FROM huis.audit_events WHERE firm_id = $1 AND action LIKE 'billing.%'", [x.firmId])).rows;
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["billing.time_added", "billing.invoice_issued", "billing.rate_set"]));
    expect(JSON.stringify(audit)).not.toMatch(/Deposition prep|Filing fee/);
  });
});
