# Phase 10 — Commercial SaaS, Enterprise & White Label

**Status:** Part 3 (firm billing) built, tested, checked in a real browser and the pre-release check, and through independent security review 25 (1 Medium–High, 1 Medium and 4 Low problems confirmed, all fixed). Part 1 (subscriptions, the 7-day trial, seats and usage) built, tested, checked in a real browser and the pre-release check, and through independent security review 24 (4 Medium and 3 Low problems confirmed, all fixed).

## Plan
| Part | What | Status |
|---|---|---|
| 10.1 | **Subscriptions and licensing**: plans (7-day free trial, Professional at $237 per seat per month, Enterprise by agreement), seats, trial limits, usage, what happens when a trial ends or a payment is late, the firm's **Subscription** page, and a Huis-only command to set a firm's plan | Review 24 done, fixes in |
| 10.2 | **Online payment**: subscribe, add seats and pay by card or invoice through a payment processor; receipts | Needs a payment processor (O-11) |
| 10.3 | **Firm billing**: timekeeping on Matters, rates, expenses, invoices to clients (trust/IOLTA money through a legal payment processor, O-10) | Review 25 done, fixes in |
| 10.4 | **Financial evidence analysis**: reading bank statements, invoices and ledgers filed as evidence (totals, gaps, unusual entries) by fixed, explainable rules | After 10.3 |
| 10.5 | **White label** for large firms: the firm's name, logo and colours, its own address | After 10.4 |
| 10.6 | **Huis admin portal**: firms, plans, seats and trials for Huis staff (replaces the operator command) | After 10.2 |
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

