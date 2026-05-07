-- ============================================================================
-- P4-3: server-side `create_inventory_hold(...)` RPC
--
-- Closes audit finding P4-3: manual holds were created via a bare
-- `supabase.from('inventory_holds').insert(...)` from the browser. No FOR UPDATE
-- lock, no atomic check against today's free stock. Two admins clicking
-- "Create Hold" simultaneously could each pass the client warning and both
-- succeed, leaving total holds in excess of available inventory.
--
-- Policy (per Mason's audit Q5, 2026-05-06):
-- - Default behavior is BLOCK when today's free (available - prebooked - active
--   holds) would go below zero after the hold.
-- - Admin can override by passing p_force=true with a non-blank p_force_reason.
--   Mirrors the over-receive admin-override pattern from Phase 21 G2.
-- - Sales reps can create non-force holds. Force-create is admin-only.
--
-- Idempotency: keyed on (idempotency_key, operation), 24-hour TTL, ON CONFLICT
-- DO NOTHING for retry safety. Same pattern as 20260506190000.
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
  -- Idempotency check (canonical pattern: filter by operation + ON CONFLICT)
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key
       AND operation = 'create_inventory_hold';
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

  -- Role check: admin or sales_rep can create holds; force is admin-only
  SELECT role INTO v_role FROM profiles WHERE id = v_actor;
  IF v_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  -- Validate hold_type against the inventory_holds CHECK constraint
  IF p_hold_type NOT IN ('manual', 'crop_program') THEN
    RAISE EXCEPTION 'INVALID_HOLD_TYPE: %', p_hold_type;
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'INVALID_QUANTITY: must be > 0';
  END IF;

  -- Lock the Main Warehouse inventory row + recompute today's free
  -- (Convention follows complete_delivery / cancel_delivery: single-warehouse
  --  scope. inventory_holds itself has no location column.)
  SELECT id, quantity_available, quantity_prebooked
    INTO v_inventory
    FROM inventory
   WHERE product_id = p_product_id
     AND location = 'Main Warehouse'
   FOR UPDATE;

  IF NOT FOUND THEN
    -- No inventory row exists for this product. Today's free = 0.
    -- Hold creation will fail unless admin force-creates.
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

  -- Block-or-force decision
  IF v_todays_free - p_quantity < 0 THEN
    IF p_force THEN
      IF v_role != 'admin' THEN
        RAISE EXCEPTION 'FORCE_REQUIRES_ADMIN';
      END IF;
      IF p_force_reason IS NULL OR length(trim(p_force_reason)) = 0 THEN
        RAISE EXCEPTION 'FORCE_REQUIRES_REASON';
      END IF;
    ELSE
      RAISE EXCEPTION 'INSUFFICIENT_HOLD_INVENTORY: only % units uncommitted (Available % - Prebooked % - Active Holds %); requested %',
        v_todays_free,
        COALESCE(v_inventory.quantity_available, 0),
        COALESCE(v_inventory.quantity_prebooked, 0),
        v_active_holds,
        p_quantity;
    END IF;
  END IF;

  -- Create the hold
  INSERT INTO inventory_holds (
    product_id, customer_id, quantity, hold_type, expires_at, notes,
    is_active, created_by, created_at, updated_at
  ) VALUES (
    p_product_id, p_customer_id, p_quantity, p_hold_type, p_expires_at,
    p_notes, true, v_actor, NOW(), NOW()
  ) RETURNING id INTO v_hold_id;

  -- Activity feed entry. severity is encoded into description prefix because
  -- activity_feed has no severity column (Wave 3 hit this same gap).
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

  -- Save idempotency
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

-- ============================================================================
-- Verify: exactly one signature exists (no overload drift).
-- ============================================================================
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
