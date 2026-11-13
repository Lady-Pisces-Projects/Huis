import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getBranding, getLogo, setBranding, setLogo } from "../src/services/branding";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

/*
 * Independent security review 33: white label (db/migrations/0043_white_label.sql, Phase 10 part 5).
 * Each test fails today and passes once its problem is fixed.
 */

let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });

/** A real PNG header (signature + IHDR with the given size), padded. */
const pngOf = (w: number, h: number) => {
  const ihdr = Buffer.alloc(25); ihdr.writeUInt32BE(13, 0); ihdr.write("IHDR", 4, "latin1"); ihdr.writeUInt32BE(w, 8); ihdr.writeUInt32BE(h, 12); ihdr[16] = 8; ihdr[17] = 6;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), ihdr, Buffer.alloc(40, 1)]);
};
const PNG = pngOf(160, 40);

async function firmOn(plan: "enterprise" | "professional", paidThrough: string, status: "active" | "suspended" = "active") {
  const f = await newFirm(t.db);
  await t.admin.query(`SELECT huis.operator_set_subscription($1, $2, 50, NULL, now() + $3::interval, $4, 'review 33')`, [f.firmId, plan, paidThrough, status]);
  return f;
}
const named = (displayName: string) => ({ displayName, brandColor: "", accentColor: "" });

describe("R33-1: white label stays editable after the firm's Enterprise access has ended, and while Huis has suspended the firm", () => {
  it("an Enterprise agreement that ran out (paid-through date plus the 7 days' grace long past) can't change what clients see", async () => {
    // plan stays 'enterprise' when an agreement lapses (huis.firm_access_ended_at reports the end), so
    // branding_check_editor (which looks at the plan only) still lets the firm change its name, colours and logo.
    const f = await firmOn("enterprise", "-30 days");
    expect((await t.admin.query("SELECT huis.firm_access_ended_at($1) AS e", [f.firmId])).rows[0].e).not.toBeNull();
    await expect(t.db.withFirm(f.owner, (s) => setBranding(s, named("Lapsed LLP")))).rejects.toMatchObject({ status: 403 });
    await expect(t.db.withFirm(f.owner, (s) => setLogo(s, PNG))).rejects.toMatchObject({ status: 403 });
  });

  it("a firm Huis has suspended can't rebrand the menu its clients see", async () => {
    const f = await firmOn("enterprise", "1 year", "suspended");
    await expect(t.db.withFirm(f.owner, (s) => setBranding(s, named("Rebranded While Suspended LLP")))).rejects.toMatchObject({ status: 403 });
  });
});

describe("R33-2: the menu name accepts invisible, bidi-override and line-separator characters", () => {
  it("refuses a name that is blank to the eye, reorders itself, or breaks onto a new line", async () => {
    // Only [[:cntrl:]] (C0, DEL, C1) is refused and only spaces are trimmed. A name of a zero-width space or
    // no-break spaces shows clients an empty firm name; U+202E (right-to-left override) shows "Smith‮LLP"
    // as "SmithPLL" and reorders the rest of its audit-log cell; U+2028 breaks the "one line" the error promises.
    const f = await firmOn("enterprise", "1 year");
    for (const n of ["​", "  ", "　", "﻿", "Smith‮LLP", "Smith ⁦LLP⁩", "Smith LLP", "Smith LLP"]) {
      await expect(t.db.withFirm(f.owner, (s) => setBranding(s, named(n))), JSON.stringify(n)).rejects.toMatchObject({ status: 403 });
    }
  });
});

describe("R33-3: a firm that leaves Enterprise can never remove its logo or name from Huis", () => {
  it("after moving to Professional the owner can still delete the saved logo and clear the name", async () => {
    // The settings are kept (and still served to its administrators), but set_firm_logo / set_firm_branding go
    // through branding_check_editor, which refuses everything off Enterprise, including removal.
    const f = await firmOn("enterprise", "1 year");
    await t.db.withFirm(f.owner, (s) => setBranding(s, named("Old Name LLP")));
    await t.db.withFirm(f.owner, (s) => setLogo(s, PNG));
    await t.admin.query("SELECT huis.operator_set_subscription($1, 'professional', 50, NULL, now() + interval '1 year', 'active', 'downgrade')", [f.firmId]);
    await expect(t.db.withFirm(f.owner, (s) => setLogo(s, null))).resolves.toBeUndefined();
    expect(await t.db.withFirm(f.owner, (s) => getLogo(s))).toBeNull();
    await expect(t.db.withFirm(f.owner, (s) => setBranding(s, named("")))).resolves.toBeUndefined();
    expect((await t.db.withFirm(f.owner, (s) => getBranding(s)))?.displayName ?? null).toBeNull();
  });
});
