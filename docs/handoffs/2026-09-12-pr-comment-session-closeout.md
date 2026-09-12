# 2026-09-12 — PR-comment audit session: current closeout map

## Confirmed GitHub state

Refreshed against main `791bc3d8614fde6a1ff71ad3300d341563aaab89` on September 12.
Merged means the change landed, not that every historical review or live proof is cleared.

| Session item | Current disposition | Remaining obligation |
|---|---|---|
| #575/#336 compound pending-migration guard | Repair merged in #593; current regression coverage passed September 12 | Hard-rule suite: 79 assertions across 20 repository scenarios; partial Edit/MultiEdit actor checks also passed in correction-guards. No duplicate implementation needed. |
| #22 incomplete warehouse load sheets | Repair merged in #595; current rendered load-sheet tests passed September 12 | Real button path refuses failed/empty item queries and generates after a successful query. No duplicate implementation needed. |
| #582 decimal tolerance | Repair merged in #596; current calculator and rendered JobDetail boundary tests passed September 12 | The three focused files for #22/#582 passed all 154 tests, in addition to the full application suite. No duplicate implementation needed. |
| #582 server field-acreage guard | #606 merged; recorded applied ledger name `refuse_null_job_field_acres` is present in the refreshed registry | Do not duplicate or reapply the server refusal migration. |
| Retained #582 client decimal follow-ups | OPEN: different-unit `chemLineBillingHazard` uses Number conversion; `JobDetail` fieldsPayload still uses parseFloat after exact guard validation | Preserve current business semantics in focused follow-ups; the original tolerance tests do not clear these distinct paths. |
| Commission software report | #592 merged | Reconcile retained follow-ups and current review/proof state; separate from the sales commission workbook task. |
| #198 due-date basis | #591 closed; #589 merged with invoice-date basis settled | Do not restart posting-date behavior or revive #591. |
| Invoice-date season stamping / preview parity | #599 merged September 11 | Original migrations already applied; never reapply or edit them. |
| Filed-season edit guard discovered during #599 review | Not included in #599; absent live | Separate current-main follow-up candidate in `codex/field-app-filed-season-guard-20260912`; finish tests and independent review, then protected PR. No live apply or merge authorized by this closeout. |
| Original audit corrections and residual inventory | Historical packet is stale | Reconcile confirmed defects, exclusions, and ownership into a final evidence-backed disposition. The 152 P2 inventory must not be described as individually cleared. |
| #18 delivery signature disclosure | #637 merged | Do not duplicate the route-bound signature repair; retain observed regression coverage. |
| #504b peer-envelope unmatched fence | Current main runtime probe loses trailing owner stop text; local branch `codex/peer-envelope-fence-20260908` remains unpushed/no PR | Preserve/reconcile its latest `f7c2b2cd8` candidate on current main and obtain fresh exact-head review. An earlier `0008f53` review returned BLOCKERS, not clearance for the later head. Do not reopen the separate deliberate #504a hyphen rule. |
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

First delivery checkpoint: commit `0f1f5e32a` received clean exact-commit Sol/high proof and
opened PR #652, without merge/apply. Its first application CI failed the indexed migration/history
cross-reference because the new candidate was in a non-numbered descriptive table. The earlier
local correction-guard pass did not include that then-untracked file. Corrected registration to
canonical numbered LOCAL CANDIDATE row 927; staged-index proof, refreshed exact-commit review,
and CI are required before the corrected head can proceed. No safety assertion was relaxed.

All 29 live invariant predicates ran read-only. Two actor-forgery predicates initially returned
unallowlisted catalog matches (19 and 1 respectively). Current live bodies and owner-only delegates
were independently traced: all 20 are semantic-safe wrapper-forwarding, optional-attribution,
signature-text, or report-filter matches, not actor-forgery holes. Function-specific dated
justifications were initially added through the existing allowlist mechanism; no predicate was changed.
GitHub Codex's review of `0f1f5e32a` then reported a real P1: identity-only exceptions could hide a
later loss of the actual actor check, including a different `suspect_param` under the same identity.
Agree; the original key-only subtraction is not final clearance. The follow-up narrows all actor
exceptions to the exact suspect parameter and reviewed public/auth/delegate definition, owner,
canonical direct ACL, and effective Data API EXECUTE contracts from the same PostgreSQL statement
as the detector. All 20 new exceptions and legacy `cancel_delivery` are bound; the unused
`transfer_job_to_invoice` exemption is removed. Missing/changed contracts keep the flag visible.
The shared matcher runs in both linked-psql mode and deterministic captured-MCP adjudication;
printed instructions and canonical preflight no longer authorize key-only comparison.
Focused matcher/actual CLI proof passed 473 assertions. Networkless disposable PostgreSQL proof
passed 31 checks: public actor-check removal and private-helper-only mutation actually permitted
forged attribution in the disposable mutants, and both remained unallowlisted. Direct/inherited
EXECUTE, owner, identity-source and missing-helper drift also failed closed. No detector SQL,
protected fingerprint, live schema/data, or capped lexer rule was changed. Fresh wrapped live
sweeps subsequently executed all 29 statements read-only; the actual captured-result CLI passed
all 29 with zero unallowlisted findings (20 general actor matches and 1 financial actor match,
with every required contract verified). Raw captures remain private and ignored, not public artifacts.
Exact-commit review and CI remain required before corrected-head clearance.

The broad suite then found two recorder exemptions stale in its inventory after the truthful
registry refresh. Read-only ledger inspection confirms the label/stale-recipient repair candidates
are NOT APPLIED, while current live recorders remain owner-only trigger functions. Date-only
discovery had dropped pending source below an unrelated apply-time high-water. Do not remove
the exemptions to conceal that coverage gap. The inventory now reuses the canonical local-candidate
parser and applied-identity normalizer to retain unapplied candidates regardless of date, retiring
them only on actual applied identity. Unknown history, missing source, or missing applied-name
snapshot fails closed. Regression covers below-high-water candidates, renumbered/bare applied
names, and missing/malformed evidence. Independent drift review found a HIGH in the first
yes/no slug lookup: one applied row could settle an unapplied same-slug twin. Agree; replaced
that lookup with the canonical pending guard's exact-stamp spending and per-slug counts over
all same-slug disk peers. Genuine ambiguity throws UNKNOWN; explicit candidates have no date
floor. Re-review is clean and focused RPC contracts passed all 96 tests, including the one-row
twin and ambiguous-pair regressions. The final full-suite rerun passed 373 files and 5,245
tests, with 123 skipped (5,368 total); lint, typecheck and production build also passed.
Fresh exact-commit proof and corrected-head CI remain pending; the earlier failed broad
run is not a pass.

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
