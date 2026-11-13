import type { FirmSession } from "../db/tenant";

/**
 * Phase 10 part 5: white label (db/migrations/0043_white_label.sql). The firm's name, logo and colours, shown to
 * its staff and clients in the app, on the Enterprise plan only. The database checks who may change it, that
 * colours stay readable, and that the logo really is a PNG, JPEG or WebP image.
 */
export interface Branding {
  displayName: string | null;
  brandColor: string | null;
  accentColor: string | null;
  hasLogo: boolean;
  version: number;
  /** False when the firm isn't on the Enterprise plan (only its administrators see the saved settings). */
  enabled: boolean;
}

export const MAX_LOGO_BYTES = 256 * 1024;

export async function getBranding(s: FirmSession): Promise<Branding | null> {
  const { rows } = await s.client.query("SELECT * FROM huis.my_firm_branding()");
  const r = rows[0];
  if (!r) return null;
  return { displayName: r.display_name, brandColor: r.brand_color, accentColor: r.accent_color, hasLogo: r.has_logo, version: Number(r.version), enabled: r.enabled };
}

export async function getLogo(s: FirmSession): Promise<{ bytes: Buffer; type: string } | null> {
  const { rows } = await s.client.query("SELECT * FROM huis.my_firm_logo()");
  return rows[0] ? { bytes: rows[0].logo as Buffer, type: rows[0].logo_type as string } : null;
}

export async function setBranding(s: FirmSession, input: { displayName: string; brandColor: string; accentColor: string }): Promise<void> {
  await s.client.query("SELECT huis.set_firm_branding($1, $2, $3)", [input.displayName.slice(0, 200), input.brandColor.slice(0, 20), input.accentColor.slice(0, 20)]);
}

export async function setLogo(s: FirmSession, bytes: Buffer | null): Promise<void> {
  await s.client.query("SELECT huis.set_firm_logo($1)", [bytes]);
}

/** WCAG relative luminance, for choosing white or dark text on the firm's menu colour (same rule as the database). */
export function menuInk(hex: string): string {
  const lum = (h: string) => {
    const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  return ratio(hex, "#ffffff") >= ratio(hex, "#14213d") ? "#ffffff" : "#14213d";
}
