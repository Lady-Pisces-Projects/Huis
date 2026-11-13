import Link from "next/link";
import { notFound } from "next/navigation";
import { relinkAction, setSignInRuleAction } from "../../../../lib/actions";
import { getFlash, withSession } from "../../../../lib/server";
import { FlashBanner } from "../../../../lib/ui";
import { getSignInRule } from "../../../../src/services/signinRule";

export const dynamic = "force-dynamic";

const PROVIDER = { microsoft: "Microsoft 365", google: "Google Workspace" } as const;
const PERSONAL_MS = "9188040d-6c67-4c5b-b112-36a304b66dad";

/*
 * Sign-in security: who may sign in to this firm. Firm owners, managing partners and firm administrators only
 * (the database refuses anyone else). Shows names and how each person signs in; nothing about any Matter.
 */
export default async function SignInSecurity({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  const flash = await getFlash((await searchParams).f);
  const view = await withSession(async (s) => {
    if (!["firm_owner", "managing_partner", "firm_admin"].includes(s.actor.role)) return null;
    return { ...(await getSignInRule(s)), isOwner: s.actor.role === "firm_owner" };
  });
  if (!view) notFound();
  const { rule, me, staff, isOwner } = view;
  const myProvider = me.provider === "microsoft" || me.provider === "google" ? me.provider : null;
  const myOrgUsable = !!myProvider && me.org !== "" && me.org !== PERSONAL_MS;
  const leftOut = rule ? staff.filter((p) => p.allowed === false) : [];
  const wouldLeaveOut = !rule && myOrgUsable ? staff.filter((p) => p.provider !== null && !(p.provider === myProvider && p.org === me.org)) : [];

  return (
    <>
      <p className="sub"><Link href="/users">Users &amp; Access</Link></p>
      <h1>Sign-in security</h1>
      <p className="sub">
        Require your staff to sign in with your firm&apos;s own Microsoft 365 or Google Workspace account. Personal Gmail and Outlook
        accounts are then refused, and your organization&apos;s own rules apply to every sign-in: its required multi-factor sign-in,
        password rules, and switching off a departing employee&apos;s account, which stops them signing in to Huis (a Huis session
        already open lasts up to 8 hours: use Remove access or Sign out everywhere on Users &amp; Access to end it at once).
      </p>
      <FlashBanner flash={flash} />

      <div className="card">
        <h2>Who can sign in</h2>
        {rule ? (
          <p><strong>Only {PROVIDER[rule.provider]} accounts from your firm</strong> ({rule.provider === "google" ? rule.org : `organization ${rule.org}`}).</p>
        ) : (
          <p><strong>Anyone you invite</strong>, with any Microsoft or Google account.</p>
        )}
        <p className="notice">
          Clients, co-counsel, expert witnesses and other outside people are never held to this: they sign in with their own accounts and
          see only the Matters you add them to.
        </p>

        {!rule && myOrgUsable ? (
          <form action={setSignInRuleAction}>
            <input type="hidden" name="provider" value={myProvider!} />
            <p>
              You signed in with {PROVIDER[myProvider!]} ({myProvider === "google" ? me.org : `organization ${me.org}`}). Turning this on
              allows only accounts from that same {myProvider === "google" ? "domain" : "organization"}.
            </p>
            {wouldLeaveOut.length > 0 ? (
              <div className="flash error">
                These staff signed in with another account and will be signed out until they sign in with your firm&apos;s account (an owner can then give each a new sign-in link):{" "}
                {wouldLeaveOut.map((p) => p.fullName).join(", ")}.
              </div>
            ) : null}
            <button type="submit">Require {PROVIDER[myProvider!]} sign-in</button>
          </form>
        ) : null}
        {!rule && !myOrgUsable ? (
          <p className="notice">
            To turn this on, sign in with your firm&apos;s own Microsoft 365 or Google Workspace account (not a personal Gmail or
            Outlook account). Huis takes the organization from your own sign-in, so you can&apos;t lock yourself out, and at least one firm owner must sign in with the same organization.
          </p>
        ) : null}

        {rule && leftOut.length > 0 ? (
          <div className="flash error">
            <p>Signed out until they sign in again with your firm&apos;s account:</p>
            <ul>
              {leftOut.map((p) => (
                <li key={p.userId}>
                  {p.fullName}{" "}
                  {isOwner ? (
                    <form action={relinkAction} style={{ display: "inline" }}>
                      <input type="hidden" name="userId" value={p.userId} />
                      <button type="submit" className="secondary">New sign-in link</button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="notice">
              {isOwner ? "A new sign-in link moves their existing account (and its Matter access) to the firm account they sign in with, so send it only to them."
                : "A firm owner can give each of them a new sign-in link."}
            </p>
          </div>
        ) : null}
        {rule ? (
          <form action={setSignInRuleAction}>
            <input type="hidden" name="provider" value="any" />
            <button type="submit" className="danger">Allow any Microsoft or Google account</button>
          </form>
        ) : null}
      </div>

      <div className="card">
        <h2>About multi-factor sign-in</h2>
        <p>
          Huis signs people in through Microsoft or Google and never sees a password. Multi-factor sign-in is enforced by your
          organization: in Microsoft Entra (security defaults or Conditional Access) or in the Google Admin console (2-Step Verification).
          Requiring your firm&apos;s own account above makes sure every staff sign-in goes through those settings.
        </p>
      </div>
    </>
  );
}
