# Section 2 Statement Fixes

## WHERE

- Checkout: `C:\Users\mason\.codex\worktrees\section2-statement-fixes-20260803\CRX_Manager`
- Branch: `codex/section2-statement-fixes-20260803`
- Base: `origin/main` at `1ec69419` (refreshed after PR #304 advanced main during the run)
- Supabase project: `rhyzpcqhnizqbxphqdkr`
- Pull request: none

## GOAL

Fix the three proven Section 2 statement defects: include overdue-only customers in month-end batches, stop finance-charge double counting, and disclose unapplied credit memos without changing the settled gross-AR convention. Done means the new migration, PDF/email wording, and regression proof agree and the full local verification gate is green.

## PROVEN

- The branch base is exactly aligned with current `origin/main`; only the uncommitted Section 2 fix is present in this isolated worktree.
- Live catalog evidence on 2026-08-03 confirms one `generate_batch_statements(date,uuid,text,text)` overload with a posted-only selector.
- Live catalog evidence confirms `get_detailed_statement_data(uuid,date,text)` returns `net_due_cents = invoice balance + linked finance charge`, even though generated invoice balance already includes the charge invoice amount.
- Live `get_ar_aging(date)` defines open credit as the absolute value of posted negative credit-memo balances; the application deliberately reports gross positive invoices separately.
- Graphify was rebuilt at `7e036db9`; the scoped query connected `ARaging`, `MonthEndClose`, `DetailedStatementData`, and `statementPdf.ts`, then those edges were verified in source.
- The migration re-emits both statement RPCs, binds the batch actor to `auth.uid()`, restates API grants, and fails closed if the reviewed live body hashes or overload counts drift.
- A combined candidate-migration + live synthetic behavior chain reached exact `SMOKE_PASS_ROLLBACK` after proving overdue selection, finance-charge single counting, open-credit disclosure, net account position, and forged-actor rejection.
- Post-smoke live readback confirms both original production function hashes remain unchanged, each function still has one overload, and zero `[SMOKE]` customer/invoice fixtures remain.
- Both governed migration reviewers returned CLEAN under `gpt-5.6-sol` high reasoning; the content-bound query hash is `a341de0145a1b14e72a2b86a350758dd6d20da193a4b1be19beb4462dcbccb55`.
- Type-contract and PDF-output reviewers returned CLEAN. Compliance review found one MEDIUM payment-demand wording defect for credit-covered accounts; it was fixed with a negative-net fixture and the focused re-review returned CLEAN.
- All 21 live database invariant predicates returned zero unallowlisted violations.
- Current-base verification passed: full Vitest suite, billing 471/471, regression 164/164, TypeScript, zero-warning ESLint, production build, agent-workflow tests, migration SQL scan, local drift suite, documentation drift guard, and real jsPDF render assertions for positive, zero, and negative account positions.
- Statement PDF/email generation now fails closed when either balance-disclosure field is absent, so a frontend-first deployment cannot turn a legacy RPC payload into a false zero-credit payment request.
- Batch statement authorization now runs before the customer selector, including the empty-result case, so non-admin callers cannot infer whether qualifying receivables exist.
- Fresh Supabase `list_migrations` returned 933 live rows at high-water `20260803010917`, strictly below candidate `20260803131507`.

## WRITTEN, NOT PROVEN

- No application or database behavior in this packet remains locally unproven.
- A post-deploy signed-in statement PDF/email observation cannot occur until the code is published and the migration is applied.

## NOT STARTED

- Commit, exact-SHA adversarial review of the complete code diff, protected-branch PR, and merge.
- Live migration apply, B7 filename reconciliation, and post-apply catalog/behavior checks.

## APPROVAL STATE

Mason approved the commit and protected PR pipeline in this task. That authorization does not cover applying the live migration, changing live data, or any separate production permission action. The task remains at the live-migration approval boundary.

## GATES AND BLOCKERS

- Money/database changes require migration review and rollback-only proof before live apply can be considered.
- Applying the migration live requires a fresh explicit approval in this interactive task.
- Pushing/merging follows the protected-branch PR pipeline and exact-SHA adversarial review.

## FIRST ACTION

Commit the current-base local slice, obtain the required exact-SHA adversarial review, then use the protected PR pipeline. Apply the live migration only after Mason explicitly authorizes that separate production action.

Verify current state from Git, disk, and connected services before trusting this handoff; it may be stale when read.
