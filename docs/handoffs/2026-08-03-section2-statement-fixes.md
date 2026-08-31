# Section 2 Statement Fixes

## WHERE

- Worktree: `section2-statement-fixes-20260803`
- Reconciliation branch: `codex/reconcile-statement-migration-ledger-20260803`
- Base: `origin/main` at `be4917f6`
- Supabase project: `rhyzpcqhnizqbxphqdkr`
- Pull requests: `#305` (statement migration) and `#307` (batch fail-closed UI), both merged

## GOAL

Fix the three proven Section 2 statement defects: include overdue-only customers in month-end batches, stop finance-charge double counting, and disclose unapplied credit memos without changing the settled gross-AR convention. Complete means the migration, PDF/email wording, regression proof, protected PRs, live catalog checks, and B7 ledger reconciliation agree.

## PROVEN

- The Section 2 correction is on `origin/main` via merge `cd0ff21c`; the page-level batch fail-closed follow-up is on `origin/main` via merge `be4917f6`.
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
- Supabase applied the reviewed migration under assigned ledger version `20260803221244`; the ledger retained the submitted name `20260803131507_fix_statement_balance_disclosure`. The repository reconciliation is therefore a filename-only rename to `20260803221244_fix_statement_balance_disclosure.sql`.
- Supabase stored the applied statement with CRLF line endings (37,053 bytes; MD5 `f9666b8ca82dedc37c760f5bf3fcdf4c`). Normalizing only CRLF to LF yields 36,800 bytes and MD5 `4d6ad05cad533ee9e1812aa6bc20fcec`, exactly matching committed Git blob `de6c6bcedcd78d9acd9758eac0eb103146f045e5`.
- The schema registry was regenerated from all six live introspection queries through high-water `20260803221244`. It adds exactly the statement migration name plus the new validated invoice lifecycle constraint to the explicit skipped-constraint review list; generated-column, status-enum, table, and column counts are unchanged.
- A prior candidate revision reached `SMOKE_PASS_ROLLBACK`. No separate rollback-only rehearsal of the final applied revision was captured in this task. Read-only post-apply catalog checks confirm the two private helpers, fixed search paths, revoked public execution, validated constraint, expected overload count, and the two public RPC guards.
- A read-only authenticated-admin execution check exercised both live statement RPCs without changing business data: detail returned `open_credit_cents` and `net_account_position_cents`, while batch generation returned a valid one-customer JSON array.
- PR #305 merged as `cd0ff21c`; PR #307 merged as `be4917f6`. The final UI fix aborts a PDF batch on any rejected statement and resolves every email before the first send, preventing partial delivery.
- Both PR pipelines passed, Vercel deployed successfully, CodeRabbit finished with no actionable finding, the final exact-SHA Sol review was clean, and production returned HTTP 200.

## RESIDUAL

- PR #308 completed the B7 filename reconciliation. Follow-up PR #309 carries the live-derived schema-registry refresh and still requires exact-commit review and protected merge.
- A signed-in browser observation of the production PDF/email flow was not run in this release session; the prior candidate rollback smoke, build, preview, live catalog, and production HTTP checks passed.

## NEXT ACTION

- Finish the schema-registry follow-up PR, then observe one authorized PDF/email batch during the next normal production statement run.

## APPROVAL STATE

Mason approved the protected PR pipeline in the current task. The migration is already present in the live Supabase ledger; no further migration or live-data change is authorized or needed for this reconciliation.

## GATES AND BLOCKERS

- The reconciliation changes no SQL bytes but still follows the protected-branch PR pipeline and exact-SHA adversarial review because it touches migration history.
- No live migration, data mutation, or ledger repair should be attempted; the live ledger is authoritative and already contains the exact reviewed SQL.

## FIRST ACTION

Verify current state from Git, disk, and connected services before trusting this handoff; it may be stale when read.
