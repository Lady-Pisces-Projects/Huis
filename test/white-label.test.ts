import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMatter } from "../src/services/matters";
import { createClient } from "../src/services/clients";
import { getBranding, getLogo, menuInk, setBranding, setLogo } from "../src/services/branding";
import { inviteUser } from "../src/services/users";
import { acceptInvitation } from "../src/services/firms";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

/* Phase 10 part 5: white label (db/migrations/0043_white_label.sql). */
let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });

const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(64, 1)]);
const JPEG = Buffer.concat([Buffer.from("ffd8ffe0", "hex"), Buffer.alloc(64, 2)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML_AS_PNG = Buffer.from("<html><script>alert(document.cookie)</script></html>");

async function enterpriseFirm() {
  const f = await newFirm(t.db);
  await t.admin.query("SELECT huis.operator_set_subscription($1, 'enterprise', 50, NULL, now() + interval '1 year', 'active', 'agreement')", [f.firmId]);
  return f;
}

describe("white label", () => {
  it("an Enterprise firm's name, colours and logo are shown to its staff and its clients", async () => {
    const f = await enterpriseFirm();
    await t.db.withFirm(f.owner, (s) => setBranding(s, { displayName: "Smith & Lopez LLP", brandColor: "#0D1D29", accentColor: "#806338" }));
    await t.db.withFirm(f.owner, (s) => setLogo(s, PNG));
    const c = await t.db.withFirm(f.owner, async (s) => {
      const client = await createClient(s, { kind: "person", displayName: "Pat", email: "pat@example.com" });
      await createMatter(s, { title: "Pat v. Acme", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
      return inviteUser(s, { email: "pat@example.com", fullName: "Pat Client", role: "client", locationId: f.locationId });
    });
    const linked = (await acceptInvitation(t.db, c.invitationToken, "google", "100000000000000000123"))!;
    const seen = await t.db.withFirm(linked, (s) => getBranding(s));
    expect(seen).toMatchObject({ displayName: "Smith & Lopez LLP", brandColor: "#0d1d29", accentColor: "#806338", hasLogo: true, enabled: true });
    const logo = await t.db.withFirm(linked, (s) => getLogo(s));
    expect(logo?.type).toBe("image/png");
    expect(logo?.bytes.equals(PNG)).toBe(true);
    const audit = await t.admin.query("SELECT action FROM huis.audit_events WHERE firm_id = $1 AND action LIKE 'firm.%'", [f.firmId]);
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(["firm.branding_changed", "firm.logo_changed"]));
  });

  it("another firm sees nothing of it", async () => {
    const a = await enterpriseFirm();
    await t.db.withFirm(a.owner, (s) => setBranding(s, { displayName: "Firm A", brandColor: "", accentColor: "" }));
    await t.db.withFirm(a.owner, (s) => setLogo(s, JPEG));
    const b = await enterpriseFirm();
    expect(await t.db.withFirm(b.owner, (s) => getBranding(s))).toBeNull();
    expect(await t.db.withFirm(b.owner, (s) => getLogo(s))).toBeNull();
  });

  it("is Enterprise only: refused on other plans, and hidden (but kept) if the firm leaves Enterprise", async () => {
    const trial = await newFirm(t.db);
    await expect(t.db.withFirm(trial.owner, (s) => setBranding(s, { displayName: "X", brandColor: "", accentColor: "" }))).rejects.toMatchObject({ status: 403 });
    const f = await enterpriseFirm();
    await t.db.withFirm(f.owner, (s) => setBranding(s, { displayName: "Kept LLP", brandColor: "", accentColor: "" }));
    await t.admin.query("SELECT huis.operator_set_subscription($1, 'professional', 50, NULL, now() + interval '1 year', 'active', 'downgrade')", [f.firmId]);
    expect((await t.db.withFirm(f.owner, (s) => getBranding(s)))?.enabled).toBe(false); // the owner sees it is saved but off
    const c = await t.db.withFirm(f.owner, (s) => inviteUser(s, { email: "a@x.example", fullName: "Al Attorney", role: "attorney", locationId: f.locationId }));
    const linked = (await acceptInvitation(t.db, c.invitationToken, "google", "100000000000000000456"))!;
    expect(await t.db.withFirm(linked, (s) => getBranding(s))).toBeNull(); // staff see the Huis look
  });

  it("only the owner, managing partners and firm administrators can change it", async () => {
    const f = await enterpriseFirm();
    const c = await t.db.withFirm(f.owner, (s) => inviteUser(s, { email: "b@x.example", fullName: "Bo Attorney", role: "attorney", locationId: f.locationId }));
    const linked = (await acceptInvitation(t.db, c.invitationToken, "google", "100000000000000000789"))!;
    await expect(t.db.withFirm(linked, (s) => setBranding(s, { displayName: "Hijack", brandColor: "", accentColor: "" }))).rejects.toThrow();
    await expect(t.db.withFirm(linked, (s) => setLogo(s, PNG))).rejects.toThrow();
    await expect(t.db.withFirm(f.owner, (s) => s.client.query("INSERT INTO huis.firm_branding (firm_id, display_name) VALUES ($1, 'x')", [f.firmId]))).rejects.toThrow();
  });

  it("refuses colours that would be hard to read, and anything but a plain colour", async () => {
    const f = await enterpriseFirm();
    const set = (brandColor: string, accentColor: string) => t.db.withFirm(f.owner, (s) => setBranding(s, { displayName: "", brandColor, accentColor }));
    await expect(set("#777777", "")).rejects.toThrow(/hard to read/); // mid grey: neither white nor dark text reaches 4.5:1
    await expect(set("", "#ffd700")).rejects.toThrow(/hard to read on white/); // gold links on white
    await expect(set("red; } body { display:none", "")).rejects.toThrow(/#1d3557/);
    await expect(set("#0d1d29", "#806338")).resolves.toBeUndefined();
    expect(menuInk("#0d1d29")).toBe("#ffffff");
    expect(menuInk("#f7f3eb")).toBe("#14213d");
  });

  it("refuses an SVG, HTML dressed up as a PNG, a too-large file, and a name with line breaks", async () => {
    const f = await enterpriseFirm();
    await expect(t.db.withFirm(f.owner, (s) => setLogo(s, SVG))).rejects.toThrow(/PNG, JPEG or WebP/);
    await expect(t.db.withFirm(f.owner, (s) => setLogo(s, HTML_AS_PNG))).rejects.toThrow(/PNG, JPEG or WebP/);
    await expect(t.db.withFirm(f.owner, (s) => setLogo(s, Buffer.concat([PNG, Buffer.alloc(262145)])))).rejects.toThrow(/256 KB/);
    await expect(t.db.withFirm(f.owner, (s) => setBranding(s, { displayName: "Line\nbreak", brandColor: "", accentColor: "" }))).rejects.toThrow(/one line/);
    await t.db.withFirm(f.owner, (s) => setLogo(s, PNG));
    await t.db.withFirm(f.owner, (s) => setLogo(s, null));
    expect((await t.db.withFirm(f.owner, (s) => getBranding(s)))?.hasLogo).toBe(false);
  });
});
