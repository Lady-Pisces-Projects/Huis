# Phase 10 — Commercial SaaS, Enterprise & White Label

**Status:** Part 1 (subscriptions, the 7-day trial, seats and usage) built and tested; independent security review 24 in progress.

## Plan
| Part | What | Status |
|---|---|---|
| 10.1 | **Subscriptions and licensing**: plans (7-day free trial, Professional at $237 per seat per month, Enterprise by agreement), seats, trial limits, usage, what happens when a trial ends or a payment is late, the firm's **Subscription** page, and a Huis-only command to set a firm's plan | Built and tested; review 24 in progress |
| 10.2 | **Online payment**: subscribe, add seats and pay by card or invoice through a payment processor; receipts | Needs a payment processor (O-11) |
| 10.3 | **Firm billing**: timekeeping on Matters, rates, expenses, invoices to clients (trust/IOLTA money through a legal payment processor, O-10) | Next |
| 10.4 | **Financial evidence analysis**: reading bank statements, invoices and ledgers filed as evidence (totals, gaps, unusual entries) by fixed, explainable rules | After 10.3 |
| 10.5 | **White label** for large firms: the firm's name, logo and colours, its own address | After 10.4 |
| 10.6 | **Huis admin portal**: firms, plans, seats and trials for Huis staff (replaces the operator command) | After 10.2 |
| 10.7 | **Production security audit** before launch | With production hosting (O-2) |

## Part 1 — Subscriptions and licensing

| Area | What Huis does |
|---|---|
| Plans | **7-day free trial** for every new firm (decision #35). **Professional**: $237 per seat per month (decision #36). **Enterprise**: priced by agreement, for larger firms |
| Seats | Attorneys and firm staff each take a seat (one license, decision #4). **Clients, co-counsel, expert witnesses and other outside people don't.** The trial has 3 seats; a paid firm has the seats Huis set up for it. Adding a person, or turning a license back on, when every seat is taken is refused with a plain message ("All 5 of the firm's seats are in use…"). Disabling someone frees their seat. Two people added at the same moment can't both take the last seat |
| Trial limits | So nobody can load a whole discovery set for free (source spec): **2 GB** of evidence and **100 AI questions a month** (Matter Brain and agent questions). A large upload is refused when it starts, not after it's sent. Paid plans have no storage or AI limits for now (O-11 pricing may add fair-use limits) |
| When it ends | When the trial ends, Huis suspends the account, or a payment is **more than 7 days late**, new work pauses: new Matters, evidence, AI questions, imports and people. **Nothing is deleted or hidden.** Everyone can still sign in, open Matters and evidence, and **export a whole Matter** (decision #37: the firm owns its data). Work already received is finished (a container's files are still unpacked). Everyone in the firm sees a notice saying so; subscribing lifts it at once |
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

**Tests:** `test/subscriptions.test.ts`, 10 tests: seats (outside people free, a freed seat reused, turning a license back on directly refused, the last seat taken by only one of three people added at once, a paid firm's own seats); trial storage (refused at the start of an upload, and when two uploads started together finish); AI questions per month across the firm; a trial that has ended (new Matters, uploads, AI questions refused for everyone, reading and export still working, nothing deleted, subscribing lifts it); a late payment's 7 days' grace and a suspended account; who sees the subscription; plans, seats and dates changed only by Huis and recorded in the audit log; no reading of another firm's account; the operator command's checks.
