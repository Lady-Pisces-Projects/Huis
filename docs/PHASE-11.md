# Phase 11 — Case Outcome Intelligence™

Spec: `docs/source/phase-11-case-outcome-intelligence.md`. Built in parts; each part is tested and independently reviewed before the next.

| Part | What | Status |
|---|---|---|
| 11.1 | **Case strength, the holes in the case, and next steps** (with "Why did Huis say this?" and attorney override) | Built, tested and reviewed (security review 34: 6 findings, all fixed) |
| 11.2 | Discovery gap analysis ("What are we missing?") and opposition analysis ("If I were opposing counsel") | Later |
| 11.3 | **Case value ranges and settlement intelligence** | **Waiting for a source of real verdict and settlement data** (decided by Tracy, 13 November 2026: no dollar values until then) |
| 11.4 | Scenario modelling, what-if, trial readiness | Later |
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
