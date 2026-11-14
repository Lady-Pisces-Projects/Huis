# Phase 11 — Case Outcome Intelligence™

Spec: `docs/source/phase-11-case-outcome-intelligence.md`. Built in parts; each part is tested and independently reviewed before the next.

| Part | What | Status |
|---|---|---|
| 11.1 | **Case strength, the holes in the case, and next steps** (with "Why did Huis say this?" and attorney override) | Built, tested and reviewed (security review 34: 6 findings, all fixed) |
| 11.2 | Discovery gap analysis ("What are we missing?") and opposition analysis ("If I were opposing counsel") | Built and tested; through independent review 36 |
| 11.3 | **Case value ranges and settlement intelligence** | **Waiting for a source of real verdict and settlement data** (decided by Tracy, 13 November 2026: no dollar values until then) |
| 11.4 | Scenario modelling (What if?) and trial readiness | Built and tested; independent review 37 next |
| — | Pricing (premium add-on: per-report fee, monthly add-on, or credits) | **Tracy's decision**; part 11.1 is available to every plan for now |

## Part 1 — Case strength, holes and next steps

At **Matter → Case strength** (`/matters/<id>/strength`). Firm staff only (clients and other outside people never see it: attorney work product, marked as such). Worked out each time it's opened, as the person opening it, from what the firm has **confirmed** in Case DNA. **No AI, no model and no guessing** (`src/intelligence/strength.ts`), so it isn't counted as an AI question.

**Not a probability of winning.** The spec forbids presenting a score as one without a validated statistical model, and Huis has none. These are **evidence coverage scores**: how much confirmed, sourced, corroborated evidence covers each element of each claim. The page says so at the top, and every number shows its rule.

| Piece | Rule |
|---|---|
| Element score (0–100) | 40 for a confirmed supporting fact; +25 if cited to a document or email (not only attorney notes); +15 for two independent documents or emails; +10 for a person linked to a supporting fact as a witness ("witness to"; someone merely involved doesn't count); +10 for three or more documents or emails; −20 per confirmed contradicting fact (not below 10 while supported). Attorney notes count as support but never as extra sources; the same document cited twice is one source |
| Claim rating | Insufficient information (no elements) · Weak (an element has no support) · Moderate (an element rests only on notes or unsourced facts, or is contradicted) · Strong (every element cited to a document or email, nothing contradicting) · Very strong (every element scores 90+: two documents or emails and a witness each) |
| Overall | Average of the claims' scores: 85+ Very strong, 65+ Strong, 40+ Moderate, below Weak — **but never better than the weakest claim's rating** (a claim with no elements counts as Insufficient information), so an average can't hide a claim that fails |
| Causation | Elements named with cause, causal, causation, connection, because of or but-for (an element that starts with "Damages" is about damages) |
| Damages | A damage item counts as documented with an amount and a document or email behind it (an attorney note isn't) |
| Breakdown | Legal elements, Documentation, Witness support, Causation, Damages evidence, Credibility, Defense exposure: each a stated formula. **Discovery completeness is shown as not measured** (Huis doesn't track discovery requests yet) rather than invented |
| Confidence | Low / Medium / High from what the scores can rest on: evidence not yet read, suggestions not reviewed, undecided contradictions, claims without elements; the reasons are listed |
| Holes ("Case Gaps") | Fixed rules, each with severity (Critical/High/Medium/Low) and impact (Liability, Causation, Damages, Credibility, Procedure, Discovery): an element with no support (Critical); support only from notes, a contradicted element, a claim with no elements, a supported defense, no damages recorded (High); a single source, damages without an amount or source, undecided contradictions (Medium); no witness, suggestions waiting (Low) |
| Next steps | The most severe open gaps (up to five) with suggested actions: "Find evidence" on the element, then starting points chosen by the element's name (for causation: the decision-maker's communications, the reasons given over time, the approval chain). Labelled as starting points to check against the attorney's strategy and the controlling law |
| Why did Huis say this? | For every element: each point added or taken and why; the supporting facts with their quoted sources (linked); contrary evidence; what's missing; the authorities cited on the element and on the claim (marked verified or not); the assumptions |
| Attorney override | On any gap the current analysis shows (no made-up entries): add context, or set it aside (not relevant or already handled) with a note; put it back later. Set-aside gaps leave the priority list but **don't change the scores** (those stay evidence-based). Firm staff who can change the Matter (not read-only staff); audited (`case_strength.gap_reviewed`) |

**Who sees what.** Same access as Case DNA: firm staff who can see the Matter (row-level security); an item behind an ethical wall the person is outside of isn't counted, and the "Assumptions" say so. Gap reviews are stored in `huis.case_gap_reviews` (0045) with the same access, and are deleted with the firm.

Also in 0045: `huis_security` may delete gap reviews (for an unpaid trial's deletion). Granted per table, never as a default for future tables (that would reach add-only platform tables too); `test/trial-deletion.test.ts` fails if any table with a firm id is missed.

**Performance.** The analysis reads the whole Matter in a fixed number of queries, whatever its size (claims, elements, facts, sources, witnesses, authorities, damages, counts), up to 200 claims and defenses.

**Security review 34:** 6 findings (1 High: the overall rating could read Strong while a claim was Weak), all fixed; regression tests in `test/security-review-34.test.ts` (7 tests). See `SECURITY-REVIEW-2026-11.md`.

**Tests:** `test/case-strength.test.ts` (6 tests): the element scores and their reasons, claim ratings, gaps ranked with suggested actions, no "probability" wording, "insufficient information" instead of an invented score; on a real Matter (uploaded documents, a template claim, facts from passages, a witness): the scores, sources and gaps, setting a gap aside and putting it back (audited, scores unchanged); clients refused, read-only staff can read but not review, nobody outside an ethical wall, and gap reviews can't be written around the rules or for another firm's Matter.

## Part 2 — What are we missing? and If I were opposing counsel

Two pages linked from **Case strength**: `/matters/<id>/missing` and `/matters/<id>/opposition`. Same rules of the road as part 1: firm staff only, attorney work product, worked out each time from **confirmed** Case DNA (`src/intelligence/discovery.ts`), no AI, nothing invented, and every item says why.

**What are we missing?**

| Section | Rule |
|---|---|
| Documents to request | One draft request for production for each claim element with fewer than two documents or emails behind it, worded by the element's name and the claim type (causation: the decision, approvals, people consulted and reasons; adverse action: the personnel file and separation paperwork; damages: payroll and benefits for employment claims, records of each loss otherwise). Requests worded the same are merged and name every claim and element they cover |
| Requests for admission (drafts) | "Admit that …" for each confirmed supporting fact with a document behind it, and "Admit that the document … is a true and correct copy" for each such document (up to 30; once per fact; a fact worded as a question is counted and left for rewording) |
| Deposition targets | People linked (witness to, or involved in) to a fact that contradicts an element, a fact about the adverse action or causation, or a fact supporting a defense; most reasons first |
| Witness gaps | Supported elements with no witness; people in Case DNA not linked to any fact behind a claim element (saying whether they are linked to other facts or events); people Huis suggested that nobody has reviewed |
| Organizations | Organizations in Case DNA, with a reminder that a non-party's records need a subpoena (Huis doesn't know who the parties are) |
| Expert needs | Damages recorded (an economist or vocational expert); a disability element (a medical expert) |
| Authentication | Every document or email the claims rely on, most relied on first, with how it might come in |
| What Huis can't see | Discovery already served and answered isn't tracked yet, so nothing is said about what is outstanding |

Requests are drafts to edit, never to serve as written; the page says so.

**If I were opposing counsel** — arguments the gaps in the confirmed evidence invite, most severe first (by rule, not by how persuasive they are), each with *why they could say it*, *how do we counter it* and *evidence needed*: an element with no evidence (Critical); an element with no document or email behind it, only attorney notes (High); an element standing on one document (Medium); inconsistent evidence on an element (High); each defense with support (High or Medium); another cause for the decision, when a causation element scores under 80 or a defense has support; speculative or unsupported damages; failure to mitigate when nothing records a job search or new work (for non-employment claims: steps to limit the losses). It says what it doesn't check: limitations, exhaustion and other procedural defenses, and how persuasive any fact is.

**Tests:** `test/discovery-opposition.test.ts` (5 tests): drafts only where evidence is thin, admissions from documented facts and their documents, deposition targets with reasons, witness gaps, organizations, experts and authentication; arguments ranked with reasons and counters, mitigation and speculative damages; on a real Matter, from confirmed Case DNA, and refused to a client. `test/security-review-36.test.ts` (9 tests) covers the review 36 fixes.

## Part 4 — What if? and Trial readiness

Both read the same confirmed Case DNA as case strength, with the same access (firm staff who can see the Matter; clients never), and use the same fixed rules (`src/intelligence/scenarios.ts`). No AI, no probability, no dollar values.

**What if?** (`/matters/<id>/what-if`). The attorney picks up to 20 assumptions and the rules are re-run on a copy of the evidence; **nothing is saved and Case DNA doesn't change** (the choices live in the page address only, as ids). Assumptions:

| Assumption | What the rules see |
|---|---|
| A new document or email supports an element | One more supporting fact cited to its own document (each one counts as independent) |
| A witness confirms an element | One more supporting fact with a witness and no document |
| Evidence falls away (excluded, rebutted, can't be proved) | That confirmed fact removed everywhere it's used; for a contradicting fact, the contradiction is resolved |
| A witness becomes unavailable | That person removed as a witness from every fact |

It shows the overall rating before and after, each claim or defense that moves, each element that moves with its new score lines, holes it would close and new holes it would open, and what it doesn't check (whether the evidence exists, is admissible or would be believed: a hypothetical document counts like a real one). An assumption that doesn't belong to the Matter's claims is refused.

**Trial readiness** (`/matters/<id>/readiness`). Only what Huis can measure; anything else is shown as **not measured**, never guessed. The figure is the average of the measured categories, and the lowest one is named as the largest current weakness.

| Category | Rule |
|---|---|
| Discovery | Not measured: Huis doesn't track discovery requests, responses or deadlines |
| Witnesses | Supported claim elements with a witness linked to a supporting fact (whether witnesses are prepared isn't tracked) |
| Exhibits | Claim elements with at least one document or email behind them; unread uploads are mentioned |
| Legal research | Claim elements with a verified authority on the element or its claim (unverified citations don't count) |
| Expert support | People in Case DNA whose role names an expert, against the expert areas the rules flag (damages amounts; a medical element); not measured when none is flagged |
| Damages documentation | Damage items with an amount and a document or email (0 when no damages are recorded) |

Confidence (High / Medium / Low, with reasons) is the same as case strength's.

**Tests:** `test/scenarios.test.ts` (6 tests): assumptions move the right elements and close or open the right holes without touching the evidence; losing a witness or a fact and resolving a contradiction; refusing assumptions from outside the Matter, more than 20, and malformed input; readiness categories, average and weakest; nothing to measure without claims; on a real Matter, nothing is written and a client is refused.

