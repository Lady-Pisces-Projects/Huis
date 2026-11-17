import type { FirmSession } from "../db/tenant";

/**
 * A firm's sign-in rule (db/migrations/0039_signin_rules.sql): anyone it invites, or only accounts from the firm's
 * own Microsoft 365 organization or Google Workspace domain. Set by the firm's owner, managing partners and firm
 * administrators; the organization is always the one the person setting it signed in with.
 */
export type SignInRuleProvider = "any" | "microsoft" | "google";

export interface SignInRuleStaff { userId: string; fullName: string; provider: string | null; org: string | null; allowed: boolean | null }

export interface SignInRuleView {
  rule: { provider: "microsoft" | "google"; org: string } | null;
  me: { provider: string | null; org: string };
  staff: SignInRuleStaff[];
}

export async function getSignInRule(s: FirmSession): Promise<SignInRuleView> {
  const { rows } = await s.client.query("SELECT * FROM huis.my_signin_rule()");
  const first = rows[0];
  return {
    rule: first?.rule_provider ? { provider: first.rule_provider, org: first.rule_org } : null,
    me: { provider: first?.my_provider ?? null, org: first?.my_org ?? "" },
    staff: rows.map((r) => ({ userId: r.user_id, fullName: r.full_name, provider: r.user_provider, org: r.user_org, allowed: r.allowed })),
  };
}

export async function setSignInRule(s: FirmSession, provider: SignInRuleProvider): Promise<void> {
  await s.client.query("SELECT huis.set_signin_rule($1)", [provider]);
}
