-- idempotency-body-check: exempt
-- (Uses check_idempotency / save_idempotency helpers per CLAUDE.md
-- "Canonical Patterns for New RPCs".)
-- ============================================================================
-- Codex audit (P2, 2026-05-18) — create_delivery_with_items must also
-- validate order status and delivery-address ownership.
-- ============================================================================
-- Findings on 20260517010000 (Codex review of b2a07bc):
--
--   1. ORDER STATUS NOT CHECKED
--      The locked SELECT on `orders` only reads customer_id. A stale or
--      direct caller can pass an order in 'cancelled' / 'fulfilled' /
--      'voided' status. The delivery gets created; later complete_delivery
--      blindly updates orders.status — which can resurrect a cancelled
--      order or fulfill a draft. Schedulable statuses (per the UI listing
--      in src/pages/Deliveries.tsx + NewDelivery.tsx) are only
--      'confirmed' and 'partially_fulfilled'.
--
--   2. DELIVERY ADDRESS NOT VALIDATED
--      p_delivery_address_id is inserted verbatim with no ownership check.
--      A stale/direct caller can pass an address row belonging to a
--      different customer; delivery-detail and load-sheet code later look
--      up customer_addresses by that id alone, so customer A's delivery
--      would render with customer B's address (PII leak + wrong routing).
--
-- Fix: add both checks. The order-status check runs in the same locked
-- SELECT (no extra round-trip). The address check is a separate lookup
-- only when p_delivery_address_id IS NOT NULL.
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
  v_actor              uuid := auth.uid();
  v_delivery_id        uuid;
  v_delivery_no        text;
  v_existing           jsonb;
  v_result             jsonb;
  v_item               jsonb;
  v_item_count         int := 0;
  v_order              record;
  v_item_oid           uuid;
  v_item_pid           uuid;
  v_item_qty           numeric;
  v_order_item         record;
  v_other_scheduled    numeric;
  v_max_allowed        numeric;
  v_dup_oid            uuid;
  v_address_customer   uuid;
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

  -- (Carried over from 20260517010000) Reject duplicate order_item_id within request.
  SELECT (elem->>'order_item_id')::uuid INTO v_dup_oid
  FROM jsonb_array_elements(p_items) AS elem
  GROUP BY (elem->>'order_item_id')::uuid
  HAVING COUNT(*) > 1
  LIMIT 1;
  IF v_dup_oid IS NOT NULL THEN
    RAISE EXCEPTION 'ITEM_DUPLICATE_IN_REQUEST: order_item_id % appears more than once in items', v_dup_oid;
  END IF;

  -- Codex 2026-05-18 fix (1/2): include status in the locked order read
  -- and reject any order not in a schedulable state. Lock prevents a
  -- concurrent cancel/void from racing with this insert.
  SELECT customer_id, status INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND: order_id % does not exist', p_order_id;
  END IF;
  IF v_order.customer_id IS DISTINCT FROM p_customer_id THEN
    RAISE EXCEPTION 'CUSTOMER_ORDER_MISMATCH: order % belongs to customer %, caller sent %',
      p_order_id, v_order.customer_id, p_customer_id;
  END IF;
  IF v_order.status NOT IN ('confirmed', 'partially_fulfilled') THEN
    RAISE EXCEPTION 'ORDER_NOT_SCHEDULABLE: order % is in status %, cannot create delivery (must be confirmed or partially_fulfilled)',
      p_order_id, v_order.status;
  END IF;

  -- Codex 2026-05-18 fix (2/2): if a delivery address was specified, verify
  -- it belongs to the same customer as the order. Without this, a caller
  -- can route delivery A to customer B's address (PII leak + wrong route).
  IF p_delivery_address_id IS NOT NULL THEN
    SELECT customer_id INTO v_address_customer
    FROM public.customer_addresses
    WHERE id = p_delivery_address_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ADDRESS_NOT_FOUND: delivery_address_id % does not exist', p_delivery_address_id;
    END IF;
    IF v_address_customer IS DISTINCT FROM p_customer_id THEN
      RAISE EXCEPTION 'ADDRESS_CUSTOMER_MISMATCH: delivery_address_id % belongs to customer %, not %',
        p_delivery_address_id, v_address_customer, p_customer_id;
    END IF;
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
    v_item_qty := (v_item->>'quantity')::numeric;

    SELECT id, order_id, product_id, quantity_remaining INTO v_order_item
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

    -- (Carried over) Subtract qty on OTHER active deliveries from remaining.
    SELECT COALESCE(SUM(di.quantity), 0) INTO v_other_scheduled
    FROM public.delivery_items di
    JOIN public.deliveries d ON d.id = di.delivery_id
    WHERE di.order_item_id = v_item_oid
      AND d.status IN ('scheduled', 'in_progress')
      AND d.id <> v_delivery_id;

    v_max_allowed := COALESCE(v_order_item.quantity_remaining, 0) - COALESCE(v_other_scheduled, 0);

    IF v_item_qty > v_max_allowed THEN
      RAISE EXCEPTION 'ITEM_OVER_REMAINING_INCL_ACTIVE: order_item_id % has % units on other active deliveries; only % available (% remaining on order minus % active)',
        v_item_oid,
        COALESCE(v_other_scheduled, 0),
        GREATEST(v_max_allowed, 0),
        COALESCE(v_order_item.quantity_remaining, 0),
        COALESCE(v_other_scheduled, 0);
    END IF;

    INSERT INTO public.delivery_items (
      delivery_id, order_item_id, product_id, quantity,
      unit_size, tote_number, notes
    ) VALUES (
      v_delivery_id,
      v_item_oid,
      v_item_pid,
      v_item_qty,
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
  v_overloads             int;
  v_has_status_check      boolean;
  v_has_address_check     boolean;
  v_has_cross_check       boolean;
  v_has_duplicate_check   boolean;
BEGIN
  -- Confirm single overload (no signature drift).
  SELECT COUNT(*) INTO v_overloads
  FROM pg_proc
  WHERE proname = 'create_delivery_with_items' AND pronamespace = 'public'::regnamespace;
  IF v_overloads <> 1 THEN
    RAISE EXCEPTION 'codex-fix verification: expected exactly 1 overload of create_delivery_with_items, found %', v_overloads;
  END IF;

  SELECT prosrc ~ 'ORDER_NOT_SCHEDULABLE'
       AND prosrc ~ 'status NOT IN \(''confirmed'', ''partially_fulfilled''\)'
    INTO v_has_status_check
  FROM pg_proc
  WHERE proname = 'create_delivery_with_items' AND pronamespace = 'public'::regnamespace;
  IF NOT COALESCE(v_has_status_check, false) THEN
    RAISE EXCEPTION 'codex-fix verification: missing order-status schedulable check';
  END IF;

  SELECT prosrc ~ 'ADDRESS_CUSTOMER_MISMATCH'
       AND prosrc ~ 'ADDRESS_NOT_FOUND'
    INTO v_has_address_check
  FROM pg_proc
  WHERE proname = 'create_delivery_with_items' AND pronamespace = 'public'::regnamespace;
  IF NOT COALESCE(v_has_address_check, false) THEN
    RAISE EXCEPTION 'codex-fix verification: missing delivery-address ownership check';
  END IF;

  -- Carry-forward checks (must still be present after rewrite).
  SELECT prosrc ~ 'ITEM_OVER_REMAINING_INCL_ACTIVE'
    INTO v_has_cross_check
  FROM pg_proc
  WHERE proname = 'create_delivery_with_items' AND pronamespace = 'public'::regnamespace;
  IF NOT COALESCE(v_has_cross_check, false) THEN
    RAISE EXCEPTION 'codex-fix verification: regression — cross-delivery aggregation check missing';
  END IF;

  SELECT prosrc ~ 'ITEM_DUPLICATE_IN_REQUEST'
    INTO v_has_duplicate_check
  FROM pg_proc
  WHERE proname = 'create_delivery_with_items' AND pronamespace = 'public'::regnamespace;
  IF NOT COALESCE(v_has_duplicate_check, false) THEN
    RAISE EXCEPTION 'codex-fix verification: regression — duplicate-in-request check missing';
  END IF;

  RAISE NOTICE 'codex-fix: create_delivery_with_items now validates order status and delivery-address ownership (plus prior duplicate + cross-delivery checks).';
END
$$;
