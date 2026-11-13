# Phase 10 — Commercial SaaS, Enterprise & White Label

**Status:** Part 2a (online payment through Stripe, the 7-day / 1 seat / 1 Matter trial, and the 30-day read-only period after access ends) built and tested, and through independent security reviews 27 (1 High, 2 Medium and 2 Low problems confirmed, all fixed; the worst, subscribing during the trial lifting its limits before anything was paid, is fixed) and 28 (the trial rules of 11 November and the case description: 3 Medium and 3 Low, all fixed). **Part 2b (deleting an unpaid trial's data 30 days after its trial ends) must ship before the first unpaid trial reaches that point: 37 days after launch.** Firms that have paid are never deleted for non-payment (decided 11 November 2026). Part 4 (financial evidence analysis) built, tested, checked in a real browser and the pre-release check, and through independent security review 26 (12 problems confirmed, all fixed; the worst, one file able to stall the server, is fixed). Part 3 (firm billing) built, tested, checked in a real browser and the pre-release check, and through independent security review 25 (1 Medium–High, 1 Medium and 4 Low problems confirmed, all fixed). Part 1 (subscriptions, the 7-day trial, seats and usage) built, tested, checked in a real browser and the pre-release check, and through independent security review 24 (4 Medium and 3 Low problems confirmed, all fixed).

## Plan
| Part | What | Status |
|---|---|---|
| 10.1 | **Subscriptions and licensing**: plans (7-day free trial, Professional at $237 per seat per month, Enterprise by agreement), seats, trial limits, usage, what happens when a trial ends or a payment is late, the firm's **Subscription** page, and a Huis-only command to set a firm's plan | Review 24 done, fixes in |
| 10.2a | **Online payment through Stripe** (O-11 settled: Stripe): Stripe Checkout (monthly or yearly), Stripe's customer portal, Stripe's notifications, seats billed automatically; the trial set to 7 days, 1 seat, 1 Matter; the deletion date shown for 30 days after access ends | Reviews 27 and 28 done, fixes in |
| 10.2b | **Deleting an unpaid trial's data** 30 days after the trial ends (firms that ever paid are held, never deleted): warning emails (14, 7 and 1 days before), then deleting its rows and files; mailbox sync stops for paused firms | Built, tested and reviewed (security review 32: 5 findings, all fixed). **Off until Tracy turns it on** (after the terms of service and privacy policy say so, and an email service is chosen) |
| 10.3 | **Firm billing**: timekeeping on Matters, rates, expenses, invoices to clients (trust/IOLTA money through a legal payment processor, O-10) | Review 25 done, fixes in |
| 10.4 | **Financial evidence analysis**: reading bank statements, invoices and ledgers filed as evidence (totals, gaps, unusual entries) by fixed, explainable rules | Review 26 done, fixes in |
| 10.5 | **White label** for large firms: the firm's name, logo and colours, its own address | After 10.4 |
| 10.6 | **Huis admin portal**: firms, plans, seats and trials for Huis staff (replaces the operator command) | Built, tested and reviewed (security review 30: 2 findings, both fixed) |
| 10.7 | **Production security audit** before launch | With production hosting (O-2) |

## Part 1 — Subscriptions and licensing

| Area | What Huis does |
|---|---|
| Plans | **7-day free trial** for every new firm (decision #35). **Professional**: $237 per seat per month (decision #36). **Enterprise**: priced by agreement, for larger firms |
| Seats | Attorneys and firm staff each take a seat (one license, decision #4). **Clients, co-counsel, expert witnesses and other outside people don't.** The trial has 3 seats; a paid firm has the seats Huis set up for it. Adding a person, or turning a license back on, when every seat is taken is refused with a plain message ("All 5 of the firm's seats are in use…"). Disabling someone frees their seat. Two people added at the same moment can't both take the last seat |
| Trial limits | So nobody can load a whole discovery set for free (source spec): **2 GB** of evidence and **100 AI questions a month** (Matter Brain and agent questions). A large upload is refused when it starts, not after it's sent, and files unpacked from an archive count too. Paid plans have no storage or AI limits for now (O-11 pricing may add fair-use limits) |
| When it ends | When the trial ends, Huis suspends the account, or a payment is **more than 7 days late**, new work pauses: new Matters, evidence, AI questions, imports and people. **Nothing is deleted or hidden.** Everyone can still sign in, open Matters and evidence, and **export a whole Matter** (decision #37: the firm owns its data). Work already received is finished: a container's files are still unpacked, and working copies of evidence already held are still made. Anything the subscription refuses in the background (a queued import or filing) stops at once with its reason instead of retrying. Clients and other outside users are told only that adding documents is paused, never the firm's billing standing. A suspended firm can still sign in to read and export. Everyone in the firm sees a notice saying so; subscribing lifts it at once |
| Subscription page | **Subscription** (owners, managing partners, administrators and billing administrators): the plan, trial days left or paid-through date, the monthly amount (seats × price), and meters for seats, evidence stored and AI questions this month. Numbers only: no names, Matters or documents |
| Who sets plans | Only Huis. Firm administrators can't change the plan, seats, trial or payment dates (the database refuses it, as since Phase 1 for the plan and trial). Until online payment (10.2), Huis staff run `scripts/operator/set-subscription.ts` with the database owner's connection, which the app never has; each change is written to the firm's audit log with what it was before and after, and a note (e.g. an invoice number) |
| Enforced where | In the database, whatever the caller (the app, the worker, an import or a direct query): every rule above is a check on the rows themselves, counted across the whole firm, Matters behind ethical walls included. Nothing about one firm's account can be read from another |

### Setting up a firm's plan (Huis staff)

```bash
# What a firm has now
npx tsx scripts/operator/set-subscription.ts --firm <slug> --show
# Professional, 5 seats, paid through the end of December (end of that day, Utah time)
npx tsx scripts/operator/set-subscription.ts --firm <slug> --plan professional --seats 5 --paid-through 2026-12-31 --note "Invoice 1001"
# Give a firm a few more trial days
npx tsx scripts/operator/set-subscription.ts --firm <slug> --plan trial --trial-ends 2026-11-20 --note "Extended for demo"
# Suspend (new work pauses; the firm can still read and export)
npx tsx scripts/operator/set-subscription.ts --firm <slug> --status suspended --note "Requested by firm"
```

It needs `HUIS_MIGRATION_DATABASE_URL`. Anything not given keeps its value; `--seats none` and `--paid-through none` clear them. A paid plan with no paid-through date never pauses (for firms invoiced by agreement).

### To confirm with Tracy

- The trial's limits (3 seats, 2 GB, 100 AI questions a month) and the 7 days' grace on late payment are starting values; they're one row in the `huis.plans` table and one line in the migration.
- Whether outside people (clients, co-counsel, experts) should stay free.
- Enterprise pricing and any fair-use limits for paid plans.

**Security review 24:** see `SECURITY-REVIEW-2026-11.md`; regression tests in `test/security-review-24.test.ts` (8 tests).

**Tests:** `test/subscriptions.test.ts`, 10 tests: seats (outside people free, a freed seat reused, turning a license back on directly refused, the last seat taken by only one of three people added at once, a paid firm's own seats); trial storage (refused at the start of an upload, and when two uploads started together finish); AI questions per month across the firm; a trial that has ended (new Matters, uploads, AI questions refused for everyone, reading and export still working, nothing deleted, subscribing lifts it); a late payment's 7 days' grace and a suspended account; who sees the subscription; plans, seats and dates changed only by Huis and recorded in the audit log; no reading of another firm's account; the operator command's checks.

## Part 2a — Online payment through Stripe

Decided by Tracy on 10–11 November 2026:
- **Self-serve.** People watch the explainer video, then start a **7-day free trial with no card**. No demo calls.
- **The trial: 1 seat, 1 Matter** (plus 2 GB of evidence and 100 AI questions, so nobody can load a whole discovery set for free).
- **Prices:** $237 per seat per month, or **$2,370 per seat per year** (two months free). Huis bills only the firm's active attorneys and staff; clients and other outside people are free.
- **Payments go through Stripe.** People pay on Stripe's own checkout page and manage their card, invoices, switching and cancelling in Stripe's customer portal. **Huis never sees card numbers.**
- **A trial that ends unpaid:** read and export only for 30 days, **then the firm's data is deleted** (deletion is part 2b).
- **A firm that has made its first payment** (11 November 2026): **never deleted for non-payment.** (Subscribing during the trial and cancelling, or a failed first charge, isn't a payment: that trial is deleted like any unpaid one.) If its subscription stops, new work pauses and its Matters and information are held, read and export only, until it subscribes again. The terms of service and privacy policy will say so (Tracy).
- **AI questions** (11 November 2026): the trial's **100 AI questions are for the whole trial** (not per calendar month). A question is one a person types to Matter Brain or an AI agent; everything Huis does by itself (reading, scanning and searching files, the timeline, Case DNA suggestions, reading a case description, analysis) is free and unlimited.
- **Case description** (11 November 2026): when creating a Matter, the attorney can describe the case. Huis reads it at once and suggests people, organizations, key dates and possible claims in Case DNA, for the attorney to confirm. Automatic; never an AI question.

| Area | What Huis does |
|---|---|
| Trial | 7 days from sign-up. Subscribing during the trial keeps its limits until Stripe takes the first payment at the trial's end (security review 27, R27-1). **1 seat**: the owner takes it, so adding a second attorney or staff member says "The free trial includes 1 seat. Subscribe to add attorneys and staff." Clients, co-counsel and experts can still be invited. **1 Matter**: a second is refused ("The free trial includes 1 Matter. Subscribe to add more."), enforced by a database trigger that holds a per-firm lock, so several requests at once can't create two. |
| Checkout | On **Subscription**, owners, managing partners, firm administrators and billing administrators choose **Monthly** or **Yearly**. Huis creates the firm's Stripe customer once (same idempotency key per firm) and the database records it; it can never be replaced. Checkout opens with the number of active seats, the firm's id on the subscription, and promotion codes allowed (founding-member pricing). Subscribing with more than 2 days of trial left keeps the rest of the trial free (`trial_end`). Huis sends people only to `https://checkout.stripe.com` and `https://billing.stripe.com`; any other address is refused. These are server actions, so Next's origin check applies. |
| Stripe's notifications | `POST /api/stripe/webhook`. Read only after checking Stripe's signature over the exact body, within a 5-minute window (no replays); bodies over 512 KB are refused. Huis then **asks Stripe for the subscription's current state** rather than trusting the copy in the notification, and records it through a separate database login (`huis_billing`) that can do nothing else. It applies only if the subscription's customer is the one this firm opened checkout with, and grants access only for exactly one of the two Huis prices. An old subscription ending never ends the firm's current one; a checkout that never got paid changes nothing. Duplicates are recognised (`unchanged`). Anything Huis doesn't act on is acknowledged so Stripe stops sending it; if Stripe can't be reached, Huis answers 500 so Stripe retries. Every change is in the firm's audit log ("by Stripe", before and after). |
| Seats billed | After someone is added, removed or changes role, the subscription's quantity is set to the firm's active attorneys and staff (Stripe prorates). After every notification Huis corrects it again, so a change made in Stripe or a failed update doesn't last. A Stripe firm has no seat cap. |
| Case description | **What is this case about?** on the new-Matter form (up to 5,000 characters). Saved as the Matter's first attorney note ("Case description"), so Matter Brain can search it. Huis reads it with fixed, explainable rules (`src/dna/describe.ts`): names with a title (Ms., Dr., Officer…), company names ending in Inc., LLC and similar, the parties in a caption ("Lopez v. Acme"), sentences with dates, and words pointing to a possible claim (employment templates, negligence, malpractice, fraud, divorce, custody, support, unpaid wages). Each suggestion cites the words it came from; the quote is taken from the stored note by the database (`huis.suggest_from_case_description`), never from the caller, and only the note's author at the firm, with the right to change the Matter, can have it read. At most 40 suggestions per description, read once (security review 28). Questions asked are counted in a tally that only grows, so deleting an answer doesn't give a question back. Not an AI model yet: when an outside AI provider is decided (O-3), it can read the description too. |
| AI questions | The trial's 100 are counted from sign-up to the end of the trial; paid plans count by calendar month (no limit for now). The message when they run out says what counts and that automatic work still runs. |
| Access ends | A **cancelled, unpaid or paused** subscription pauses new work at once (no grace). A **failed card** gets Stripe's retries plus 7 days' grace from the end of the last *paid* period (R27-2). A **trial** that ends unpaid pauses at its end. From then, everyone can still sign in, read and export. **Only a firm that never paid** (`firms.first_paid_at` is empty: set once, when the plan first leaves the trial, and never cleared) gets a deletion date: 30 days after its trial ended, shown to firm staff in a red notice and on the Subscription page. A firm that paid is told its Matters are kept until it subscribes again. Outside users are told only that adding documents is paused, never the firm's standing or the date. Subscribing again restores everything. Firms Huis suspends by hand get no deletion date (Huis decides those), and Huis setting a firm's plan by hand clears any ended Stripe state (R27-3). |
| Who sees what | Billing managers see the plan, status, renewal date, seats, Matters, storage and AI usage, and the buttons. Firm staff see the paused notice and deletion date. Clients never see billing state. |

### Before it can be used (Tracy / build team)
1. In Stripe, create a product **Huis Law** with two per-seat recurring prices: **$237 per month** and **$2,370 per year**. Put their ids in `STRIPE_PRICE_MONTHLY` and `STRIPE_PRICE_YEARLY`, and the secret key in `STRIPE_SECRET_KEY`.
2. Turn on the **customer portal**: allow card updates, invoice history, switching between the two prices and cancelling. Turn **off** quantity changes (Huis sets the quantity).
3. Add a webhook endpoint at `<base URL>/api/stripe/webhook` for: `checkout.session.completed`, `customer.subscription.created`, `.updated`, `.deleted`, `.paused`, `.resumed`, `invoice.paid`, `invoice.payment_failed`. Put its signing secret in `STRIPE_WEBHOOK_SECRET`.
4. Set Stripe's retry (dunning) settings so a subscription becomes `canceled` or `unpaid` once retries are exhausted.
5. Create a database login in role `huis_billing` and set `HUIS_BILLING_DATABASE_URL`.
6. Founding-member pricing: create a Stripe coupon and promotion code (checkout accepts codes).
7. Test end to end in Stripe's **test mode** before switching to live keys.

**Security reviews 27 and 28:** see `SECURITY-REVIEW-2026-11.md`; regression tests in `test/security-review-27.test.ts` (5 tests) and `test/security-review-28.test.ts` (6 tests).

**Trial rules and case description:** `test/trial-rules.test.ts` (11 tests): deletion only for an unpaid trial (not a running trial, not a firm that paid by agreement, not after moving a paid firm back to the trial; the app can't clear `first_paid_at`); the trial's AI questions counted across a month end with the plain message; the description finder (organizations, titled people, dates, claims in several practice areas, the 40 cap, nothing from plain text); a Matter's description saved as a note with cited suggestions and no AI question used; labels set by the database from the cited words, claims only from the fixed list, dates checked against their words, one reading per description, audited; only the author, at the firm, can have it read.

**Tests:** `test/stripe.test.ts` (24 tests, against a stand-in for Stripe in `test/fake-stripe.ts`): the trial's seat and Matter limits (including three Matters created at once, and a direct insert); checkout (one customer per firm, monthly and yearly prices, the trial carried over or not, only Stripe's pages, who may subscribe, the customer never replaced); notifications (limits lifted and audited, duplicates, bad / changed / old signatures, Stripe's current state winning over the notification's copy, no cross-firm upgrade, unknown prices, unpaid checkouts, Stripe unreachable, unhandled events, the webhook login's narrow rights); seats billed following staff; access ending (cancelled subscription paused at once with the deletion date, outside users told nothing, resubscribing, an old subscription ending, an unpaid trial's date, no date while the firm has access); signature parsing.

## Part 2b — Deleting an unpaid trial's data

Decided by Tracy (11 November 2026): **only a firm that never paid** is deleted, **30 days after its trial ended**. A firm that ever paid is held, read and export only, and never deleted for non-payment. Built 12 November 2026, **off by default** (`HUIS_TRIAL_DELETION=on` turns it on).

| Step | Where | What it guarantees |
|---|---|---|
| Held | `huis.firm_trial_delete_base` | Only a firm on the trial that never paid, is active (not suspended by Huis), whose trial has ended, and **has no Stripe subscription that could still charge** (trialing, past due, unpaid or paused: held until Stripe reports it finished). Anything else: no date, no warnings, no deletion |
| The date | `huis.firm_deletion_rounds` | Usually 720 hours (30 days) after the trial ended. When a firm first comes within 14 days of that, a **round** starts and fixes the actual date: the usual date, or **14 days from then if that is later** (deletion turned on late, an email service set up late, a firm restored). Paying, a Stripe subscription, a suspension or a changed trial end ends the round and its warnings; becoming eligible again starts a new round with a full 14 days. The date the firm sees is the round's date |
| Warnings | `huis.worker_queue_deletion_notices`, `src/billing/trialDeletion.ts` | Each active firm owner is emailed **14, 7 and 1 days** before the round's date: the firm's name, the date (in the firm's time zone), what will be deleted, a link to subscribe, and that each Matter can be exported first. Nothing from any Matter. One at a time (never a burst), each naming a date still ahead. Checked again when sent. Failed sends are retried hourly, 5 times |
| Due | `huis.firm_deletion_due` | The round's date reached, the round at least 13 days old, the 14-day warning sent at least 13 days earlier and the 1-day warning at least 23 hours earlier. No email service = no warnings sent = **nothing is ever deleted**. It never happens sooner than 14 days after the first warning |
| Deleting | `huis.worker_delete_firm` (worker login only) | Re-checked under a lock on the firm, so paying, an extended trial or a Huis suspension a moment earlier stops it. Every row of the firm in one transaction (all tables with the firm's id, children first, plus the tables that hang off them), and the Google identities recorded only for its people. The append-only and issued-invoice guards let only this deletion through: a row tied to the transaction that only this function can write (not a setting the app could set) |
| Files | `ObjectStore.deleteFirmPrefix` | After the rows: everything under `firm/<id>/` in file storage (already unreachable). A failure (rows or files) is recorded and retried later, backing off from an hour to a day, so one firm never holds up the others or the rest of the worker |
| What remains | `huis.firm_deletions` | A tombstone: the firm's id, trial end, deletion date, when each warning was sent, how many rows were deleted and when the files went. No name, people or client information |
| Paused firms | `huis.worker_claim_mailbox` | Mailbox sync stops for firms without access, and for people the firm's sign-in rule leaves out (review 31's open item) |

**Not crypto-shredding yet.** Files are encrypted with keys derived from one master key (production will use a key-management service, O-2). Deleting rows and files removes the data from the live system; **copies in backups remain until the backups expire**. With production hosting: per-firm keys in the key-management service, destroyed at deletion, and a backup retention period the privacy policy states.

### Before it can be turned on (Tracy)
1. The **terms of service and privacy policy** say unpaid trials are deleted 30 days after the trial ends, after three emails, and how long backups are kept (attorney review, O-5).
2. Choose the **email service** (Resend is wired in: `RESEND_API_KEY`, `HUIS_MAIL_FROM` from a verified domain).
3. Set `HUIS_TRIAL_DELETION=on` for the worker.

**Security review 32:** 5 findings, all fixed in `db/migrations/0042_review32.sql` (see `SECURITY-REVIEW-2026-11.md`); regression tests in `test/security-review-32.test.ts` (8 tests).

**Still open:** deleting a firm doesn't delete its Stripe customer record (name and email) or cancel a finished subscription in Stripe; a payment whose Stripe notice arrives after the deletion isn't refunded automatically (a firm with a live subscription is never deleted, so this needs a payment in the last moments and a delayed notice).

**Tests:** `test/trial-deletion.test.ts` (9 tests): warnings once each and only when due, waiting for an email service, a firm that pays getting none; the email's content and subject; never deleting without all three warnings sent in time (including late warnings); off means nothing; a firm with a bit of everything (evidence file, notes, AI questions, Case DNA, time, expenses, an issued invoice, audit events, a Google identity) deleted to the last row and file, a nameless tombstone, another firm untouched; re-checked at the moment of deletion (paid, suspended); a firm that ever paid never deleted; only the worker can do it, and the guards still hold for everyone else. `scripts/qa/deletion-check.ts` runs the same deletion on the full made-up firm from `scripts/qa/seed.ts` (772 rows across 50 tables, mailboxes and integrations included): nothing left.

## Part 6 — Huis admin portal

For Huis staff, at `/admin`: every firm's account, and the changes staff make day to day (extending a trial, suspending or restoring an account, a plan by agreement), without the command line.

**The rule: account information only.** Staff see a firm's name, owner name and email, plan, trial and payment dates, Stripe status, first payment, deletion date, seats, Matter count, storage and AI question counts, and the account's history. **Never a Matter, document, evidence, email, note or client name.** The database enforces it: the portal's login (role `huis_platform`) has no rights on any table and can call only the `platform_*` functions in `db/migrations/0037_admin_portal.sql`, which return account fields and counts.

| Area | What Huis does |
|---|---|
| Who is staff | `HUIS_STAFF` lists each staff member's sign-in identity (provider + account id, never an email) and name. Checked on every request, so removing someone ends their access at once. Staff sign in at `/admin/signin` with Microsoft or Google; that sign-in never opens, creates or joins a firm, and sets its own one-hour cookie. A firm's session cookie never opens the portal. |
| Firms list | Search by firm name, address or owner email (`%` and `_` are plain characters); standing in one phrase (trial, trial subscribed, paying by Stripe or agreement, paused, suspended, deletion date). Up to 500, newest first. |
| Firm page | The account fields and counts above, what the firm currently sees if its work is paused, and the account history (plan changes, Stripe billing, staff actions). |
| Changes | **Trial end** (trial firms without a Stripe subscription only, a future date within 90 days). **Suspend / restore** (the plan and any Stripe subscription stay as they are). **Plan by agreement** (professional or enterprise, seats, paid-through date; refused while the firm has any Stripe subscription that could still charge, including unpaid or paused ones, so Huis never stops following a subscription Stripe could restart). Each needs a note, and is recorded with the staff member's name in the firm's own audit log and in `huis.platform_audit`, which can only be added to. Dates are the end of that day, Utah time. |

### Before it can be used
1. Create a database login in role `huis_platform` and set `HUIS_PLATFORM_DATABASE_URL`.
2. Set `HUIS_STAFF` (e.g. `google:<your Google account id>=Tracy Peart`). Your account id is the identity Huis already uses for sign-in; Huis can show it once production hosting is set up.

The operator command (`scripts/operator/set-subscription.ts`) stays for emergencies, with the database owner's connection.

**Tests:** `test/admin-portal.test.ts` (9 tests) and `test/security-review-30.test.ts` (4 tests, review 30): the staff list (by identity, never email); the list and firm page carry no Matter titles or client names; the portal's login can't read any table or call the operator function; the app's login can't call the portal's functions; trial end, suspend/restore and plan by agreement, each with a required note and recorded; the Stripe guard; the staff log can only be added to.

## Part 3 — Firm billing (time, rates, expenses, invoices)

| Area | What Huis does |
|---|---|
| Time | Each Matter's **Billing** page: date, hours (typed as 1.5 or 1:30), what was done, billable or not. Billed in **tenths of an hour (6 minutes), rounded up**. People record their own time; billing staff (owners, managing partners, administrators, billing administrators) can record anyone's |
| Rates | Hourly rates on the firm's **Billing** page, set by billing staff: a person's standard rate, or a different one on one Matter (that wins), each from a date. Time keeps the rate in force on its day; a timekeeper can't set or change their own rate (changing an entry's date keeps its rate), and sees only their own: colleagues' rates and amounts show as a dash unless you're billing staff or invoice the Matter. Billing staff can set a rate on one entry |
| Expenses | Filing fees, couriers, experts…: date, what for, amount, billable or not |
| Invoices | Billing staff or the Matter's lead attorney **create a draft** from the Matter's unbilled billable items (up to a date), take items off it (only they can change what's on an invoice), add notes, then **issue** it (non-billable items drop off; there must be something to bill): it gets the firm's next number (**INV-2026-0001**, a sequence per firm per year), its lines and totals are copied into the invoice and never change, and its time and expenses are locked. Fees are listed first, then expenses. To change an issued invoice, **void** it (it stays on record, marked void, with its number) and issue a new one; its items become unbilled again. An invoice with payments can't be voided. A draft can be deleted |
| Payments | **Recorded, not taken**: amount, date received, how (check, card, ACH, wire, cash, other) and a reference. Never more than what's owed; paid in full marks the invoice **Paid**. Money moves outside Huis until a legal payment processor is chosen (O-10); client trust (IOLTA) accounting isn't part of this |
| Clients | A client on the Matter sees its **issued invoices** on the Matter page (number, dates, lines, payments, balance), never drafts and never the time sheets. Invoice descriptions are what the client reads, so the page reminds timekeepers to keep privileged detail out |
| Firm overview | The firm's **Billing** page: unbilled work, invoiced and still owed, overdue, invoices awaiting payment, drafts, and unbilled by Matter, across the Matters the person can see (ethical walls apply) |
| Printing | An invoice prints cleanly from the browser (the menu and buttons are left out) |
| Who | Firm staff who can see a Matter see its time, expenses and invoices; read-only staff can look but not record. Clients and other outside users never see time or expenses. All of it is enforced in the database |
| While paused | Billing keeps working when the firm's subscription pauses new work (Part 1): getting paid isn't new work |
| Logs | The audit log records what kind of billing change was made, minutes and amounts, never descriptions |

**Known limits:** one currency (US dollars); no taxes on invoices; no flat fees, retainers or discounts yet; billing staff behind an ethical wall can't bill that Matter (its members, including its lead attorney, can).

**Security review 25:** see `SECURITY-REVIEW-2026-11.md`; regression tests in `test/security-review-25.test.ts` (6 tests).

**Tests:** `test/billing.test.ts`, 7 tests: tenths and rounding, the rate in force (Matter rate first), hours typed both ways; timekeepers can't set rates or record others' time (also directly in the database), billing staff can; clients, read-only staff, walls and other firms kept out, and a DELETE with no WHERE clause reaching only one's own; drafts, issuing (numbering, copied lines, totals, locking), clients seeing issued invoices only; payments (never more than owed, paid in full), voiding (refused with payments, items back to unbilled); drafts losing items or deleted, only billing staff and the lead attorney preparing invoices; the firm overview and audit without descriptions.

## Part 4 — Financial evidence analysis

| Area | What Huis does |
|---|---|
| What it reads | Bank and card statements, ledgers, check registers and spreadsheet exports filed as evidence in the Matter, from their extracted text (scans after OCR). A document counts as financial when Huis reads at least 3 transactions from it |
| Transactions | A date at the start of a line (03/15/2026, 3/15/26, 2026-03-15, Mar 15, 2026, 15 Mar 2026, or 03/15 with the year from the statement period line, across a year end), a description, and an amount with cents; a second amount on the line is the running balance. Spreadsheet exports with date and amount (or debit and credit) columns. Money out is negative: as written (minus, parentheses, a trailing minus, DR), under a Withdrawals or Debits heading, or as the running balance shows; otherwise an unsigned amount counts as money in. Lines in a daily balance section aren't transactions. Impossible dates are skipped; a document whose dates can only be day-first is read day-first |
| Totals | Money in, money out and net, and the same by month, per document and across the Matter's financial documents |
| Worth a look | Each flag names its rule, says why with the numbers, and quotes the exact line: the **running balance** doesn't follow; **opening plus transactions** doesn't reach the closing balance (transactions missing or misread); a **possible duplicate** (same amount to the same payee within 3 days, or the same amount the same day); a **round amount** (a whole hundred dollars, $1,000 or more); **unusually large** (5 times the typical transaction and $500 or more); **cash** withdrawals; **transfers** and payment apps (wire, Zelle, Venmo, PayPal, Cash App); a **gap** of more than 31 days with no transactions (a statement may be missing). The rules are listed on the page |
| Across documents | The same transaction (date, amount, description) in two documents is listed: overlapping statements, a copy, or worth checking |
| Huis suggests | Nothing is decided by Huis or stored: the analysis is worked out from the documents each time it's opened. The page asks for every figure to be checked against the document |
| Who | Firm staff who can see the Matter, for the evidence they can see (ethical walls and folder rules apply). Clients and other outside users never see it. Marked attorney work product |
| Records | Opening one document's analysis is opening the document: recorded in its chain of custody and the audit log, as in the viewer. The Matter summary is recorded once in the audit log (how many documents, nothing else) |

**Known limits:** amounts need cents; US-style numbers (1,234.56) only — a document with comma-decimal amounts (1.234,56) says so rather than guessing; an unsigned statement with no running balance and no Withdrawals heading shows everything as money in; the summary reads the Matter's 200 newest documents with text (the first 2 million characters of each).

**Security review 26:** see `SECURITY-REVIEW-2026-11.md`; regression tests in `test/security-review-26.test.ts` (12 tests).

**Tests:** `test/finance.test.ts`, 7 tests: reading a statement (year from the period, signs from the running balance, exact positions, opening and closing), every rule with its reason, a broken balance and a closing that doesn't add up; spreadsheet exports (debit and credit columns, quoted fields) and gaps; ordinary letters not treated as financial and impossible dates refused; limits on hostile input; the Matter summary (only financial documents, walled Matters excluded, the same transaction in two documents, custody and audit); clients, walls and other firms kept out.

