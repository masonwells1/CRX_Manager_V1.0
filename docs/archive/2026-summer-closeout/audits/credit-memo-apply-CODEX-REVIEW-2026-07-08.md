# Codex adversarial design review — `apply_credit_memo_to_invoice`

**Reviewer:** Codex (codex-cli 0.144.1, `model_reasoning_effort=high`) · **Date:** 2026-07-08
**Design reviewed:** `docs/audits/credit-memo-apply-design-2026-07-08.md`
**Verdict:** 🔴 **BLOCKER — DO NOT BUILD OR APPLY AS WRITTEN.** The double-entry concept is correct and hardened Option A is the right end-state, but 6 blockers must be resolved first.

> Trimmed final answer. The raw Codex session log (it read the cited migrations to ground itself) was discarded to keep the repo lean.

## Findings

### 1. BLOCKER — generated-column migration is under-specified
- "byte-identical" is too strong: dropping/re-adding the STORED `balance_cents` **rewrites the whole table under an ACCESS EXCLUSIVE lock** (values stay numerically equal at `credit_applied_cents=0`, but plan for the lock).
- Dropping `balance_cents` also **drops its dependent CHECK** `invoices_balance_non_negative` (defined at `20260609130744_credit_memo_invoice_constraints.sql:30`). It MUST be explicitly recreated with the credit-memo exemption.
- Inventory ALL dependencies before dropping: triggers/rules, SQL functions, publications/subscriptions, column comments/ACLs — not just views/indexes. Never `CASCADE` without recreating every dropped object. Use a lock_timeout / maintenance window; `ANALYZE invoices` after; assert before/after row counts + balances transactionally.

### 2. BLOCKER — the signed column is unnecessarily dangerous
- Do NOT use `+X` on targets / `−X` on memos: a wrong sign directly changes AR with no DB constraint to catch it.
- Use ONE **non-negative** column on both rows, and make the FORMULA type-aware:
  ```sql
  credit_applied_cents bigint NOT NULL DEFAULT 0 CHECK (credit_applied_cents >= 0)
  -- balance_cents generated:
  (total_amount_cents - paid_amount_cents - prepay_applied_cents - write_off_cents)
    + CASE WHEN invoice_type = 'credit_memo' THEN credit_applied_cents
           ELSE -credit_applied_cents END
  ```
- Add CHECKs: non-credit invoices `balance_cents >= 0`; credit memos `balance_cents <= 0`; credit memos `total_amount_cents <= 0`; ledger reconciliation (each invoice's applied total = sum of its unreversed applications).

### 3. BLOCKER — double-apply / idempotency protection incomplete
- Deterministic dual `FOR UPDATE` locks + re-check remaining AFTER locking = sound concurrency (pattern proven at `20260622040000_apply_prepay_remove_double_decrement.sql:65`). But also:
- Add an explicit `p_credit_memo_id <> p_target_invoice_id` guard.
- **Idempotency must bind to `(memo, target, amount)`** — the prepay mirror just returns the cached result (`20260622040000:58`), so reusing a key for a different pair would silently report the OLD application as success. Store the request fields/hash in the cached result and raise `IDEMPOTENCY_ARGUMENT_MISMATCH` on mismatch.
- Do NOT grant client INSERT on `credit_memo_applications` (a direct insert wouldn't touch either invoice → ledger/header drift). Authenticated = SELECT only; only the SECURITY DEFINER RPC writes. Add `ON DELETE RESTRICT`, indexes on both invoice FKs, `applied_by NOT NULL`.

### 4. BLOCKER — reversal / void lifecycle is missing
Existing reversal paths don't know about the new lever and will violate constraints or strand credits:
- `void_invoice` zeros total/paid/prepay/write-off only (`20260707140000_u7_spray_job_split_group.sql:903`).
- `unapply_credit_memo` only accepts a posted memo and just voids it — doesn't restore targets (`20260609190725_unapply_credit_memo_total_credit_zero.sql:46`).
- `unpost_invoice` checks payments/prepay/write-offs, not credit applications (`20260625130000_unpost_invoice.sql:159`).

Required: add `reverse_credit_memo_application`; make `unapply_credit_memo` reverse every active application atomically (or refuse); make `void_invoice` reverse-or-hard-block inbound (target) + outbound (memo) applications; update `batch_void_invoices`, `delete_invoices`, `unpost_invoice` + indirect cancel/void paths. Never delete application history (record a reversal row w/ actor+reason+date+original id). Period-close checks on both applications AND reversals.

### 5. BLOCKER — status handling incompatible
- `paid` on a credit memo is misleading (`applied`/`closed` clearer); if keeping `paid`, every consumer must explicitly support it.
- `mark_overdue_invoices` marks EVERY past-due posted invoice overdue without checking positive balance or excluding credit memos (`20260332400000_fix_audit_log_actor_and_column_bugs.sql:294`) → a partially-available memo could flip `overdue` then be rejected by the apply RPC. **At minimum, exclude credit memos and `balance_cents <= 0` from `mark_overdue_invoices`.**
- Customer-statement history already includes `paid` (`20260611131549_customer_statement_blind_spots.sql:159`).

### 6. BLOCKER — the old four-lever formulas preserve the original bug (most immediate money failure)
Every RPC that recomputes balance/remaining/status **inline** using only `total − paid − prepay − write_off` will IGNORE the new credit lever and desync:
- `allocate_payment` (`20260706000000_allocate_payment_over_allocation_guard.sql:117`) — $10k invoice − $2k credit, then $8k check → generated balance = 0 but allocate_payment sees $2k remaining, leaves it `posted`; the overdue cron then marks a **zero-balance invoice overdue**.
- `apply_prepay_to_invoice` (`20260622040000:111`), `apply_write_off` (`20260526151856_execute_full_codebase_ultra_review.sql:507`), `src/lib/reconciliation.ts:286`.
- AR aging / reminders / finance charges use `balance_cents > 0` (sound once statuses are correct). Detailed statements + `check_customer_credit_limit` (`20260315200000_emergency_rpc_fixes.sql:771`) ignore unused negative memos → available credit isn't netted until applied.
- Application is **net-zero** on the customer ledger (the memo already reduced AR when issued) — do NOT add another negative ledger txn. `financial_audit_log.total_impact_cents = 0`, put `amount_cents`+memo+target in `new_values` (`credit_memo_applied` is already an allowed op at `20260625130000:91`). Store an effective application date gated by `check_period_open`.

### 7. RISK — Option A vs B
Hardened **Option A** is the correct accounting model (real credit-memo document + traceable ledger + deposits kept separate from return credits). Option B (convert to prepay) is less DDL-invasive but conflates deposits with return credits and is one mistake from double-counting. **Build Option A only after the blockers are resolved.**

### 8. BLOCKER — additional live-schema requirements
- Recreate every CHECK lost with `balance_cents`; add the sign/type constraints (#2).
- Revoke direct INSERT/UPDATE/DELETE on the ledger + DB immutability guard.
- Update BOTH `src/types/index.ts:1103` and generated `src/types/supabase.ts:3584`.
- Update invariant sweep — balance identity documents only 4 levers (`scripts/db-invariant-sweeps/predicates/fin-invoice-balance-identity.sql:5`).
- Require rolled-back live smokes: partial/full application, credit+payment/prepay/write-off settlement, same-key replay + arg-mismatch, concurrent double-apply, target/memo voids, closed periods, statements, aging, migration before/after equality.

## Top 3 MUST-FIX
1. Replace the signed lever with a **constrained non-negative, type-aware** balance formula and safely recreate all generated-column dependencies (esp. the dropped CHECK).
2. Build the complete **immutable application + reversal lifecycle** across `void_invoice`, `unapply_credit_memo`, `batch_void_invoices`, `delete_invoices`, `unpost_invoice`.
3. Update every hard-coded **four-lever** status/formula consumer (payment, prepay, write-off, overdue, reconciliation) and prove the $10k − $2k − $8k case ends at `paid`, balance 0.
