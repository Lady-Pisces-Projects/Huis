import Link from "next/link";
import { withSession } from "../../lib/server";
import { ROLE_LABELS } from "../../lib/ui";
import { unreadAlertCount } from "../../src/services/alerts";
import { pausedReason } from "../../src/services/subscription";
import { can, INTERNAL_ROLES } from "../../src/security/permissions";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { actor, firmName, unread, paused } = await withSession(async (s) => {
    const { rows } = await s.client.query<{ name: string }>("SELECT name FROM huis.firms");
    return { actor: s.actor, firmName: rows[0]?.name ?? "", unread: await unreadAlertCount(s), paused: await pausedReason(s) };
  });
  return (
    <div className="shell">
      <nav className="nav" aria-label="Main">
        <div className="logo">Huis Law IP<small>{firmName}</small></div>
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
        <div className="spacer" />
        <div className="who">{actor.fullName}<br />{ROLE_LABELS[actor.role]}</div>
        <form action="/api/auth/signout" method="post"><button type="submit">Sign out</button></form>
      </nav>
      <main className="main">
        {/* Phase 10: everyone in the firm is told when new work is paused, and that nothing is lost. */}
        {paused ? <div className="flash error" role="status">{paused}{can(actor.role, "licenses.view") ? <> <Link href="/subscription">See the subscription</Link>.</> : null}</div> : null}
        {children}
      </main>
    </div>
  );
}
