-- idempotency-body-check: exempt
-- (Uses check_idempotency / save_idempotency helpers per CLAUDE.md
-- "Canonical Patterns for New RPCs".)
-- ============================================================================
-- Codex audit F2 (P2, 2026-05-17) — create_delivery_with_items must enforce
-- the cross-delivery aggregate, not just per-row remaining.
-- ============================================================================
-- Audit finding: 20260516050000 added ITEM_OVER_REMAINING per-row, but a caller
-- can still over-schedule by:
--   (a) Submitting the same order_item_id twice in p_items — each row passes
--       the per-item check (qty <= remaining) but together exceed remaining.
--   (b) Concurrent create_delivery_with_items calls — Delivery A schedules 80
--       of 100, Delivery B schedules 80 (each <= 100), both complete, and
--       complete_delivery increments quantity_delivered by 80 each = 160 > 100.
--
-- The pattern is already present in `edit_delivery_items_when_scheduled`
-- (migration 20260334200000:124-143) but was never applied to create. This
-- migration ports that pattern over.
--
-- Fix:
--   1. Before the loop, aggregate p_items by order_item_id and reject any
--      duplicate (ITEM_DUPLICATE_IN_REQUEST) — simpler than per-loop dedup.
--   2. Inside the loop, after locking the order_item row, sum quantities
--      already scheduled on OTHER active deliveries (status IN ('scheduled',
--      'in_progress')) and check requested_qty <= (remaining - other_scheduled).
--   3. Raise ITEM_OVER_REMAINING_INCL_ACTIVE on cross-delivery overschedule.
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
  v_order_item         record;
  v_item_oid           uuid;
  v_item_pid           uuid;
  v_item_qty           numeric;
  v_order_customer     uuid;
  v_other_scheduled    numeric;
  v_max_allowed        numeric;
  v_dup_oid            uuid;
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

  -- Codex F2 fix (1/2): reject duplicate order_item_id within the same request.
  -- If a caller lists order_item X twice with qty 50 each, each row would pass
  -- the per-item remaining check independently but together would over-schedule.
  -- Cheaper to reject upfront than to aggregate-then-check inside the loop.
  SELECT (elem->>'order_item_id')::uuid INTO v_dup_oid
  FROM jsonb_array_elements(p_items) AS elem
  GROUP BY (elem->>'order_item_id')::uuid
  HAVING COUNT(*) > 1
  LIMIT 1;
  IF v_dup_oid IS NOT NULL THEN
    RAISE EXCEPTION 'ITEM_DUPLICATE_IN_REQUEST: order_item_id % appears more than once in items', v_dup_oid;
  END IF;

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

    -- Codex F2 fix (2/2): subtract quantities scheduled on OTHER active
    -- deliveries from this order_item's remaining count. Mirrors the proven
    -- pattern in edit_delivery_items_when_scheduled (20260334200000:124-143).
    -- The exclusion `d.id != v_delivery_id` is a safety net — v_delivery_id
    -- was just created above and has zero items yet, but the predicate makes
    -- the intent explicit and survives future refactors that move the INSERT.
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
  v_has_cross_check       boolean;
  v_has_duplicate_check   boolean;
BEGIN
  SELECT prosrc ~ 'ITEM_OVER_REMAINING_INCL_ACTIVE'
       AND prosrc ~ 'd\.status IN \(''scheduled'', ''in_progress''\)'
    INTO v_has_cross_check
  FROM pg_proc
  WHERE proname = 'create_delivery_with_items' AND pronamespace = 'public'::regnamespace;
  IF NOT COALESCE(v_has_cross_check, false) THEN
    RAISE EXCEPTION 'codex-fix verification: missing cross-delivery aggregation check';
  END IF;

  SELECT prosrc ~ 'ITEM_DUPLICATE_IN_REQUEST'
    INTO v_has_duplicate_check
  FROM pg_proc
  WHERE proname = 'create_delivery_with_items' AND pronamespace = 'public'::regnamespace;
  IF NOT COALESCE(v_has_duplicate_check, false) THEN
    RAISE EXCEPTION 'codex-fix verification: missing duplicate-in-request check';
  END IF;

  RAISE NOTICE 'codex-fix: create_delivery_with_items now blocks both duplicate-in-request and cross-delivery overschedule.';
END
$$;
