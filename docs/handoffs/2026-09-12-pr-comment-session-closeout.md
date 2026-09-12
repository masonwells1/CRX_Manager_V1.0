# 2026-09-12 — PR-comment audit session: current closeout map

## Confirmed GitHub state

Refreshed against main `791bc3d8614fde6a1ff71ad3300d341563aaab89` on September 12.
Merged means the change landed, not that every historical review or live proof is cleared.

| Session item | Current disposition | Remaining obligation |
|---|---|---|
| #575/#336 compound pending-migration guard | Repair merged in #593; current regression coverage passed September 12 | Hard-rule suite: 79 assertions across 20 repository scenarios; partial Edit/MultiEdit actor checks also passed in correction-guards. No duplicate implementation needed. |
| #22 incomplete warehouse load sheets | Repair merged in #595; current rendered load-sheet tests passed September 12 | Real button path refuses failed/empty item queries and generates after a successful query. No duplicate implementation needed. |
| #582 decimal tolerance | Repair merged in #596; current calculator and rendered JobDetail boundary tests passed September 12 | The three focused files for #22/#582 passed all 154 tests, in addition to the full application suite. No duplicate implementation needed. |
| Commission software report | #592 merged | Reconcile retained follow-ups and current review/proof state; separate from the sales commission workbook task. |
| #198 due-date basis | #591 closed; #589 merged with invoice-date basis settled | Do not restart posting-date behavior or revive #591. |
| Invoice-date season stamping / preview parity | #599 merged September 11 | Original migrations already applied; never reapply or edit them. |
| Filed-season edit guard discovered during #599 review | Not included in #599; absent live | Separate current-main follow-up candidate in `codex/field-app-filed-season-guard-20260912`; finish tests and independent review, then protected PR. No live apply or merge authorized by this closeout. |
| Original audit corrections and residual inventory | Historical packet is stale | Reconcile confirmed defects, exclusions, and ownership into a final evidence-backed disposition. The 152 P2 inventory must not be described as individually cleared. |
| #18 delivery signature disclosure | #637 merged | Do not duplicate the route-bound signature repair; retain observed regression coverage. |
| #151 soft-deleted customer-document bytes | Follow-up #635 open, merge state DIRTY at head `a50130bfed7071307db8af2588592de00604afef` | Reconcile current ownership; do not call it shipped or take over its checkout. |
| Commission-related invoice intent follow-up | #638 open, CHANGES_REQUESTED at head `b8cbd2ada29012a7f0413d3865507e7241ecf500` | Existing lane must resolve real review findings; merged #592 does not clear this follow-up. |

## Current-base proof status

September 12: lint/typecheck/build passed; full Vitest run passed all 373 files and 5,243 tests
(123 skipped). Agent-workflow suite, dependencies, documentation drift, migration hard-rule audit,
and diff whitespace checks passed. Disposable guard proof passed cross-season refusal, header/line
rollback, valid edits/restoration, replay drift refusals, and targeted trigger/assertion/restoration
mutations. The corrected full run also executed the registered public preview, penny-exact split
save, same-key retry, group posting, and post-then-save refusal chain, reaching
`SMOKE_PASS_ROLLBACK` and terminal `PREVIEW_SEASON_PROOF_PASS` with exit 0. Correction-guard
suite passed. At this pre-commit checkpoint, exact-commit adversarial proof and protected PR
delivery remain pending; no live apply or merge is authorized.

All 29 live invariant predicates ran read-only. Two actor-forgery predicates initially returned
unallowlisted catalog matches (19 and 1 respectively). Current live bodies and owner-only delegates
were independently traced: all 20 are semantic-safe wrapper-forwarding, optional-attribution,
signature-text, or report-filter matches, not actor-forgery holes. Function-specific dated
justifications were added through the existing allowlist mechanism; no predicate was changed.
Subtracting the proposed allowlist from those executed results leaves zero unallowlisted matches.
Independent reviewers checked all 20 dispositions against the current live function bodies and
delegates and found no real forged-actor path hidden by an exemption. Exact-commit review remains
required before final release clearance.

The expanded registered business chain initially failed fixture setup on governed product
creation, authentication, missing cost basis, and a mistaken product-version column name.
These failures were not counted as passes. Its fixture now authenticates consistently with
other smoke tests and establishes a positive cost through the real public pricing preview/apply
route, using `products.pricing_version` for the submitted row version. No guard is disabled.
The corrected chain subsequently reached both its terminal rollback and prover pass.
Its older posting-layout assertion also failed after save: current public group posting delegates
to the owner-only `_post_invoice_group_customer_scope_impl`. Read-only live inspection confirmed
the ordered/anchor locks remain across both layers. The fixture now checks both layers plus the
private EXECUTE restriction, without deleting the locking/idempotency assertions.

## Boundaries

Preserve root dirty work and the older `C:/CRX_pr599` candidate. Do not push the merged
PR branch. Do not apply the stale root preview migration. Do not take over another session's
provenance branch, erase historical disclosure, or reopen deliberately capped guard work.

This document is not itself clearance for a HIGH finding. Fixes must retain
executable prevention checks and observed behavior. The session is not yet archive-ready.
