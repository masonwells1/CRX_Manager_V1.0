-- idempotency-body-check: exempt
-- (Uses check_idempotency / save_idempotency helpers per CLAUDE.md
-- "Canonical Patterns for New RPCs".)
-- ============================================================================
-- Codex P2 fix (PR #59, 2026-05-16 review of commit 4c84f90) — add a
-- CUSTOMER_ORDER_MISMATCH guard to create_delivery_with_items.
-- ============================================================================
-- Codex audit finding: the prior fix (20260516010000) validated that each
-- order_item belongs to p_order_id, but didn't validate that p_customer_id
-- matches orders.customer_id. complete_delivery later does:
--   - inventory + order fulfillment via v_delivery.order_id
--   - draft invoice + activity_feed via v_delivery.customer_id
-- So a direct/stale caller passing (order_id=A, customer_id=B) results in
-- order A's inventory being decremented while customer B is billed for it.
-- Fix: SELECT FOR UPDATE the orders row, raise CUSTOMER_ORDER_MISMATCH if
-- orders.customer_id IS DISTINCT FROM p_customer_id. Also raises
-- ORDER_NOT_FOUND for the missing-order case (was previously implicit via
-- the FK on deliveries.order_id but came through as a less helpful message).
--
-- Body otherwise verbatim from 20260516010000.
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
  v_order_customer uuid;
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

  -- Codex P2 fix (2026-05-16 review of 4c84f90): lock the order row and
  -- verify customer matches. Prevents fulfilling order A while billing
  -- customer B (complete_delivery splits inventory/order updates by
  -- v_delivery.order_id but invoice/activity by v_delivery.customer_id).
  SELECT customer_id INTO v_order_customer
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND: order_id % does not exist', p_order_id;
  END IF;
  IF v_order_customer IS DISTINCT FROM p_customer_id THEN
    RAISE EXCEPTION 'CUSTOMER_ORDER_MISMATCH: order % belongs to customer %, caller sent %',
      p_order_id, v_order_customer, p_customer_id;
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
  v_has_customer_check boolean;
  v_has_order_not_found boolean;
BEGIN
  SELECT prosrc ~ 'CUSTOMER_ORDER_MISMATCH' INTO v_has_customer_check
  FROM pg_proc
  WHERE proname = 'create_delivery_with_items' AND pronamespace = 'public'::regnamespace;
  IF NOT COALESCE(v_has_customer_check, false) THEN
    RAISE EXCEPTION 'codex-fix verification: missing CUSTOMER_ORDER_MISMATCH check';
  END IF;

  SELECT prosrc ~ 'ORDER_NOT_FOUND' INTO v_has_order_not_found
  FROM pg_proc
  WHERE proname = 'create_delivery_with_items' AND pronamespace = 'public'::regnamespace;
  IF NOT COALESCE(v_has_order_not_found, false) THEN
    RAISE EXCEPTION 'codex-fix verification: missing ORDER_NOT_FOUND check';
  END IF;

  RAISE NOTICE 'codex-fix: create_delivery_with_items now validates customer matches order.';
END
$$;
