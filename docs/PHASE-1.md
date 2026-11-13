# Phase 1 — Identity, Firm, Matter & Security

**Status:** Security core built and tested (Build 1, part 1). Sign-in screens and the web app come next.

## What exists

| Area | Where | What it guarantees |
|---|---|---|
| Database schema | `db/migrations/0001_foundation.sql` | Firms, locations, users, licenses, clients, contacts, matters, members, folders, audit log |
| Firm isolation | Row-level security on every table | A firm's data is invisible to every other firm, even to raw SQL through the app's connection. No context = no rows |
| Ethical walls | `matters.restricted` + `huis.can_see_matter` | A walled matter is visible only to its explicit members — not even the firm owner |
| External users | Roles `client`, `co_counsel`, `expert_witness`, `authorized_third_party` | See only matters they're added to, view-only, never the red privileged area, client list or staff list |
| Privilege-waiver warning | `addMatterMember` | Adding someone outside the firm requires an explicit acknowledgement, recorded in the audit log |
| Red privileged area | `huis.matter_after_insert` trigger | Every matter gets "Privileged & Confidential" (red) plus standard folders |
| Matter numbers | `huis.assign_matter_number` trigger | `HUIS-UT-ARIVERA-2026-000001` per firm per year; court case number and firm number kept separately |
| Roles | `src/security/permissions.ts` + database policies | 14 roles; admin-only actions enforced in both the app and the database |
| Licensing | `licenses` table | One active license per user; one account per firm (decision #4) |
| Audit log | `audit_events` | Append-only (edits and deletes are refused, even for the table owner), hash-chained so tampering is detectable; client names never written to it. See `SECURITY-REVIEW-2026-11.md` for the remaining superuser caveat |
| Sign-up / sign-in lookup | `huis.bootstrap_firm`, `huis.resolve_identity` | New firm on a 7-day trial; sign-in returns only firm and user ids |

## How application code must access data

Always through `HuisDb.withFirm(ctx, fn)`. It opens a transaction, sets the firm and user for row-level security, verifies the user is active in that firm, runs your code, and commits. The app's database login **must** be a member of `huis_app` and must not be a superuser or table owner — a test checks this.

## Tests

`npm test` runs 25 tests against a real PostgreSQL 16 database, including:
- firm A cannot read or write firm B's data
- missing context returns nothing
- forged context (user from another firm) is rejected
- walled matters hidden from non-members, including the owner
- clients see only their matters and never privileged folders
- paralegals cannot add users, in the app or by direct SQL
- the last firm owner cannot be removed
- audit log cannot be edited or deleted; tampering is detected

Removing row-level security from the matters table makes 4 of these tests fail, confirming they guard the real protections.

CI (`.github/workflows/ci.yml`) runs type checks, these tests and a dependency vulnerability scan on every pull request.

## Sign-in (Microsoft)

The app's own address (`/`) has no homepage: the public website is huislaw.ai (the static site in `website/`, decided 12 November 2026). Signed-in people go to their dashboard; everyone else to sign-in.

| Piece | Where | Guarantee |
|---|---|---|
| Sign-in flow | `src/auth/microsoft.ts`, `app/api/auth/*` | OpenID Connect authorization code + PKCE, state and nonce; works for any Microsoft 365 organization or personal Microsoft account |
| Token checks | `verifyMicrosoftIdToken` | Signature (Microsoft's published keys), audience = Huis app, issuer must match the token's own tenant, nonce, expiry |
| Account key | `<tenant id>:<object id>` | **Never the email address.** Email claims are not a safe account key, so accounts are never found or linked by email |
| Invitations | `db/migrations/0002_invitations.sql` | One-time link (only a hash stored), 7-day expiry, reissuing revokes the old link, audited |
| Session | `src/auth/tokens.ts` | Encrypted cookie (AES-256-GCM), HttpOnly, SameSite=Lax, Secure on HTTPS, 8-hour lifetime; user re-checked as active on every request |
| Multi-firm users | `/select-firm` | A person licensed at two firms picks one; firms stay fully separate |

Sign-in asks Microsoft only for `openid profile email offline_access`. **No mailbox permissions yet** — those come in Phase 3.

## Sign-in with Google (added 12 November 2026)

For attorneys whose firm uses Google Workspace, or a personal Google account. Microsoft and Google share one flow (`lib/signin.ts`); only each provider's URLs and token checks differ.

| Piece | Where | Guarantee |
|---|---|---|
| Sign-in flow | `src/auth/google.ts`, `app/api/auth/google/start`, `app/api/auth/callback/google` | OpenID Connect authorization code + PKCE (S256), state and nonce, `access_type=online` (no refresh token kept) |
| What Google is asked for | `GOOGLE_SIGNIN_SCOPES` | **Only `openid email profile`**: no Gmail, Drive or anything else (connecting Gmail is a separate step with its own consent). These are Google's non-sensitive scopes, so sign-in needs no Google app verification beyond the consent screen's brand details |
| Token checks | `verifyGoogleIdToken` (`src/mail/google.ts`) | Signature (Google's published keys), audience = Huis, issuer, nonce, expiry (required), issued-at within the hour, authorized party = Huis when present or when there are several audiences |
| Account key | `google` + Google's account id (`sub`) | **Never the email address**; an email is used for display only, and only when Google says it is verified. The same id from Microsoft is a different person |
| Provider mix-ups | `signInReturnMatches` (`src/auth/signin-check.ts`) | A sign-in started with one provider can't be finished at the other's callback (the provider is sealed in the sign-in cookie) |
| Invitations | `app/invite/[token]`, `huis.invitation_preview` (0036) | The invitation page names the firm and the person invited; accepting is a button on that page (a POST checked to come from Huis itself), never a bare link, with either Microsoft or Google |
| Start a trial | `/signup` | Where the website's "Start Your 7-Day Free Trial" buttons go: Microsoft or Google, then the firm is named on the next screen |

**Before it can be used:** in the Google Cloud project behind `GOOGLE_CLIENT_ID` (the same OAuth client as Gmail and Google Drive), add the redirect URI `<base URL>/api/auth/callback/google`. The OAuth consent screen needs the app's name, logo, support email and privacy policy link; `openid email profile` don't need Google's verification review.

**Security review 29:** see `SECURITY-REVIEW-2026-11.md`; regression tests in `test/security-review-29.test.ts`, more in `test/google-signin.test.ts`.

## Sign-in security (added 12 November 2026)

A firm can require its staff to sign in with the **firm's own Microsoft 365 organization or Google Workspace domain** (Users & Access → Sign-in security). Personal Gmail and Outlook accounts are then refused for staff, and the firm's own account rules apply to every staff sign-in: its required multi-factor sign-in, password rules, and switching off a departing employee's account (which stops them signing in to Huis; a Huis session already open lasts up to 8 hours, so also use Remove access or Sign out everywhere to end it at once). Clients, co-counsel, expert witnesses and authorized third parties are never held to it.

| Piece | Where | Guarantee |
|---|---|---|
| The organization | Microsoft: the tenant in the identity (`<tenant>:<user>`), read by the database itself. Google: the verified token's `hd` claim, recorded in `huis.identity_orgs` at each sign-in | Google: "You must check this claim when restricting access to a resource to only members of certain domains"; absent for personal accounts. The app can't read or write `identity_orgs` except through `huis.signin_accounts` and `huis.accept_invitation` |
| Turning it on | `huis.set_signin_rule` (0039), `/users/sign-in` | Firm owner, managing partners and firm administrators only. The organization is the one the person turning it on signed in with (no ids typed), so nobody can lock their firm out; a personal account (Gmail, or Microsoft's personal-account tenant) can't turn it on. The page lists the staff who would be signed out first. Audited |
| Every request | `huis.session_signin_allowed`, `src/db/tenant.ts` | Checked with the session: turning the rule on ends other staff sign-ins at once ("Your firm requires signing in with the firm's own account"). A Google account that leaves the firm's Workspace is refused from its next Google sign-in (Huis learns the domain only at sign-in). Signing out works even when the rule refuses the account |
| Sign-in | `huis.signin_accounts`, `lib/signin.ts` | Firms that refuse the account are left out of the sign-in choices |
| Invitations | `huis.accept_invitation(token, provider, subject, org)` | A staff invitation can't be accepted with an account from outside the organization, and isn't used up by the attempt. The 3-argument form is no longer callable by the app |
| Coming back | `huis.issue_relink_invitation` (0040), Sign-in security page | A firm owner (only) can give someone the rule leaves out a one-time "sign in again" link; it is accepted only with an account that meets the rule, moves their existing account (Matter access, history) to it, ends their old sessions and is audited. Owner only because it re-links an existing account |
| Keeping an owner | While a rule exists, the last owner it allows can't be disabled or demoted; turning the rule off revokes outstanding "sign in again" links, and a link only works while the rule still refuses the person (review 35). Huis staff can turn a rule off to recover a locked-out firm |
| Background work | Mailbox sync, cloud-drive imports and listings, and email filings stop for people the rule refuses |
| Where the Google domain is trusted | `lib/signin.ts` | Microsoft's tenant is part of the identity, so the database checks it itself. Google's domain is taken from the token the app verified: like the rest of sign-in, it relies on the app |

**Multi-factor sign-in.** Huis doesn't claim to check it itself: Google's ID token doesn't say whether it was used, and Microsoft documents the `amr` claim (which would) for its access tokens; a 2022 Microsoft answer says it is only in version 1.0 tokens, and Huis uses version 2.0. The firm's organization enforces it (Microsoft Entra security defaults or Conditional Access; Google 2-Step Verification enforcement), and this rule makes every staff sign-in go through it. A Huis passkey for firms without a managed organization is a later option.

**Tests:** `test/signin-rules.test.ts` (11 tests) and `test/security-review-31.test.ts` (review 31).

## Web app (Next.js)

Pages: sign-in, firm set-up (7-day trial), choose firm, invitation, dashboard, matters (search), new matter (ethical wall option), matter overview (numbers, red Privileged & Confidential folder, access list with privilege-waiver acknowledgement, linked judges/witnesses), clients, people & contacts, users & access (invite, new link, change role, remove access), audit log with live integrity check.

Security headers on every page: Content-Security-Policy, frame blocking, no-sniff, `Referrer-Policy: same-origin` (keeps invitation links out of other sites' logs), HSTS in production. Pages a role may not use return "not found".

Settings are listed in `.env.example`. The Microsoft client secret goes only into Replit Secrets or the cloud vault.

## Still to do in Phase 1

1. ~~**Google sign-in**~~ — built 12 November 2026 (needs the redirect URI added in Google Cloud).
2. **Production hosting and database** (decision O-2), then add the production redirect URI in Entra.
3. **Move the Entra registration to a Huis Law IP business tenant and complete Microsoft publisher verification** before real firms sign in.
4. **MFA**: firms can require their own Microsoft 365 or Google Workspace sign-in, which enforces the organization's MFA (Sign-in security above). Still open: a Huis passkey for firms without a managed organization, and MFA for Huis staff signing in to the admin portal.
