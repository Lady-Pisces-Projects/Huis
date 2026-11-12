import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseStaff, staffMember } from "../src/admin/staff";
import { UserFacingError } from "../src/errors";
import { getFirm, listFirms, setAgreement, setStatus, setTrialEnd } from "../src/services/admin";
import { createClient } from "../src/services/clients";
import { createMatter } from "../src/services/matters";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });

const DAY = 86_400_000;
async function firmWithMatter() {
  const f = await newFirm(t.db);
  await t.db.withFirm(f.owner, async (s) => {
    const c = await createClient(s, { kind: "person", displayName: "Confidential Client Name" });
    await createMatter(s, { title: "Privileged Matter Title", clientId: c.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
  });
  return f;
}

describe("who is Huis staff", () => {
  it("reads HUIS_STAFF by sign-in identity, never by email", () => {
    const v = "google:109876543210987654321=Tracy Peart, microsoft:6e13c098-b656-43cc-97b7-8a0000000000:11111111-2222-3333-4444-555555555555=Jordan Lee, tracy@huislaw.ai=Nope, google:abc=Bad";
    expect(parseStaff(v)).toEqual([
      { key: "google:109876543210987654321", name: "Tracy Peart" },
      { key: "microsoft:6e13c098-b656-43cc-97b7-8a0000000000:11111111-2222-3333-4444-555555555555", name: "Jordan Lee" },
    ]);
    expect(staffMember("google", "109876543210987654321", v)?.name).toBe("Tracy Peart");
    expect(staffMember("google", "109876543210987654322", v)).toBeNull();
    expect(staffMember("microsoft", "109876543210987654321", v)).toBeNull();
    expect(staffMember("google", "109876543210987654321", undefined)).toBeNull();
  });
});

describe("what Huis staff can see: accounts, never client content", () => {
  it("lists firms with account fields and counts", async () => {
    const f = await firmWithMatter();
    const firms = await listFirms(t.platform, "");
    const row = firms.find((x) => x.firmId === f.firmId)!;
    expect(row).toMatchObject({ plan: "trial", status: "active", matters: 1, seatsUsed: 1 });
    expect(row.ownerEmail).toContain("@");
    expect(JSON.stringify(firms)).not.toContain("Privileged Matter Title");
    expect(JSON.stringify(firms)).not.toContain("Confidential Client Name");
    const one = await getFirm(t.platform, f.firmId);
    expect(one!.firm.name).toBe(row.name);
    expect(JSON.stringify(one)).not.toContain("Privileged Matter Title");
    expect(await getFirm(t.platform, "not-a-uuid")).toBeNull();
  });

  it("search finds by firm name, address or owner email, and treats % and _ as plain characters", async () => {
    const f = await firmWithMatter();
    const slug = f.slug;
    expect((await listFirms(t.platform, slug)).map((x) => x.firmId)).toContain(f.firmId);
    expect((await listFirms(t.platform, "%")).length).toBe(0);
  });

  it("the portal's login can't read any table: Matters, evidence, clients, users, firms", async () => {
    for (const table of ["matters", "evidence_items", "clients", "users", "firms", "audit_events", "matter_notes", "platform_audit"]) {
      await expect(t.platform.query(`SELECT * FROM huis.${table} LIMIT 1`)).rejects.toThrow(/permission denied/);
    }
    await expect(t.platform.query("SELECT huis.operator_set_subscription(gen_random_uuid(), 'professional', 5, NULL, now(), 'active', 'x')")).rejects.toThrow(/permission denied/);
  });

  it("the app's login can't call the portal's functions", async () => {
    const f = await firmWithMatter();
    await expect(t.db.withFirm(f.owner, (s) => s.client.query("SELECT * FROM huis.platform_firm_rows(NULL, NULL)"))).rejects.toThrow(/permission/i);
    await expect(t.db.withFirm(f.owner, (s) => s.client.query("SELECT huis.platform_set_status('me', $1, 'active', 'x')", [f.firmId]))).rejects.toThrow(/permission/i);
  });
});

describe("what Huis staff can change, always with a note, always recorded", () => {
  it("extends a trial (trial firms only, within 90 days)", async () => {
    const f = await firmWithMatter();
    const end = new Date(Date.now() + 14 * DAY);
    await setTrialEnd(t.platform, "Tracy Peart", f.firmId, end, "Extended for a demo with the partners");
    const got = await getFirm(t.platform, f.firmId);
    expect(got!.firm.trialEndsAt!.getTime()).toBe(end.getTime());
    expect(got!.history.find((h) => h.source === "huis")).toMatchObject({ source: "huis", action: "trial.set_end", byWhom: "Tracy Peart", note: "Extended for a demo with the partners" });
    const firmLog = await t.admin.query("SELECT metadata FROM huis.audit_events WHERE firm_id = $1 AND action = 'subscription.changed'", [f.firmId]);
    expect(firmLog.rows[0].metadata).toMatchObject({ by: "Huis", note: "Extended for a demo with the partners" });
    await expect(setTrialEnd(t.platform, "Tracy Peart", f.firmId, new Date(Date.now() + 200 * DAY), "too long")).rejects.toBeInstanceOf(UserFacingError);
    await expect(setTrialEnd(t.platform, "Tracy Peart", f.firmId, end, "  ")).rejects.toThrow(/note is required/);
  });

  it("suspends and restores a firm without touching its plan", async () => {
    const f = await firmWithMatter();
    await setStatus(t.platform, "Tracy Peart", f.firmId, "suspended", "Firm asked to pause");
    expect((await getFirm(t.platform, f.firmId))!.firm).toMatchObject({ status: "suspended", plan: "trial" });
    expect((await getFirm(t.platform, f.firmId))!.firm.writeBlock).toMatch(/suspended/);
    await setStatus(t.platform, "Tracy Peart", f.firmId, "active", "Resumed");
    expect((await getFirm(t.platform, f.firmId))!.firm.status).toBe("active");
  });

  it("sets a plan by agreement, but never over a live Stripe subscription", async () => {
    const f = await firmWithMatter();
    const until = new Date(Date.now() + 365 * DAY);
    await setAgreement(t.platform, "Tracy Peart", f.firmId, { plan: "enterprise", seats: 25, paidThrough: until }, "Annual invoice 1001");
    const got = (await getFirm(t.platform, f.firmId))!.firm;
    expect(got).toMatchObject({ plan: "enterprise", seatLimit: 25 });
    expect(got.firstPaidAt).not.toBeNull();
    // A firm paying through Stripe: refused, with the reason.
    const g = await firmWithMatter();
    const c = await t.admin.connect();
    try {
      await c.query("BEGIN"); await c.query("SET LOCAL ROLE huis_security");
      await c.query("UPDATE huis.firms SET plan = 'professional', stripe_customer_id = 'cus_X1', stripe_subscription_id = 'sub_X1', stripe_status = 'active', paid_through = now() + interval '30 days' WHERE id = $1", [g.firmId]);
      await c.query("COMMIT");
    } finally { c.release(); }
    await expect(setAgreement(t.platform, "Tracy Peart", g.firmId, { plan: "enterprise", seats: 5, paidThrough: until }, "x"))
      .rejects.toThrow(/pays through Stripe/);
  });

  it("the staff log can only be added to", async () => {
    await expect(t.platform.query("DELETE FROM huis.platform_audit")).rejects.toThrow(/permission denied/);
    await expect(t.db.withoutFirm((c) => c.query("DELETE FROM huis.platform_audit"))).rejects.toThrow(/permission/i);
  });
});
