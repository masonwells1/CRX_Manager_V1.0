# HANDOFF — build `apply_credit_memo_to_invoice` (hardened, post-Codex)

**Read this first, then the two siblings:** the original design (`credit-memo-apply-design-2026-07-08.md`) and the Codex review (`credit-memo-apply-CODEX-REVIEW-2026-07-08.md`). This doc is the corrected build plan that folds in Codex's 6 blockers. **Owner:** Mason (zero coding). **Route through `/ship`** (money + RLS + generated column). Get Mason's explicit OK before any live migration.

## Decision locked
Build **hardened Option A** (credit memos stay real documents, made applicable via a ledger + a new balance lever). NOT Option B. NOT the original signed-column design.

## The one insight that makes this hard
Adding a 5th lever to the generated `balance_cents` **silently desyncs every RPC that recomputes balance/status inline from the old four levers** (`allocate_payment`, `apply_prepay_to_invoice`, `apply_write_off`, `reconciliation.ts`, `mark_overdue_invoices`). Miss one → a zero-balance invoice stays `posted` and gets dunned. Every such consumer must be updated in the SAME migration set.

## Build order (each step gated: 5 reviewers + Codex + rolled-back live smoke; 0 credit_memos live, so no data backfill)

**1. Schema — the balance lever (Codex #1, #2, #8)**
- `ALTER TABLE invoices ADD COLUMN credit_applied_cents bigint NOT NULL DEFAULT 0 CHECK (credit_applied_cents >= 0);` (non-negative on BOTH row types).
- Redefine generated `balance_cents` = `(total - paid - prepay - write_off) + CASE WHEN invoice_type='credit_memo' THEN credit_applied_cents ELSE -credit_applied_cents END`.
- BEFORE dropping the old generated column: inventory ALL deps (triggers, rules, SQL fns, publications, comments, ACLs — not just views/indexes; confirmed 0 views/0 indexes but re-verify triggers/rules live). Set `lock_timeout`; `ANALYZE invoices` after; assert before/after row-count + per-row balance equality in the same transaction; never `CASCADE` blind.
- **Recreate the dropped CHECK** `invoices_balance_non_negative` (credit-memo exemption) — it depends on `balance_cents` (`20260609130744:30`). Add: credit_memo `balance_cents <= 0`; credit_memo `total_amount_cents <= 0` (existing) stays.

**2. Ledger table (Codex #3)**
- `credit_memo_applications (id, credit_memo_id → invoices ON DELETE RESTRICT, target_invoice_id → invoices ON DELETE RESTRICT, amount_cents bigint CHECK > 0, applied_by uuid NOT NULL, applied_at timestamptz default now(), reversed_at, reversed_by, reversal_reason)`. Indexes on both FKs.
- RLS: SELECT admin+sales_rep. **NO client INSERT/UPDATE/DELETE** — revoke all DML from authenticated/anon; only the SECDEF RPC writes. Add an immutability guard (block UPDATE/DELETE of application rows except the reversal-stamp path).

**3. Apply RPC (Codex #3, #6)** — `apply_credit_memo_to_invoice(p_credit_memo_id, p_target_invoice_id, p_amount_cents, p_performed_by DEFAULT NULL, p_idempotency_key DEFAULT NULL)` SECDEF, search_path:
- Gates: `AUTH_REQUIRED`, `ACTOR_MISMATCH`, role admin|sales_rep, `p_credit_memo_id <> p_target_invoice_id`, same customer, memo=`credit_memo`+`posted`, target=non-credit+`posted`/`overdue`, `check_period_open`, `p_amount_cents > 0`.
- **Idempotency bound to (memo,target,amount):** store request hash in the cached result; on key reuse with different args raise `IDEMPOTENCY_ARGUMENT_MISMATCH` (the prepay mirror does NOT do this — must add).
- Lock both invoices `FOR UPDATE` **ordered by id** (deadlock-safe); re-check remaining AFTER locking. `remaining = -memo.balance_cents`; require `X ≤ remaining` (`AMOUNT_EXCEEDS_CREDIT`) and `X ≤ target.balance_cents` (`AMOUNT_EXCEEDS_BALANCE`).
- INSERT ledger row; `credit_applied_cents += X` on BOTH rows (type-aware formula reduces target, consumes memo).
- Status: set target→`paid` when balance hits 0. Decide memo terminal status (`applied`/`closed` preferred over `paid`; if `paid`, verify every consumer). 
- `financial_audit_log` op `credit_memo_applied`, **`total_impact_cents = 0`** (net-zero; memo already reduced AR at issue), amount+memo+target in `new_values`. Effective application date gated by `check_period_open`. `save_idempotency`.

**4. Reversal + void lifecycle (Codex #4) — the big one**
- New `reverse_credit_memo_application(p_application_id, ...)`: stamps the ledger row reversed, subtracts `X` from both invoices' `credit_applied_cents`, re-opens status if needed, audit-logs, period-checked. Never deletes history.
- Make application-aware: `void_invoice` (`20260707140000:903`), `unapply_credit_memo` (`20260609190725:46` — reverse all active apps atomically or refuse), `unpost_invoice` (`20260625130000:159`), `batch_void_invoices`, `delete_invoices`, and indirect cancel/void paths. Each must reverse or hard-block when credit applications exist.

**5. Four-lever consumers (Codex #5, #6)**
- `mark_overdue_invoices` (`20260332400000:294`): exclude credit memos AND `balance_cents <= 0`.
- Fix inline status/remaining math in `allocate_payment` (`20260706000000:117`), `apply_prepay_to_invoice` (`20260622040000:111`), `apply_write_off` (`20260526151856:507`), `src/lib/reconciliation.ts:286` to include the credit lever (or read `balance_cents` directly). Prove the **$10k − $2k credit − $8k check → paid, balance 0** case end-to-end.
- Consider netting unused memos in detailed statements + `check_customer_credit_limit` (`20260315200000:771`).

**6. Types + invariants + UI (Codex #8)**
- Update `src/types/index.ts:1103` (invoice type + `credit_applied_cents` + `CreditMemoApplication`) AND generated `src/types/supabase.ts:3584`.
- Update invariant sweep `scripts/db-invariant-sweeps/predicates/fin-invoice-balance-identity.sql:5` to the 5-lever identity; add a sweep asserting each invoice's `credit_applied_cents` = sum of its unreversed applications.
- UI: "Apply Credit" on InvoiceDetail (same-customer, mirror prepay UI), `assertRpcResult`.

## Required rolled-back live smokes before apply
partial + full application · credit + payment/prepay/write-off co-settlement · same-key replay + arg-mismatch → `IDEMPOTENCY_ARGUMENT_MISMATCH` · concurrent double-apply · target void + memo void (reversal restores both sides) · closed period rejection · statement + AR-aging correctness · **migration before/after per-row balance equality**.

## Disposition of the Stop-hook "HIGH-without-check" warning
This session produced a DESIGN + REVIEW only (no code). The executable checks (invariant-sweep update + the smoke matrix above) are **owned by the build session**, listed here. Not a gap — deferred by design at Mason's instruction ("do this work in a fresh session").
