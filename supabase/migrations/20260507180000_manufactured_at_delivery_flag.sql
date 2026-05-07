-- ============================================================================
-- P4-7: `inventory.manufactured_at_delivery` flag + verify RPC
--
-- Background. The Phase 4 audit (2026-05-04) flagged that complete_delivery
-- could create a fresh inventory row at -X when delivering a product that has
-- no prior inventory record (the IF FOUND ... ELSE INSERT branch in
-- 20260319200000_complete_delivery_remove_inventory_block.sql:128-136).
-- A phantom row at -X would surface on /inventory with no obvious origin.
--
-- Current state. The LATEST definitive complete_delivery body (Phase 15,
-- 20260501100000_field_app_workflow_phase15.sql) has been refactored to
-- RAISE EXCEPTION 'Insufficient inventory for %: need % units, only % on-hand'
-- on the NOT FOUND case. So the phantom-row bug the audit feared cannot
-- occur in current production. However:
--
--   1. The audit's spec assumed the older body. Mason's audit Q7 still
--      asked for an explicit flag + Integrity Cleanup section in case of
--      regression.
--   2. Schema infrastructure is cheap; if any future code path manufactures
--      a row during delivery (e.g. driver-app field workflows), the column
--      is already in place and no backfill migration is needed.
--   3. The 2026-05-07 wave 3 migration (20260507160000) attempted to copy
--      the older complete_delivery body verbatim, which would have RE-
--      INTRODUCED the phantom-row branch had it been applied to live.
--      The defensive flag protects against that style of regression too.
--
-- Behavior:
--   - inventory.manufactured_at_delivery defaults to false. Existing rows
--     are NOT retroactively flagged (they may genuinely predate any
--     manufacture). Row count where flag = true is expected to be 0
--     immediately after this migration.
--   - mark_inventory_row_verified(p_inventory_id, p_performed_by, p_idem)
--     admin-only RPC clears the flag once a human has confirmed physical
--     stock matches. Logs to activity_feed. Idempotent.
--   - Integrity Cleanup page surfaces all rows where flag = true so admins
--     can verify-and-clear.
-- ============================================================================

-- ─── 1. Add the column ──────────────────────────────────────────────────────
ALTER TABLE inventory
  ADD COLUMN IF NOT EXISTS manufactured_at_delivery boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN inventory.manufactured_at_delivery IS
  'P4-7: true when this inventory row was created by a delivery completion that found no prior record for the product. Set by complete_delivery''s ELSE-INSERT branch (currently inactive in Phase 15+ body) or a future field-app path. Cleared by mark_inventory_row_verified after admin physical-stock confirmation.';


-- ─── 2. Admin RPC to clear the flag ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mark_inventory_row_verified(
  p_inventory_id   uuid,
  p_performed_by   uuid,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor    uuid;
  v_role     text;
  v_existing jsonb;
  v_row      record;
  v_result   jsonb;
BEGIN
  -- Idempotency check (canonical: filter by operation, ON CONFLICT DO NOTHING)
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key
       AND operation = 'mark_inventory_row_verified';
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  -- Strict actor pattern (Phase 13)
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by != v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  -- Admin-only — verifying a manufactured row is a financial-audit action
  SELECT role INTO v_role FROM profiles WHERE id = v_actor;
  IF v_role != 'admin' THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: admin required';
  END IF;

  -- Lock and load the row
  SELECT id, product_id, quantity_available, manufactured_at_delivery
    INTO v_row
    FROM inventory
   WHERE id = p_inventory_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVENTORY_NOT_FOUND: %', p_inventory_id;
  END IF;

  IF NOT v_row.manufactured_at_delivery THEN
    -- Already verified (or never flagged). Idempotent no-op.
    v_result := jsonb_build_object(
      'inventory_id', p_inventory_id,
      'cleared', false,
      'reason', 'already_verified'
    );
  ELSE
    UPDATE inventory
       SET manufactured_at_delivery = false,
           updated_at = now()
     WHERE id = p_inventory_id;

    INSERT INTO activity_feed (
      event_type, description, performed_by,
      related_entity_type, related_entity_id
    ) VALUES (
      'inventory_row_verified',
      'Manufactured-at-delivery flag cleared after admin physical-stock verification.',
      v_actor, 'inventory', p_inventory_id
    );

    v_result := jsonb_build_object(
      'inventory_id', p_inventory_id,
      'cleared', true,
      'reason', 'verified_by_admin'
    );
  END IF;

  -- Save idempotency
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)
    VALUES (p_idempotency_key, 'mark_inventory_row_verified', v_result,
            now() + interval '24 hours')
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_inventory_row_verified(uuid, uuid, text)
  TO authenticated;


-- ─── 3. Verify exactly one signature exists (no overload drift) ─────────────
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
    FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname = 'mark_inventory_row_verified';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'mark_inventory_row_verified has % overloads (expected 1)', v_count;
  END IF;
END $$;
