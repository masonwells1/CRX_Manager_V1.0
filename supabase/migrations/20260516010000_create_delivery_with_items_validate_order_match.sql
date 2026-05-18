-- idempotency-body-check: exempt
-- (Uses check_idempotency / save_idempotency helpers per CLAUDE.md
-- "Canonical Patterns for New RPCs".)
-- ============================================================================
-- Codex P2 fix (PR #59, 2026-05-16) — create_delivery_with_items must
-- validate each item belongs to p_order_id before inserting.
-- ============================================================================
-- Audit finding: 20260513010000:104 — the RPC accepted caller-supplied
-- order_item_id and product_id and inserted them into delivery_items
-- without verifying that the order_item actually belongs to p_order_id
-- (or that the product_id on the item matches what's in order_items).
--
-- Attack/bug scenario: a malformed or stale frontend could call
-- create_delivery_with_items(order_id=A, items=[{order_item_id=<order B's
-- item>, ...}]). The delivery would be created against order A, but on
-- complete_delivery the order_items UPDATE keys off delivery_items.order_item_id
-- (live body of complete_delivery), so order B's line item gets decremented
-- and order A's line items stay untouched. Inventory + order fulfillment
-- desync silently.
--
-- Fix: for each item, SELECT FOR UPDATE the order_items row by
-- (id = order_item_id) and verify:
--   1. The row exists
--   2. order_items.order_id = p_order_id
--   3. order_items.product_id = (v_item->>'product_id')::uuid
--
-- Raises ITEM_ORDER_MISMATCH / ITEM_PRODUCT_MISMATCH / ITEM_NOT_FOUND tokens
-- so callers (and tests) can distinguish from generic "invalid item" errors.
-- Body otherwise verbatim from 20260513010000.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_delivery_with_items(
  p_order_id              uuid,
  p_customer_id           uuid,
  p_scheduled_date        date,
  p_items                 jsonb,
  p_delivery_address_id   uuid    DEFAULT NULL,
  p_assigned_driver       uuid    DEFAULT NULL,
  p_scheduled_time        text    DEFAULT NULL,
  p_delivery_notes        text    DEFAULT NULL,
  p_idempotency_key       text    DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor          uuid := auth.uid();
  v_delivery_id    uuid;
  v_delivery_no    text;
  v_existing       jsonb;
  v_result         jsonb;
  v_item           jsonb;
  v_item_count     int := 0;
  v_order_item     record;
  v_item_oid       uuid;
  v_item_pid       uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;

  IF p_order_id IS NULL THEN RAISE EXCEPTION 'ORDER_ID_REQUIRED'; END IF;
  IF p_customer_id IS NULL THEN RAISE EXCEPTION 'CUSTOMER_ID_REQUIRED'; END IF;
  IF p_scheduled_date IS NULL THEN RAISE EXCEPTION 'SCHEDULED_DATE_REQUIRED'; END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'ITEMS_REQUIRED';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'create_delivery_with_items');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  v_delivery_no := next_delivery_number();

  INSERT INTO public.deliveries (
    delivery_number, order_id, customer_id, delivery_address_id,
    assigned_driver, scheduled_date, scheduled_time, delivery_notes,
    status, created_by
  ) VALUES (
    v_delivery_no, p_order_id, p_customer_id, p_delivery_address_id,
    p_assigned_driver, p_scheduled_date, p_scheduled_time, p_delivery_notes,
    'scheduled', v_actor
  )
  RETURNING id INTO v_delivery_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    IF (v_item->>'order_item_id') IS NULL OR (v_item->>'product_id') IS NULL THEN
      RAISE EXCEPTION 'ITEM_INVALID: order_item_id and product_id required';
    END IF;
    IF (v_item->>'quantity') IS NULL OR (v_item->>'quantity')::numeric <= 0 THEN
      RAISE EXCEPTION 'ITEM_INVALID: quantity must be > 0';
    END IF;

    -- Codex P2 fix (PR #59, 2026-05-16): validate order_item belongs to p_order_id
    -- and the product matches before inserting. FOR UPDATE locks the order_item
    -- so a concurrent reassignment can't slip through between check and insert.
    v_item_oid := (v_item->>'order_item_id')::uuid;
    v_item_pid := (v_item->>'product_id')::uuid;

    SELECT id, order_id, product_id INTO v_order_item
    FROM public.order_items
    WHERE id = v_item_oid
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ITEM_NOT_FOUND: order_item_id % does not exist', v_item_oid;
    END IF;
    IF v_order_item.order_id IS DISTINCT FROM p_order_id THEN
      RAISE EXCEPTION 'ITEM_ORDER_MISMATCH: order_item_id % belongs to order %, not %',
        v_item_oid, v_order_item.order_id, p_order_id;
    END IF;
    IF v_order_item.product_id IS DISTINCT FROM v_item_pid THEN
      RAISE EXCEPTION 'ITEM_PRODUCT_MISMATCH: order_item_id % has product %, caller sent %',
        v_item_oid, v_order_item.product_id, v_item_pid;
    END IF;

    INSERT INTO public.delivery_items (
      delivery_id, order_item_id, product_id, quantity,
      unit_size, tote_number, notes
    ) VALUES (
      v_delivery_id,
      v_item_oid,
      v_item_pid,
      (v_item->>'quantity')::numeric,
      NULLIF(v_item->>'unit_size', ''),
      NULLIF(v_item->>'tote_number', ''),
      NULLIF(v_item->>'notes', '')
    );
    v_item_count := v_item_count + 1;
  END LOOP;

  v_result := jsonb_build_object(
    'success',          true,
    'delivery_id',      v_delivery_id,
    'delivery_number',  v_delivery_no,
    'item_count',       v_item_count
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_delivery_with_items', v_result);
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.create_delivery_with_items(uuid, uuid, date, jsonb, uuid, uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_delivery_with_items(uuid, uuid, date, jsonb, uuid, uuid, text, text, text) TO authenticated;

-- ─── Verification ─────────────────────────────────────────────

DO $$
DECLARE
  v_overload_count integer;
  v_has_validation boolean;
BEGIN
  SELECT count(*) INTO v_overload_count
  FROM pg_proc
  WHERE proname = 'create_delivery_with_items' AND pronamespace = 'public'::regnamespace;
  IF v_overload_count <> 1 THEN
    RAISE EXCEPTION 'codex-fix verification: expected 1 overload, found %', v_overload_count;
  END IF;

  SELECT prosrc ~ 'ITEM_ORDER_MISMATCH' AND prosrc ~ 'ITEM_PRODUCT_MISMATCH'
    INTO v_has_validation
  FROM pg_proc
  WHERE proname = 'create_delivery_with_items' AND pronamespace = 'public'::regnamespace;
  IF NOT COALESCE(v_has_validation, false) THEN
    RAISE EXCEPTION 'codex-fix verification: create_delivery_with_items missing item validation';
  END IF;

  RAISE NOTICE 'codex-fix: create_delivery_with_items now validates order_item_id/product_id belong to p_order_id.';
END
$$;
