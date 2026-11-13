import Link from "next/link";
import { notFound } from "next/navigation";
import { setBrandingAction, setLogoAction } from "../../../lib/actions";
import { getFlash, withSession } from "../../../lib/server";
import { FlashBanner } from "../../../lib/ui";
import { getBranding } from "../../../src/services/branding";

export const dynamic = "force-dynamic";

/*
 * White label (Phase 10 part 5): the firm's name, logo and colours, shown to its staff and clients in Huis.
 * Enterprise plan only. The firm's owner, managing partners and firm administrators; the database refuses
 * anyone else, unreadable colours and anything but a PNG, JPEG or WebP logo.
 */
export default async function BrandingPage({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  const flash = await getFlash((await searchParams).f);
  const data = await withSession(async (s) => {
    if (!["firm_owner", "managing_partner", "firm_admin"].includes(s.actor.role)) return null;
    const plan = (await s.client.query<{ plan: string }>("SELECT plan FROM huis.firms")).rows[0]?.plan ?? "";
    return { branding: await getBranding(s), enterprise: plan === "enterprise" };
  });
  if (!data) notFound();
  const { branding, enterprise } = data;

  return (
    <>
      <h1>Branding</h1>
      <p className="sub">
        Show your firm&apos;s name, logo and colours to your staff and clients in Huis. A small &ldquo;on Huis Law&rdquo; stays under your name.
        Your own web address (such as portal.yourfirm.com) comes later.
      </p>
      <FlashBanner flash={flash} />
      {!enterprise ? (
        <div className="flash error">
          White label is part of the Enterprise plan. <Link href="/subscription">See the subscription</Link>.
          {branding ? " Your saved branding is kept and appears again on Enterprise." : null}
        </div>
      ) : null}

      <div className="card">
        <h2>Name and colours</h2>
        <form action={setBrandingAction} className="stack">
          <label htmlFor="displayName">Name shown in the menu</label>
          <input id="displayName" name="displayName" maxLength={80} defaultValue={branding?.displayName ?? ""} placeholder={"Smith & Lopez LLP"} disabled={!enterprise} />
          <label htmlFor="brandColor">Menu colour</label>
          <input id="brandColor" name="brandColor" type="color" defaultValue={branding?.brandColor ?? "#1d3557"} disabled={!enterprise} />
          <label htmlFor="accentColor">Link and button colour</label>
          <input id="accentColor" name="accentColor" type="color" defaultValue={branding?.accentColor ?? "#2a6f97"} disabled={!enterprise} />
          <p className="notice">Huis checks that text stays readable on both (at least 4.5 to 1 contrast) and refuses colours that aren&apos;t.</p>
          <button type="submit" disabled={!enterprise}>Save</button>
        </form>
      </div>

      <div className="card">
        <h2>Logo</h2>
        {branding?.hasLogo ? <p><img src={`/api/branding/logo?v=${branding.version}`} alt="Your firm's logo" style={{ maxHeight: 64, maxWidth: 240 }} /></p> : <p>No logo yet.</p>}
        <form action={setLogoAction} className="stack">
          <label htmlFor="logo">PNG, JPEG or WebP, up to 256 KB. A wide logo on a transparent background works best.</label>
          <input id="logo" name="logo" type="file" accept="image/png,image/jpeg,image/webp" disabled={!enterprise} />
          <button type="submit" disabled={!enterprise}>Upload logo</button>
        </form>
        {branding?.hasLogo ? (
          <form action={setLogoAction}>
            <input type="hidden" name="remove" value="1" />
            <button type="submit" className="secondary">Remove logo</button>
          </form>
        ) : null}
      </div>

      <div className="card">
        <h2>Remove all branding</h2>
        <p>Clears the saved name and colours (any plan). Remove the logo above.</p>
        <form action={setBrandingAction}>
          <input type="hidden" name="clear" value="1" />
          <button type="submit" className="secondary">Clear name and colours</button>
        </form>
      </div>
    </>
  );
}
