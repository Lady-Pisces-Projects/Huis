import type { FirmSession } from "../db/tenant";
import { UserFacingError } from "../errors";

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

export const MAX_LOGO_PIXELS = 4000;

/**
 * Width and height from a PNG, JPEG or WebP header, or null if they can't be read. A tiny file can unpack to an
 * enormous image (security review 33), so the logo's size is checked before it is stored; the database checks
 * PNGs again itself.
 */
export function imageSize(b: Buffer): { width: number; height: number } | null {
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) && b.toString("latin1", 12, 16) === "IHDR") {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 30 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    const kind = b.toString("latin1", 12, 16);
    if (kind === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (kind === "VP8L" && b[20] === 0x2f) {
      const bits = b.readUInt32LE(21);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    if (kind === "VP8 " && b.length >= 30) return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = b.readUInt16BE(i + 2);
      // Start-of-frame markers (baseline, progressive and the rest), not DHT (c4), JPG (c8) or DAC (cc).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      }
      if (len < 2) return null;
      i += 2 + len;
    }
  }
  return null;
}

export async function setLogo(s: FirmSession, bytes: Buffer | null): Promise<void> {
  if (bytes) {
    const size = imageSize(bytes);
    if (!size) throw new UserFacingError("The logo must be a PNG, JPEG or WebP image.");
    if (size.width < 1 || size.height < 1 || size.width > MAX_LOGO_PIXELS || size.height > MAX_LOGO_PIXELS) {
      throw new UserFacingError(`The logo can be up to ${MAX_LOGO_PIXELS} pixels wide and tall.`);
    }
  }
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
