# Codex independent review packet — `cancel_delivery` quick-delivery prebook fix

**For the batched pre-push Codex cross-review of the nightly-debug large-RPC pass.**
Status: applied LIVE 2026-06-16 (`20260616151122`), NOT pushed to main / not deployed. Mason authorized
"apply now, Codex in the batch" because the Codex CLI was unavailable in the applying session. This packet
exists so Codex can challenge the change before it is ever pushed; if Codex finds a real defect, we fix it
with a follow-up migration (the live function is additive + reversible) before any push.

How to run (when the Codex CLI is available):
```
codex review --base main      # after this branch's changes are committed
# or feed this file to: codex exec "<paste the QUESTIONS section + the migration file>"
```

---

## What changed

Migration: `supabase/migrations/20260616151122_cancel_delivery_release_prebook_on_quick_cancel.sql`
Function: `public.cancel_delivery(p_delivery_id uuid, p_cancel_reason text, p_performed_by uuid, p_idempotency_key text)`

Reproduced VERBATIM from the live baseline (md5 `c6aba47c51aa83653e153399e84d4981`) **except**:
1. DECLARE: added `v_quick_scheduled_exclusive boolean`, `v_prebooked_released integer`, `v_qd_item record`,
   `v_release_qty numeric`, `v_actor_role text`.
2. BLOCK B (the `IF v_delivery.order_id IS NOT NULL` order-status section): added a branch.
3. Result jsonb: added `'prebooked_released'`.
Post-apply md5: `90ba258797cbac40e80673fba0767369`. Single overload. SECDEF + `search_path=public,pg_temp`
preserved; auth/actor/role gates preserved; anon cannot execute.

## The bug it fixes (verified live)

- `create_quick_delivery` reserves inventory by `inventory.quantity_prebooked += qty` (+ a `'prebooked'`
  inventory_transactions row) against an auto-created order it owns **exclusively**; the delivery is created
  `scheduled`, `is_quick_delivery=true`.
- `confirm_delivery` flips `scheduled→in_progress` and touches **no inventory** (verified — its body only
  updates status + activity_feed + a notification). So the prebook is still 100% held at `in_progress`.
- Old `cancel_delivery`: the inventory-restore block is gated to `status IN ('completed','in_progress')` AND
  `quantity_delivered>0`. A quick delivery cancelled while `scheduled` (or `in_progress`, where
  `quantity_delivered` is still 0) released **nothing**, and BLOCK B set its auto-order to `'confirmed'`
  (has-remaining branch). Result: a **zombie `confirmed` order with a stranded prebook** → Net Free
  (available − holds − prebooked) understated indefinitely. (`complete_delivery` already releases the prebook,
  so `completed` cancels are handled by the existing restore block — out of scope.)

## The fix (inline; Option A intent, NOT `PERFORM cancel_order`)

`cancel_order` is **admin-only** ("Only admins can cancel orders"); `cancel_delivery` allows `sales_rep`. So a
literal `PERFORM cancel_order(...)` would make a sales_rep quick-delivery cancel abort — a regression. Instead,
inside the existing `app.admin_override` bracket, for `is_quick_delivery AND status IN ('scheduled','in_progress')`
AND the auto-order is exclusive to this delivery (`NOT EXISTS` another non-cancelled/voided delivery on it):
1. Release the prebook this delivery reserved — per `delivery_items` line:
   `quantity_prebooked = GREATEST(quantity_prebooked - GREATEST(quantity - COALESCE(quantity_delivered,0),0), 0)`
   + a `'released'` inventory_transactions row (mirrors `cancel_order`'s release block).
2. `UPDATE orders SET status='cancelled'` (instead of the `confirmed`/`partially_fulfilled` zombie branch).
3. `UPDATE commissions SET status='cancelled', commission_amount=0 WHERE order_id=... AND status='pending'`.
4. `INSERT financial_audit_log` `'order_cancelled'` row (parity with `cancel_order`).
The draft invoice is already cancelled by `cancel_delivery`'s existing invoice loop (left untouched).
If the order is NOT exclusive, the branch is skipped and the original BLOCK B logic runs (no wrongful cancel).

## Validation already done (this session)

- rls-security-reviewer + migration-drift-reviewer: **clean** (0 BLOCKER/HIGH/MED). Both confirmed columns,
  CHECK supersets, overload=1, `commissions` correctly NOT given `updated_at`, append-only audit respected.
- Rolled-back live functional smoke (zero footprint), 3 scenarios + a post-apply re-smoke:
  - S1 admin / scheduled → order=cancelled, prebook released to baseline, `released` txn=1, invoice=cancelled,
    commission=cancelled.
  - S2 sales_rep / scheduled → order=cancelled, prebook released, **NO auth error** (regression guard).
  - S3 admin / in_progress → order=cancelled, prebook released, `released` txn=1.

## QUESTIONS for Codex (challenge these)

1. **Scope extension to `in_progress`.** I extended the parked `scheduled`-only spec to also cover
   `in_progress`, on the basis that `confirm_delivery` releases no inventory. Is there ANY quick-delivery path
   that, between `confirm_delivery` and `cancel_delivery`, would have already decremented `quantity_prebooked`
   (so my release double-counts)? Consider partial flows, `complete_delivery` interplay, or any trigger.
2. **`quantity_delivered` assumption.** I release `GREATEST(quantity - COALESCE(quantity_delivered,0),0)`.
   For scheduled/in_progress quick deliveries `quantity_delivered` should be 0. Is there a path where a
   `scheduled`/`in_progress` quick delivery has a nonzero `delivery_items.quantity_delivered`?
3. **Exclusivity guard.** `NOT EXISTS (other delivery on the order with status NOT IN ('cancelled','voided'))`
   — is this the right condition to avoid cancelling a hand-linked/shared order, and does it have a TOCTOU
   gap given the delivery row is `FOR UPDATE`-locked but the order is not?
4. **Order-status transition.** The `UPDATE orders SET status='cancelled'` rides the function's existing
   `app.admin_override`. Is `confirmed→cancelled` (and any enforcer on `orders.status`) satisfied that way,
   and is there a draw-ledger / inventory_holds concern for a quick-delivery order (it has no `quote_id`)?
5. **Audit/commission parity.** Is writing a `financial_audit_log 'order_cancelled'` row here (with
   `total_impact_cents=0`) correct, given `cancel_delivery` otherwise logs only to `activity_feed`? Any
   double-count vs the order's lifecycle?
6. **Idempotency replay.** On an idempotent retry (same `p_idempotency_key`), the cached result short-circuits
   before any mutation — confirm the release/cancel cannot run twice.
