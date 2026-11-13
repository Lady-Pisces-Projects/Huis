import Link from "next/link";
import { withSession } from "../../lib/server";
import { ROLE_LABELS } from "../../lib/ui";
import { unreadAlertCount } from "../../src/services/alerts";
import { deletionDate, pausedReason } from "../../src/services/subscription";
import { date } from "../../lib/ui";
import { can, INTERNAL_ROLES } from "../../src/security/permissions";
import { getBranding, menuInk } from "../../src/services/branding";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { actor, firmName, unread, paused, deleteAfter, branding } = await withSession(async (s) => {
    const { rows } = await s.client.query<{ name: string }>("SELECT name FROM huis.firms");
    return { actor: s.actor, firmName: rows[0]?.name ?? "", unread: await unreadAlertCount(s), paused: await pausedReason(s), deleteAfter: await deletionDate(s), branding: await getBranding(s) };
  });
  // White label (Enterprise): the firm's name, logo and colours, for its staff and clients. Colours are checked
  // for readability by the database; React escapes them into CSS variables.
  const brand = branding?.enabled ? branding : null;
  const style = {
    ...(brand?.brandColor ? { "--brand": brand.brandColor, "--brand-ink": menuInk(brand.brandColor) } : {}),
    ...(brand?.accentColor ? { "--accent": brand.accentColor } : {}),
  } as React.CSSProperties;
  const canBrand = ["firm_owner", "managing_partner", "firm_admin"].includes(actor.role);
  return (
    <div className="shell" style={style}>
      <nav className="nav" aria-label="Main">
        {brand ? (
          <div className="logo firm-logo">
            {brand.hasLogo ? <img src={`/api/branding/logo?v=${brand.version}`} alt="" /> : null}
            {brand.displayName ?? firmName}
            <small>on Huis Law</small>
          </div>
        ) : (
          <div className="logo">Huis Law IP<small>{firmName}</small></div>
        )}
        <Link href="/dashboard">Dashboard</Link>
        {INTERNAL_ROLES.has(actor.role) ? <Link href="/alerts">Alerts{unread ? <span className="badge privileged" style={{ marginLeft: 6 }}>{unread > 99 ? "99+" : unread}</span> : null}</Link> : null}
        {INTERNAL_ROLES.has(actor.role) ? <Link href="/inbox">Inbox</Link> : null}
        {INTERNAL_ROLES.has(actor.role) ? <Link href="/integrations">Integrations</Link> : null}
        <Link href="/matters">Matters</Link>
        <Link href="/search">Search</Link>
        {INTERNAL_ROLES.has(actor.role) ? <Link href="/prompts">AI Prompts</Link> : null}
        {INTERNAL_ROLES.has(actor.role) ? <Link href="/authorities">Legal Authorities</Link> : null}
        {can(actor.role, "clients.view") ? <Link href="/clients">Clients</Link> : null}
        {can(actor.role, "contacts.view") ? <Link href="/contacts">People &amp; Contacts</Link> : null}
        {can(actor.role, "users.manage") ? <Link href="/users">Users &amp; Access</Link> : null}
        {can(actor.role, "audit.view") ? <Link href="/audit">Audit Log</Link> : null}
        {INTERNAL_ROLES.has(actor.role) ? <Link href="/billing">Billing</Link> : null}
        {can(actor.role, "licenses.view") ? <Link href="/subscription">Subscription</Link> : null}
        {canBrand ? <Link href="/branding">Branding</Link> : null}
        <div className="spacer" />
        <div className="who">{actor.fullName}<br />{ROLE_LABELS[actor.role]}</div>
        <form action="/api/auth/signout" method="post"><button type="submit">Sign out</button></form>
      </nav>
      <main className="main">
        {/* Phase 10: everyone in the firm is told when new work is paused; firm staff also see when the firm's data will be deleted. */}
        {paused ? (
          <div className="flash error" role="status">
            {paused}
            {deleteAfter ? <> <strong>The firm&apos;s files will be deleted on {date(deleteAfter)}</strong> unless it subscribes; export anything you need before then.</> : null}
            {can(actor.role, "licenses.view") ? <> <Link href="/subscription">See the subscription</Link>.</> : null}
          </div>
        ) : null}
        {children}
      </main>
    </div>
  );
}
