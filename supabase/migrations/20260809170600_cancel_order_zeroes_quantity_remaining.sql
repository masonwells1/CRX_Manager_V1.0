-- REISSUED 2026-08-09 with a forward timestamp.
--
-- Originally written as 20260808150200_cancel_order_zeroes_quantity_remaining.sql, which
-- was merged to main but never applied. Live ledger row 20260809130108
-- (team_note_completion_rpc_and_assignment_notify) landed afterwards, putting
-- every 20260808* file BELOW the applied high-water mark, where
-- .claude/hooks/migration-ordering-lib.mjs correctly refuses it: an older
-- migration applied after a newer one is exactly the 2026-07-15 reversion that
-- guard exists to stop.
--
-- THE EXECUTABLE SQL HAS CHANGED SINCE THE RE-ISSUE. Do not skip the diff.
-- Delta vs 20260808150200 (2026-08-09, after the RLS and drift reviewers):
--   1. The terminal `UPDATE public.order_items SET quantity_remaining = 0` is now
--      gated on the delegated impl having actually cancelled something (see the
--      comment at the UPDATE). Ungated, it also fired on the already-cancelled
--      early return.
--   2. Added `v_result jsonb` to DECLARE and split the delegating RETURN into an
--      assignment plus `RETURN v_result;` so the gate can read the status.
--   3. Added the closing REVOKE, for parity with 20260809170800/170900.
-- Everything else -- signature, SECURITY DEFINER, search_path, the AUTH_REQUIRED /
-- ACTOR_MISMATCH / idempotency / FOR UPDATE / ORDER_HAS_RECEIVED_RETURN guards --
-- is byte-identical to the live body, diffed against pg_proc.prosrc on 2026-08-09.
--
-- The stale 20260808* file is deleted in the same commit so a clean rebuild cannot
-- apply the change twice (the same remedy as docs/reference/migration-history.md
-- row 808 -> live row 811).

-- Zero order_items.quantity_remaining when an order is fully cancelled.
--
-- idempotency-body-check: exempt
--   This is a delegating wrapper, and the check-without-save shape is
--   PRE-EXISTING and unchanged by this migration — it is reproduced verbatim
--   from the live definition of the same function. It reads the idempotency
--   cache to short-circuit a replay, then hands the mutation to
--   _cancel_order_impl_20260714; recording the key is owned by the functions
--   that bracket this one — _cancel_order_provenance_wrapper_20260719 and
--   _cancel_order_idem_impl_20260721 both call
--   _bind_completed_lifecycle_idempotency on the way out. Adding a
--   save_idempotency() call here would double-record the same key.
--
-- Owner decision (Mason, 2026-08-08, docs/manual/DECISION_LOG.md): cancelling
-- an order must not leave stock stranded. Current behavior is a bug.
--
-- SCOPE CORRECTION vs the 2026-08-08 audit (§3 M4) and the remediation
-- handoff. Both said full cancel "leaves quantity_remaining non-zero AND the
-- stock stays prebooked". Tracing the live chain shows only the first half is
-- true:
--
--   cancel_order
--     -> _cancel_order_idem_impl_20260721
--          partially_fulfilled -> _close_undelivered_order_remainder_20260718
--          otherwise           -> _cancel_order_provenance_wrapper_20260719
--                                   -> _cancel_order_split_provenance_impl_20260719
--                                        -> _cancel_order_impl_20260714
--
--   * The partially_fulfilled path ALREADY sets quantity_remaining = 0 and
--     releases prebooked stock with an inventory_transactions row. It needs no
--     change and is deliberately untouched here.
--   * _cancel_order_impl_20260714 ALREADY releases prebooked stock
--     (quantity_prebooked - undelivered, clamped at 0) and writes a 'released'
--     inventory_transactions row. Confirmed live: the one cancelled order
--     carrying a remainder (ORD-2026-0330) HAS its 'released' ledger row.
--   * What no path does on full cancel is zero order_items.quantity_remaining.
--     That is the entire real defect, and it is what this migration fixes.
--
-- The residual quantity_prebooked = 36 on that product is therefore NOT caused
-- by cancel_order and is NOT addressed here. It belongs to the March 2026
-- historical drift recorded as L2 in the audit. Fixing live inventory numbers
-- is a data change, not a code change, and needs its own owner decision.
--
-- Placement: the zeroing goes in _cancel_order_split_provenance_impl_20260719,
-- the narrow function every full cancel passes through, rather than inside the
-- 12KB _cancel_order_impl_20260714.
--
-- CORRECTED 2026-08-09 -- the original version of this note claimed the UPDATE was
-- safe because _cancel_order_impl_20260714's `SET LOCAL app.admin_override` was
-- still in effect when control returned here, bypassing the order_items
-- immutability guards. Both reviewers independently showed that is wrong on two
-- counts, and it was verified against live:
--   * That impl carries a `SET search_path` clause, so PostgreSQL brackets it in
--     its own GUC nest level and discards every SET LOCAL it made at function
--     exit. The override is NOT still set when we get here.
--   * There is no order_items immutability guard to bypass in the first place.
--     Live triggers on the table (read 2026-08-09) are exactly three:
--     after_order_items_change (AFTER, no column scope), guard_order_item_delivery
--     _lineage (BEFORE UPDATE OF order_id, product_id only), and
--     trg_snapshot_order_item_cost (BEFORE INSERT). A quantity_remaining-only
--     UPDATE trips none of them, and the function is SECURITY DEFINER owned by
--     postgres with no FORCE ROW LEVEL SECURITY on the table.
-- The UPDATE therefore succeeds, but for a different reason than first stated.
-- The ONLY thing protecting historical rows is the status gate below. If anyone
-- later adds an order_items immutability guard that honours _is_admin_override(),
-- this write will start failing on the cancel path and will need its own override.
--
-- SIDE EFFECT, deliberate and previously undocumented: after_order_items_change is
-- AFTER INSERT OR UPDATE OR DELETE with no column scope, so this UPDATE now fires
-- trg_recalc_order_totals on a full cancel, which _cancel_order_impl_20260714 never
-- did (it only sets orders.status). The recalc derives the header from SUM of the
-- line prices and costs -- inputs this UPDATE does not touch -- so it is
-- value-preserving on any order whose header already agreed with its lines, and it
-- bumps orders.updated_at. On an order whose header had already drifted it will
-- silently restate the header to the recomputed value. Forward-only: this migration
-- does not touch existing rows, so no already-cancelled order is restated by it.
--
-- Verified live 2026-08-09: order_items.quantity_remaining is a plain writable
-- numeric NOT NULL DEFAULT 0 column (is_generated = NEVER), so this is a direct
-- UPDATE, not a generated-column write, and 0 satisfies chk_oi_qty_remaining.
--
-- Forward-only.

CREATE OR REPLACE FUNCTION public._cancel_order_split_provenance_impl_20260719(
  p_order_id uuid,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'cancel_order');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  PERFORM 1 FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;

  IF EXISTS (
    SELECT 1
    FROM public.returns r
    WHERE r.order_id = p_order_id
      AND r.deleted_at IS NULL
      AND r.status IN ('received', 'credited')
  ) THEN
    RAISE EXCEPTION 'ORDER_HAS_RECEIVED_RETURN';
  END IF;

  v_result := public._cancel_order_impl_20260714(
    p_order_id, p_performed_by, p_idempotency_key
  );

  -- The cancelled order holds no remaining demand. _cancel_order_impl_20260714
  -- has already released the matching prebooked stock and written its ledger
  -- rows; this closes the order-side counter it leaves behind. Restricted to
  -- rows that are actually non-zero so the statement is a no-op on replay.
  --
  -- Gated on the impl having actually cancelled something. Without this gate,
  -- re-cancelling an already-cancelled order (a double-click, or an offlineSync
  -- replay with a fresh idempotency key) would reach this UPDATE and silently zero
  -- the historical remainders this migration explicitly promises not to touch,
  -- ORD-2026-0330 among them. Flagged independently by both the RLS and drift
  -- reviewers on 2026-08-09.
  --
  -- _cancel_order_impl_20260714 has three non-exception exits; verified live
  -- 2026-08-09 against pg_proc.prosrc:
  --   1. RETURN jsonb_build_object('status', 'already_cancelled') -- at offset 1152,
  --      i.e. BEFORE its SET LOCAL app.admin_override at offset 2318. This is the
  --      branch the gate exists for.
  --   2. RETURN v_cached_result from its own check_idempotency replay -- also before
  --      the override. This one is NOT excluded by the gate, and deliberately so:
  --      the cached value was written by save_idempotency carrying status
  --      'cancelled', it commits in the SAME transaction as this UPDATE, so a cached
  --      replay always corresponds to a transaction that already zeroed and the
  --      UPDATE is a no-op against its own `<> 0` predicate. It is also unreachable
  --      today -- _cancel_order_provenance_wrapper_20260719 passes NULL::text for the
  --      key (verified live), so p_idempotency_key is always NULL here, and the
  --      check_idempotency short-circuit above returns before this point anyway.
  --   3. The normal success return, after the override is set.
  -- If anyone ever threads a real idempotency key through the wrapper, re-check
  -- branch 2 before assuming this gate still covers everything.
  IF v_result->>'status' IS DISTINCT FROM 'already_cancelled' THEN
    UPDATE public.order_items
       SET quantity_remaining = 0
     WHERE order_id = p_order_id
       AND COALESCE(quantity_remaining, 0) <> 0;
  END IF;

  RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION public._cancel_order_split_provenance_impl_20260719(uuid, uuid, text) IS
  'Full-cancel path: guards returns provenance, delegates to '
  '_cancel_order_impl_20260714 (which releases prebooked stock and writes the '
  'inventory ledger), then zeroes order_items.quantity_remaining. The zeroing '
  'was added 2026-08-08 per Mason''s decision; see the 2026-08-08 foundation '
  'ultra review §3 M4.';

-- Defensive parity with 20260809170800/170900, added 2026-08-09 on the RLS
-- reviewer's H1. This is a no-op on the normal path -- CREATE OR REPLACE preserves
-- the ACL, and the live ACL is already owner-only (postgres=X/postgres, read
-- 2026-08-09). It matters only if the function does NOT pre-exist (a fresh rebuild
-- or a restore), where CREATE would pick up this database's ALTER DEFAULT
-- PRIVILEGES -- confirmed live: postgres's default function ACL in schema public
-- grants EXECUTE to anon, authenticated AND service_role -- handing anon EXECUTE on
-- a SECURITY DEFINER function that cancels orders and now writes order_items.
-- service_role is included because the live ACL for THIS function does not grant it
-- (unlike _cancel_order_impl_20260714, which does carry service_role=X/postgres) --
-- so the revoke list reproduces live exactly rather than approximating it.
REVOKE ALL ON FUNCTION public._cancel_order_split_provenance_impl_20260719(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
