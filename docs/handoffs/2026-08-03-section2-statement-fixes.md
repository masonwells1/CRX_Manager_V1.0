# Section 2 Statement Fixes

## WHERE

- Worktree: `section2-statement-fixes-20260803`
- Branch: `codex/section2-statement-fixes-20260803`
- Base: `origin/main` at `a74cc4b3` (refreshed during the release gate)
- Supabase project: `rhyzpcqhnizqbxphqdkr`
- Pull request: `#305` (open; review fixes in progress)

## GOAL

Fix the three proven Section 2 statement defects: include overdue-only customers in month-end batches, stop finance-charge double counting, and disclose unapplied credit memos without changing the settled gross-AR convention. Done means the new migration, PDF/email wording, and regression proof agree and the full local verification gate is green.

## PROVEN

- The merged Section 2 correction is on `origin/main` at `cd0ff21c`; follow-up commit `2f6e5534` contains the page-level batch fail-closed correction on this isolated branch.
- Live catalog evidence on 2026-08-03 confirms one `generate_batch_statements(date,uuid,text,text)` overload with a posted-only selector.
- Live catalog evidence confirms `get_detailed_statement_data(uuid,date,text)` returns `net_due_cents = invoice balance + linked finance charge`, even though generated invoice balance already includes the charge invoice amount.
- Live `get_ar_aging(date)` defines open credit as the absolute value of posted negative credit-memo balances; the application deliberately reports gross positive invoices separately.
- Graphify was rebuilt at `a8528a00`; the scoped statement/RPC query was used to narrow the ARaging, MonthEndClose, PDF, email, and database proof surfaces before source and live checks.
- The migration re-emits both statement RPCs, binds the batch actor to `auth.uid()`, restates API grants, and fails closed if the reviewed live body hashes or overload counts drift.
- A prior candidate-migration revision, before the Central-business-date and posting-interval corrections, reached exact `SMOKE_PASS_ROLLBACK` after proving overdue selection, finance-charge single counting, open-credit disclosure, net account position, and forged-actor rejection.
- Post-smoke live readback for that prior revision confirmed both original production function hashes remained unchanged, each function still had one overload, and zero `[SMOKE]` customer/invoice fixtures remained.
- Post-push review found two additional blockers: historical credit availability was calculated from the current generated balance, and the overdue-only smoke fixture also had a posted charge. Commit `5d02ff30` corrected both and passed the full local hook plus replacement migration review.
- Exact-SHA review of `5d02ff30` then found that current status could hide an invoice or credit memo voided after the statement cutoff. The local correction now derives as-of eligibility from `posted_at`, `voided_at`, and `deleted_at`, and adds a post-cutoff-void regression. It still needs replacement review and execution proof.
- Exact-SHA review of `037b94dc` correctly found that generic `void_invoice` zeroes the mutable amounts, so timestamps alone cannot reconstruct the pre-void balance; it also found that `posted_at` remained nullable. The local correction now fails detail and batch generation closed when a later generic void makes reconstruction unsafe, exercises the real void RPC, and adds a validated database constraint requiring `posted_at` for posted/paid/overdue/voided rows.
- Exact-SHA review of `3c16ab4a` correctly found that raw `timestamptz::date` casts used the database timezone instead of CRX's America/Chicago business date. The local correction converts every posting, application, reversal, void, and deletion boundary in both statement RPCs to Central time and adds a UTC-midnight-crossing regression.
- Exact-SHA review of `d55154ad` found that a later unpost makes an invoice editable, so its current contents cannot prove a historical statement. The local correction fails detail and batch generation closed for that case and adds a regression with a changed post-unpost amount.
- Exact-SHA review of `1920c240` found that a later cash-payment reversal offset by a later credit application could leave today's balance unchanged while overstating the cutoff debt. The local correction now rejects historical detail and batch statements when later cash, prepay, or write-off activity makes the mutable balance unsafe, and adds the exact payment-void-plus-credit regression.
- Both content-bound migration reviewers and the exact-SHA adversarial reviewer returned CLEAN for `a3e68b42`; all PR checks then passed.
- Final PR review found that the page-level print/email loops could silently continue after a deliberate historical-reconstruction rejection. Batch PDF now aborts on any selected-customer RPC error, and batch email preflights every selected statement before sending the first message.
- Type-contract and PDF-output reviewers returned CLEAN. Compliance review found one MEDIUM payment-demand wording defect for credit-covered accounts; it was fixed with a negative-net fixture and the focused re-review returned CLEAN.
- All 21 live database invariant predicates returned zero unallowlisted violations.
- Current-base verification passed: full Vitest suite, billing 473/473, regression 166/166, TypeScript, zero-warning ESLint, production build, agent-workflow tests, migration SQL scan, local drift suite, documentation drift guard, and real jsPDF render assertions for positive, zero, and negative account positions.
- Statement PDF/email generation now fails closed when either balance-disclosure field is absent, so a frontend-first deployment cannot turn a legacy RPC payload into a false zero-credit payment request.
- Batch statement authorization now runs before the customer selector, including the empty-result case, so non-admin callers cannot infer whether qualifying receivables exist.
- Fresh Supabase `list_migrations` returned 933 live rows at high-water `20260803010917`, strictly below candidate `20260803131507`.

## WRITTEN, NOT PROVEN

- The page-level batch fail-closed correction still needs replacement exact-SHA review and PR checks. The migration SQL is unchanged from its clean content-bound reviews.
- The current migration revision has not received rollback-only live behavior proof.
- A post-deploy signed-in statement PDF/email observation cannot occur until the code is published and the migration is applied.

## REMAINING

- Obtain replacement exact-SHA adversarial proof, then push the follow-up through protected PR checks and merge.
- Live migration apply, B7 filename reconciliation, and post-apply catalog/behavior checks.

## APPROVAL STATE

Mason approved the protected PR pipeline in the current task. That authorization does not cover applying the live migration or changing live data.

## GATES AND BLOCKERS

- Money/database changes require migration review and rollback-only proof before live apply can be considered.
- Applying the migration live requires a fresh explicit approval in this interactive task.
- Pushing/merging follows the protected-branch PR pipeline and exact-SHA adversarial review.

## FIRST ACTION

Obtain replacement exact-SHA proof for the follow-up branch before pushing it.

Verify current state from Git, disk, and connected services before trusting this handoff; it may be stale when read.
