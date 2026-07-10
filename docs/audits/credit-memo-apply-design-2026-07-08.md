# Design review: `apply_credit_memo_to_invoice` (CRX Manager)

**Status:** DESIGN ONLY — no code written yet. Reviewed by Codex before a fresh build session.
**Date:** 2026-07-08 · **Source finding:** business-workflow-review-2026-07 §3.2 / findings.json:1362-1365
**Supabase project:** rhyzpcqhnizqbxphqdkr (live). **Owner:** Mason (zero coding experience).

## The problem (verified against live DB 2026-07-08)
`issue_return_credit` creates a `credit_memo` invoice with `status='posted'` and `total_amount_cents = -v_total` (NEGATIVE). `allocate_payment` rejects non-positive amounts, and no path applies a credit memo to an open invoice. Result: customer owes $10,000, returns $2,000, mails an $8,000 check → the office allocates $8,000, the $10,000 invoice keeps a $2,000 balance, ages, flips `overdue`, and fires dunning emails, while a −$2,000 credit memo floats forever. Net AR is correct (10000 + (−2000) = 8000) but the individual invoice ages and dunns, and the credit is never usable.

## Verified live-schema facts (do not re-derive — confirmed 2026-07-08)
- `invoices.balance_cents` is `GENERATED ALWAYS AS ((((total_amount_cents - paid_amount_cents) - prepay_applied_cents) - write_off_cents)) STORED`.
- CHECK constraints on `invoices` (5): `invoices_balance_non_negative = CHECK ((invoice_type = 'credit_memo') OR (balance_cents >= 0))`; `invoices_total_non_negative = CHECK ((invoice_type='credit_memo') OR (total_amount_cents >= 0))`; `invoices_paid_non_negative = CHECK (paid_amount_cents >= 0)`; `invoices_discount_earned_nonneg`; `invoices_status_check IN (draft,unposted,posted,paid,overdue,voided,cancelled)`. NOTE: there is **no** non-negativity CHECK on `prepay_applied_cents` or `write_off_cents`.
- **No DB views depend on `invoices.balance_cents`** (pg_depend query returned empty). **No index references `balance_cents`** (pg_indexes ILIKE query returned empty).
- **0 credit_memo invoices exist live**; ~0 posted invoices/payments overall. No historical data to convert; no live-data risk.
- All four levers in the balance formula only SUBTRACT — there is no lever that can raise a credit memo's negative balance back toward 0. This is the crux.
- Existing proven mirror `apply_prepay_to_invoice(p_prepay_credit_id, p_invoice_id, p_amount_cents, p_performed_by, p_idempotency_key)`: `auth.uid()` gate → `AUTH_REQUIRED`; `p_performed_by` actor gate → `ACTOR_MISMATCH`; role gate admin/sales_rep → `INSUFFICIENT_ROLE`; op-scoped idempotency via `check_idempotency`/`save_idempotency`; `FOR UPDATE` locks on credit + invoice; **same-customer guard** (`CUSTOMER_MISMATCH`); invoice must be `posted`/`overdue`; `check_period_open(CURRENT_DATE)`; amount > 0, ≤ credit balance, ≤ invoice balance; inserts `prepay_applications`; reduces target via `prepay_applied_cents += X` and sets `status='paid'` when balance hits 0; writes `financial_audit_log` (`operation_type='prepay_applied'`). SECURITY DEFINER, `SET search_path = public, pg_temp`.
- `issue_return_credit` inserts the credit memo (`invoice_type='credit_memo'`, `status='posted'`, `total_amount_cents = -v_total`, `paid=0`, `prepay_applied=0`) and writes `financial_audit_log` `credit_memo_created`. It is idempotent + actor-gated.

## Proposed design — Option A (RECOMMENDED): keep credit memos as documents, make them applicable
Single new signed column that lets the balance formula move a memo up toward 0 and a target down, as one double-entry.

**Migration:**
1. `ALTER TABLE invoices ADD COLUMN credit_applied_cents bigint NOT NULL DEFAULT 0;`
2. Redefine the generated column (drop + re-add; no dependent views/indexes to block it):
   `balance_cents GENERATED ALWAYS AS ((((total_amount_cents - paid_amount_cents) - prepay_applied_cents) - write_off_cents) - credit_applied_cents) STORED`.
   Because the new column defaults 0, **every existing invoice's balance_cents is byte-identical** after the redefine; only invoices the new RPC touches change.
3. New table `credit_memo_applications (id uuid pk, credit_memo_id uuid → invoices, target_invoice_id uuid → invoices, amount_cents bigint CHECK > 0, applied_by uuid, applied_at timestamptz default now())` with RLS (SELECT/INSERT admin+sales_rep; no UPDATE/DELETE — append-only), anon revoked.
4. New RPC `apply_credit_memo_to_invoice(p_credit_memo_id uuid, p_target_invoice_id uuid, p_amount_cents bigint, p_performed_by uuid DEFAULT NULL, p_idempotency_key text DEFAULT NULL)`, SECURITY DEFINER, `SET search_path=public,pg_temp`, mirroring `apply_prepay_to_invoice`:
   - `AUTH_REQUIRED` / `ACTOR_MISMATCH` / role admin|sales_rep `INSUFFICIENT_ROLE`; op-scoped idempotency.
   - `FOR UPDATE` lock BOTH invoices. Order the two locks deterministically (e.g. by id) to avoid deadlocks.
   - Guards: same `customer_id` (`CUSTOMER_MISMATCH`); memo row must be `invoice_type='credit_memo'` AND `status='posted'` (reject voided/cancelled); target must be `invoice_type <> 'credit_memo'` AND `status IN ('posted','overdue')`; `check_period_open(CURRENT_DATE)`; `p_amount_cents > 0`.
   - Remaining credit on memo = `-(memo.balance_cents)` (its balance is ≤ 0; remaining = its current magnitude). Require `p_amount_cents ≤ remaining` (`AMOUNT_EXCEEDS_CREDIT`) and `p_amount_cents ≤ target.balance_cents` (`AMOUNT_EXCEEDS_BALANCE`).
   - INSERT `credit_memo_applications` row.
   - `UPDATE invoices SET credit_applied_cents = credit_applied_cents + X, status = CASE WHEN new_balance <= 0 THEN 'paid' ELSE status END WHERE id = target` (target balance drops by X; stays ≥ 0 by the guard, so `invoices_balance_non_negative` holds).
   - `UPDATE invoices SET credit_applied_cents = credit_applied_cents - X, status = CASE WHEN new_balance = 0 THEN 'paid' ELSE status END WHERE id = memo` (memo balance rises from −2000 toward 0; memo is `credit_memo` so exempt from the non-negative CHECK; storing negative `credit_applied_cents` on the memo is intentional).
   - Net across the two rows: target −X, memo +X → **customer AR sum unchanged** (correct: applying an existing credit to an existing debt is net-zero on total AR; it only moves the shorted invoice to paid and consumes the credit).
   - `financial_audit_log` `operation_type='credit_memo_applied'`, `total_impact_cents = X` (or 0 — reviewer to advise sign convention), linking memo + target.
   - `save_idempotency`; RETURN the application id.
   - Revoke EXECUTE from anon; grant authenticated (in-body role gate is the real guard).
5. `src/types/index.ts`: add `credit_applied_cents` to the invoice type + a `CreditMemoApplication` interface.

**Frontend:** an "Apply Credit" action on InvoiceDetail — for a credit memo, pick an open same-customer invoice and an amount; for a normal invoice, apply an available same-customer credit memo. Mirror the existing prepay-application UI. `assertRpcResult` on the call.

## Option B (NOT recommended): convert return credits into prepay_credits
Change `issue_return_credit` to create a `prepay_credits` row (not / in addition to the negative credit_memo invoice) and reuse `apply_prepay_to_invoice`. Zero balance-formula change, fully proven application path. Trade-off: a "credit memo" stops being a distinct document and mixes into prepay reporting; and to avoid double-counting, the negative credit_memo invoice must then NOT also carry the credit — i.e. `issue_return_credit` semantics change.

## Specific questions for Codex (adversarial)
1. Is redefining the STORED generated `balance_cents` (drop + re-add, new column defaults 0) genuinely value-preserving for all existing rows, and are there hazards beyond views/indexes (e.g. triggers referencing `balance_cents`, `RETURNING`, logical replication, `pg_stats`, foreign tables) we must handle?
2. The double-entry uses a **signed** `credit_applied_cents` (+X on target, −X on memo). Is a single signed column the right call, or are TWO columns (e.g. `credit_received_cents` on targets, `credit_issued_cents` on memos) safer/clearer? Any CHECK we should add without breaking the memo side?
3. Any way this **double-credits or loses money** (net AR drift, partial application, re-application, applying a memo to itself, applying across a void, concurrent double-apply, idempotency-key reuse across different (memo,target) pairs)?
4. Void/reversal: if a credit memo is later voided, or a target invoice voided/deleted, what must happen to `credit_memo_applications` and the `credit_applied_cents` on both sides? Do the existing void/delete RPCs need to become application-aware (like the U7 group-aware void)? Name the RPCs.
5. Status handling: is flipping the memo to `'paid'` when fully consumed correct, or should a distinct terminal status be used? Does anything read `credit_memo` + `status` assuming it's never `'paid'`?
6. Interactions: `allocate_payment`, `apply_prepay_to_invoice`, AR aging (`get_ar_aging` and friends bucket `balance_cents > 0`), statements, `check_customer_credit_limit`, month-end/period close — does reducing a target via a NEW lever (not paid/prepay) break any of them?
7. Is Option A or Option B the safer, more correct choice for an ag-retail bookkeeper, given 0 existing credit memos?
8. Anything else that would make this unsafe to apply to a live money schema.
