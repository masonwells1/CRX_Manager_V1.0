-- ============================================================================
-- Final-wave-review F1 (BLOCKER) — fix NULL-concat crash in create_inventory_hold
--
-- The Wave 4 P4-3 migration (20260507170000) puts the FORCE_REQUIRES_REASON
-- guard INSIDE the `IF v_todays_free - p_quantity < 0` branch. That means a
-- caller passing `p_force=true AND p_force_reason=NULL` with sufficient free
-- inventory entirely bypasses the validation. Execution falls through to the
-- activity_feed INSERT where line 144 builds:
--   'WARNING: Hold created with admin override (' || p_force_reason || ')'
-- PostgreSQL `text || NULL` = NULL. activity_feed.description is declared
-- `text NOT NULL DEFAULT ''` (from 20260206172436), so explicitly inserting
-- NULL violates the NOT NULL constraint and rolls back the whole txn —
-- including the inventory_holds INSERT that already succeeded.
--
-- Wave 4 self-review labelled this "unreachable from UI" because ReasonModal
-- enforces minLength=5. That's only true for the INSUFFICIENT_HOLD_INVENTORY
-- → ReasonModal flow. A direct caller (or any future callsite that wires a
-- different modal) can hit it; the RPC itself trusts the caller to enforce
-- the contract.
--
-- Fix: hoist the FORCE_REQUIRES_REASON / FORCE_REQUIRES_ADMIN checks above
-- the inventory threshold logic so they apply unconditionally when force is
-- requested. The rest of the body is identical to 20260507170000.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_inventory_hold(
  p_product_id uuid,
  p_customer_id uuid,
  p_quantity numeric,
  p_hold_type text,
  p_expires_at date,
  p_notes text,
  p_performed_by uuid,
  p_force boolean DEFAULT false,
  p_force_reason text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_role text;
  v_hold_id uuid;
  v_existing jsonb;
  v_inventory record;
  v_active_holds numeric;
  v_todays_free numeric;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key
       AND operation = 'create_inventory_hold';
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by != v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role INTO v_role FROM profiles WHERE id = v_actor;
  IF v_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_hold_type NOT IN ('manual', 'crop_program') THEN
    RAISE EXCEPTION 'INVALID_HOLD_TYPE: %', p_hold_type;
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'INVALID_QUANTITY: must be > 0';
  END IF;

  -- F1 fix: validate the force contract BEFORE any inventory-based branching.
  -- These two checks used to live inside the `IF v_todays_free < 0` block
  -- which meant they were skipped when stock was plentiful — and the later
  -- activity_feed insert built a NULL description by concatenating NULL
  -- p_force_reason, crashing the function on a NOT NULL constraint.
  IF p_force THEN
    IF v_role != 'admin' THEN
      RAISE EXCEPTION 'FORCE_REQUIRES_ADMIN';
    END IF;
    IF p_force_reason IS NULL OR length(trim(p_force_reason)) = 0 THEN
      RAISE EXCEPTION 'FORCE_REQUIRES_REASON';
    END IF;
  END IF;

  SELECT id, quantity_available, quantity_prebooked
    INTO v_inventory
    FROM inventory
   WHERE product_id = p_product_id
     AND location = 'Main Warehouse'
   FOR UPDATE;

  IF NOT FOUND THEN
    v_todays_free := 0;
    v_active_holds := 0;
  ELSE
    SELECT COALESCE(SUM(quantity), 0) INTO v_active_holds
      FROM inventory_holds
     WHERE product_id = p_product_id
       AND is_active = true
       AND (expires_at IS NULL OR expires_at >= CURRENT_DATE);
    v_todays_free := v_inventory.quantity_available
                     - v_inventory.quantity_prebooked
                     - v_active_holds;
  END IF;

  -- Block-or-allow decision. Force-create now only needs to gate inventory;
  -- the force *contract* (admin + reason) was already enforced above.
  IF v_todays_free - p_quantity < 0 AND NOT p_force THEN
    RAISE EXCEPTION 'INSUFFICIENT_HOLD_INVENTORY: only % units uncommitted (Available % - Prebooked % - Active Holds %); requested %',
      v_todays_free,
      COALESCE(v_inventory.quantity_available, 0),
      COALESCE(v_inventory.quantity_prebooked, 0),
      v_active_holds,
      p_quantity;
  END IF;

  INSERT INTO inventory_holds (
    product_id, customer_id, quantity, hold_type, expires_at, notes,
    is_active, created_by, created_at, updated_at
  ) VALUES (
    p_product_id, p_customer_id, p_quantity, p_hold_type, p_expires_at,
    p_notes, true, v_actor, NOW(), NOW()
  ) RETURNING id INTO v_hold_id;

  -- Activity feed entry. p_force_reason is now guaranteed non-NULL when
  -- p_force is true, so the concat below cannot produce NULL.
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'inventory_hold_created',
    CASE
      WHEN p_force THEN 'WARNING: Hold created with admin override (' || p_force_reason || ')'
      ELSE 'Hold created'
    END,
    v_actor, 'inventory_hold', v_hold_id, p_customer_id
  );

  v_result := jsonb_build_object(
    'hold_id', v_hold_id,
    'todays_free_before', v_todays_free,
    'forced', p_force
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)
    VALUES (p_idempotency_key, 'create_inventory_hold', v_result,
            now() + interval '24 hours')
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_inventory_hold(
  uuid, uuid, numeric, text, date, text, uuid, boolean, text, text
) TO authenticated;

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
    FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname = 'create_inventory_hold';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'create_inventory_hold has % overloads (expected 1)', v_count;
  END IF;
END $$;
