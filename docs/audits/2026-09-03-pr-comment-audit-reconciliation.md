# PR Comment Audit Reconciliation

**Date:** 2026-09-03
**Source boundary:** `origin/main` `3a6d52fc721d65863169a489295a94d6b7fec12d`
**Review input:** Claude's adversarial review of the uncommitted Codex handoff
**Disposition:** PARTIALLY CONFIRMED; #198 has an unapplied branch candidate. No other remediation is included.

## Corrected systemic conclusion

The evidence supports a PR close-out failure, not that Codex comments were categorically unread. Across
1,437 Codex threads, only six received a human reply; however, 75 of the 97 P1 findings were fixed
later or superseded, and GitHub's unresolved-thread state often outlived the code defect. The useful
conclusion is that the repository lacked a dependable before-merge step that recorded each Codex
finding as fixed, refuted, or explicitly accepted. The unresolved-thread percentage is not a valid
proxy for the current-defect rate.

## Reconciled current findings

| ID    | Corrected disposition                                                                                                                                                                                                                                                                          | Current evidence                                                                                                                                                                                                                                         | Action                                                                                                                                                      |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #198  | **HIGH — confirmed.** Both effective invoice posting writers default `due_date` from `invoice_date`, while transfer-created invoices already carry a system-generated `CURRENT_DATE + 30` value that null-only fallback mistakes for an override. Unpost also retains that stale system value. | Approved Chicago posting-date contract in `docs/plans/invoice-due-dates-net30-spec-2026-07-16.md`; live read-only `pg_proc` inspection on 2026-09-03; exact-commit Codex review of the first candidate caught the transfer and repost paths before push. | Branch candidate `20260903193000_align_invoice_due_date_to_chicago_posting_date.sql` now adds due-date provenance and lifecycle coverage; not applied live. |
| #151  | **HIGH — confirmed.** The uploader branch bypasses the active-metadata condition after a soft delete.                                                                                                                                                                                          | `supabase/migrations/20260717013415_crm_customer_documents.sql:228`–`:239`.                                                                                                                                                                              | Queued; not changed here.                                                                                                                                   |
| #575  | **HIGH — confirmed checker gap.** Revised pending migrations are warned about but not analyzed for new-table RLS.                                                                                                                                                                              | `scripts/check-migration-hard-rules.mjs:249`–`:289`.                                                                                                                                                                                                     | Queue with #336 as one defense-in-depth change; not changed here.                                                                                           |
| #18   | **HIGH — confirmed.** A failed URL refresh can leave the prior delivery's signed-signature URL in state.                                                                                                                                                                                       | `src/pages/DeliveryDetail.tsx:110`, `:378`, `:1399`, and `:2100`; no reset exists.                                                                                                                                                                       | Queued; not changed here.                                                                                                                                   |
| #22   | **MED — confirmed.** The load-sheet query ignores its error and converts missing data to an empty item list.                                                                                                                                                                                   | `src/pages/Deliveries.tsx:706` and `:737`.                                                                                                                                                                                                               | Queued; not changed here.                                                                                                                                   |
| #336  | **MED — confirmed checker gap.** The hook scans only supplied `content`/`new_string`; a body-only edit carries no function header for the scanner.                                                                                                                                             | `.claude/hooks/actor-binding-check.mjs:111` and `:123`.                                                                                                                                                                                                  | Queue with #575; not changed here.                                                                                                                          |
| #504b | **MED — confirmed.** Fenced-code stripping runs before peer-envelope stripping, so an unterminated peer fence can consume later Mason text.                                                                                                                                                    | `.claude/hooks/prompt-source-lib.mjs:100`–`:145`.                                                                                                                                                                                                        | Queued; not changed here.                                                                                                                                   |
| #582  | **MED — confirmed fail-closed mismatch.** JavaScript binary floating point can reject a PostgreSQL-valid quantity at the exact tolerance boundary; this blocks a valid save but does not corrupt money.                                                                                        | `src/lib/chemCalculator.ts:117`–`:118` and `:151`–`:158`; counterexample `quantity=0.1001`, `rate=0.0501`, `acres=2`.                                                                                                                                    | Queued; not changed here.                                                                                                                                   |

## Corrected or withdrawn claims

| ID    | Corrected disposition                                                                                                                                                                                                                                                                                                           | Evidence / boundary                                                                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #124  | **REFUTED as current.** Owner-unknown actions go to `needs_attention`; a different user's action is skipped; actor/owner mismatch is checked again before execution.                                                                                                                                                            | `src/lib/offlineSync.ts:90`–`:109` and `:148`–`:167`. Remove from the current backlog.                                                                                               |
| #252  | **REFUTED as current.** The current workflow uses positive citation shapes; prose such as “the latest update looks correct” does not satisfy them.                                                                                                                                                                              | `.claude/workflows/gauntlet-sections-loop.js:88`–`:105`. Remove from the current backlog.                                                                                            |
| #564  | **Overstated.** Only two current residual classes are proven: positional/null-fallback spellings and a raw dynamic sink before a later credited refusal. Quoted-identifier and dollar-tag cases were fixed; loop-target rebinding, lexical shadowing, and post-refusal reassignment were not proven against current predicates. | `docs/audits/2026-09-02-actor-forgery-predicate-triage.md:180`–`:228`. The two proven gaps are already documented owner-scoped checker limitations, not application vulnerabilities. |
| #581  | **Proven provenance/custody gap, not lost source.** The six files are absent from `main` but present on the retained `codex/gauntlet-s9-safety-20260831` branch at `1e1c645e9`.                                                                                                                                                 | Record custody and do not drive another session's branch.                                                                                                                            |
| #504a | **LOW — settled intentional limitation.** Hyphen exclusion avoids the documented false latch.                                                                                                                                                                                                                                   | Leave unchanged unless Mason reopens the decision.                                                                                                                                   |
| #541  | **LOW — settled command-text limitation.** Branch protection remains the actual boundary.                                                                                                                                                                                                                                       | Leave unchanged unless Mason reopens the capped review class.                                                                                                                        |
| #358  | **LOW historical exposure; no code action.** Removing public commit-message history requires separately authorized history rewriting.                                                                                                                                                                                           | Leave unchanged.                                                                                                                                                                     |

## Additional combined finding

#336 and #575 form one defense-in-depth weakness around written-but-unapplied migrations: a
body-fragment edit can escape actor-binding reconstruction, and a revised pending migration can
escape the hard-rule SQL analysis. The broad claim that one ordinary direct edit always passes both
is too strong because the separate local RLS hook catches straightforward `CREATE TABLE` text. The
combined bypass still exists through edit or parser shapes those local hooks do not reconstruct, so
the pair remains the next remediation priority after #198.

## #198 branch proof and boundary

- The first exact-commit Codex proof blocked the branch before push: a null-only fallback missed
  transfer-created single/split invoices and could preserve an old system date after unpost/repost.
- The revised migration adds `invoices.due_date_source` with `system`, `explicit`, and `legacy`
  states. Its conservative backfill changes only that new column: NULL dates become system and
  every pre-provenance non-null date remains legacy. Historical transfer records prove creation but
  not whether an operator later selected the same date, so even an exact +30 shape is not guessed.
  New transfer rows receive system provenance from the new column default.
- The save and field-application billing writers record explicit-versus-system intent. Both posting
  implementations recalculate system dates from `(now() AT TIME ZONE 'America/Chicago')::date`
  plus effective terms. Unpost clears only system dates; explicit and legacy dates remain intact.
- The first frozen-candidate exact-head review blocked publication because both editors still
  inferred provenance from equality with `invoice_date + terms`, and because the whole-table
  provenance backfill would have fired `set_invoices_updated_at`. Both editors now consume
  `due_date_source` directly. The migration pins, suspends, and restores both the exact timestamp
  trigger and `trg_guard_invoice_terminal_order`; the latter suspension prevents valid recovery
  drafts linked to a soft-deleted order from being rejected after their transaction-local recovery
  capability has cleared. An `ACCESS EXCLUSIVE` lock excludes concurrent writers, all other guards
  remain active, and both triggers are restored on success or exception.
- A later exact-head review also blocked publication because preflight incorrectly assumed the
  public `save_invoice` function called `_save_invoice_scoped_impl` directly. Read-only catalog and
  source inspection confirmed the six-function wrapper chain; preflight and postflight now pin
  every adjacent executable edge through the below-cost, intent, governed-split, and provenance
  layers before reaching the scoped implementation.
- That review also caught a customer-facing mismatch: draft field-application PDFs still invented
  a due date from `invoice_date + terms`, even though the authoritative system date is now known only
  at posting. Draft and unposted system PDFs now say `Set when posted`; explicit/legacy dates and
  posted system dates remain dated across the shared builder, both invoice callers, and current and
  legacy layouts. The current layout right-aligns the wider label inside the print-safe margin.
- The next exact-commit review blocked publication on three additional rollout defects. First, the
  historical save delegate could clear an existing explicit/legacy date before the wrapper changed
  its provenance, tripping the immediate CHECK; the wrapper now stages both columns atomically
  before delegation, including the older null-date caller shape. Second, the ambiguous transfer
  backfill was narrowed as described above. Third, a frontend-first PDF query could fail against a
  pre-migration schema and silently lose all billing fields; the shared builder now retries only an
  exact missing-`due_date_source` error without that column and surfaces every unrelated failure.
- Preflight pins all five exact live function bodies, singleton signatures, arguments/defaults,
  return types, owner, security mode, search path, ACL, parser, and current direct/group/batch/save/
  recovery routing. It also pins both trigger identities/functions, their enabled state, and
  table-owner authority. Postflight pins both restored enabled triggers plus the new
  column/constraint, five replacement bodies, behavior, singleton contracts, and grants.
- The five focused migration, PDF-builder, renderer, InvoiceDetail, and FieldApplicationInvoice
  suites pass 141/141, including explicit and legacy dates that exactly equal the terms-derived
  date. Four registered rollback smoke
  chains now cover direct, batch, transferred single/split, per-member group, non-Net-30,
  explicit-override, recovery, and unpost/repost behavior.
- Mutation proof is non-vacuous: changing the normal posting branch from `system` to `explicit`
  failed both the behavior and exact-body tests; reversing the editor provenance comparison failed
  both equal-date regressions; replacing the timestamp-trigger disable with enable failed its
  preservation guard; replacing the terminal-order trigger disable with enable failed the migration
  suite; and changing the PDF pending rule from `system` to `explicit` failed five renderer
  assertions. Marking historical non-null dates system, changing the atomic transition predicate
  away from system, and disabling the narrow PDF compatibility retry each failed their focused
  tests. Breaking one public-save wrapper edge also reduced its required pre/post marker count from
  two to one. Restoring each mutant returned the focused suites to green.
- The database smokes were not run because they create live fixture rows even though they end in
  rollback. Mason explicitly prohibited a live apply; no live data or schema write occurred.
- The migration remains unapplied and unmerged. Branch publication and PR review do not authorize
  a later live apply.

## Closeout preflight observations

The repository's 29 read-only live invariant predicates were also run during closeout. Twenty-three
rows were initially unallowlisted; focused live triage separated checker noise from current defects:

- All 20 actor-forgery rows were false positives or already documented checker limitations. Twelve
  public wrappers delegate to private, actor-bound helpers; three routines bind the actor before a
  later fail-closed exception handler; four parameter names are not actor inputs; and
  `cancel_delivery` uses the equivalent reversed comparison that the financial matcher misses.
  No current application actor-forgery vulnerability was found.
- `get_commission_balance_report(date)` has one real, unrelated MED availability defect: its live
  body compares a date to `v_today::text`, so the supported current-date report fails with SQLSTATE
  `42883`. It is recorded for a separate migration and was not changed in the #198 lane.
- The Section 9 predicates are stale for the current 12-argument `create_vendor_bill` wrapper and
  the current `get_ap_aging` date expression. These are control gaps, not evidence that either live
  business function currently violates its intended serialization or current-date behavior. The
  applied source that introduced the newer bodies is absent from this checkout, so source custody
  must be restored before those predicates are repaired.
- A concurrent session applied `20260903150000_job_chemicals_persist_driver` while this audit was in
  progress. A fresh read-only ledger check found 993 rows and server version `20260903153402`; the
  #198 candidate remains absent. The schema registry is now stale and must be regenerated by the
  F06 owner lane before schema-aware release gates are trusted.

These observations prevent a green full-preflight claim. They do not invalidate the focused #198
candidate, whose touched functions and migration contract received separate clean reviews.
