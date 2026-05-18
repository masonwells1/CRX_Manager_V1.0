-- idempotency-body-check: exempt
-- (Uses check_idempotency / save_idempotency helpers per CLAUDE.md
-- "Canonical Patterns for New RPCs".)
-- ============================================================================
-- Codex review fix for PR #59 (P2, 2026-05-13) — bulk_import_order must seed
-- order_items.quantity_remaining when inserting CSV/OCR-imported rows.
-- ============================================================================
-- Audit finding: 20260513010000_atomic_multi_table_write_rpcs.sql:202-218
-- INSERTs each imported order_items row with quantity_delivered = 0 but does
-- NOT set quantity_remaining. Verified live: order_items.quantity_remaining
-- is a plain numeric with DEFAULT 0 (not generated), so imported rows land
-- with quantity_remaining = 0.
--
-- src/pages/NewDelivery.tsx:164 filters items where quantity_remaining > 0
-- when building the deliverable line list. Result: every CSV/OCR bulk-imported
-- order shows up confirmed but with no line items available for delivery —
-- the feature is silently broken for normal usage.
--
-- Fix: add quantity_remaining to the INSERT column list and seed it from
-- v_item->>'total_units_needed' (already validated > 0 on lines 198-200).
-- Body otherwise verbatim from 20260513010000.
--
-- Frontend impact: none. bulk_import_order signature unchanged.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.bulk_import_order(
  p_order_number       text,
  p_customer_id        uuid,
  p_status             text,
  p_total_price        numeric,
  p_total_cost         numeric,
  p_total_profit       numeric,
  p_total_margin_pct   numeric,
  p_order_date         date,
  p_items              jsonb,
  p_notes              text    DEFAULT NULL,
  p_idempotency_key    text    DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor       uuid := auth.uid();
  v_order_id    uuid;
  v_existing    jsonb;
  v_result      jsonb;
  v_item        jsonb;
  v_item_count  int := 0;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;

  IF p_order_number IS NULL OR p_order_number = '' THEN RAISE EXCEPTION 'ORDER_NUMBER_REQUIRED'; END IF;
  IF p_customer_id IS NULL THEN RAISE EXCEPTION 'CUSTOMER_ID_REQUIRED'; END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'ITEMS_REQUIRED';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'bulk_import_order');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  INSERT INTO public.orders (
    order_number, customer_id, status,
    total_price, total_cost, total_profit, total_margin_pct,
    order_date, notes
  ) VALUES (
    p_order_number, p_customer_id,
    CASE WHEN p_status IN ('confirmed', 'partially_fulfilled', 'fulfilled', 'cancelled')
         THEN p_status ELSE 'confirmed' END,
    p_total_price, p_total_cost, p_total_profit, p_total_margin_pct,
    p_order_date, p_notes
  )
  RETURNING id INTO v_order_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    IF (v_item->>'product_name') IS NULL THEN
      RAISE EXCEPTION 'ITEM_INVALID: product_name required';
    END IF;
    IF (v_item->>'total_units_needed') IS NULL OR (v_item->>'total_units_needed')::numeric <= 0 THEN
      RAISE EXCEPTION 'ITEM_INVALID: total_units_needed must be > 0';
    END IF;

    -- Codex P2 fix (PR #59, 2026-05-13): quantity_remaining must be seeded
    -- to total_units_needed so the imported line items are deliverable.
    -- NewDelivery.tsx:164 filters on quantity_remaining > 0.
    INSERT INTO public.order_items (
      order_id, product_id, product_name,
      price_per_unit, cost_per_unit,
      total_units_needed, unit_size, notes,
      sort_order, quantity_delivered, quantity_remaining
    ) VALUES (
      v_order_id,
      NULLIF(v_item->>'product_id', '')::uuid,
      v_item->>'product_name',
      COALESCE((v_item->>'price_per_unit')::numeric, 0),
      COALESCE((v_item->>'unit_cost')::numeric, 0),
      (v_item->>'total_units_needed')::numeric,
      NULLIF(v_item->>'unit_size', ''),
      NULLIF(v_item->>'notes', ''),
      COALESCE((v_item->>'sort_order')::int, v_item_count + 1),
      0,
      (v_item->>'total_units_needed')::numeric
    );
    v_item_count := v_item_count + 1;
  END LOOP;

  v_result := jsonb_build_object(
    'success',     true,
    'order_id',    v_order_id,
    'item_count',  v_item_count
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'bulk_import_order', v_result);
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.bulk_import_order(text, uuid, text, numeric, numeric, numeric, numeric, date, jsonb, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bulk_import_order(text, uuid, text, numeric, numeric, numeric, numeric, date, jsonb, text, text) TO authenticated;

-- ─── Verification ────────────────────────────────────────────

DO $$
DECLARE
  v_overload_count integer;
  v_has_quantity_remaining boolean;
BEGIN
  SELECT count(*) INTO v_overload_count
  FROM pg_proc
  WHERE proname = 'bulk_import_order' AND pronamespace = 'public'::regnamespace;
  IF v_overload_count <> 1 THEN
    RAISE EXCEPTION 'codex-fix verification: expected 1 overload of bulk_import_order, found %', v_overload_count;
  END IF;

  SELECT prosrc ~ 'quantity_remaining'
    INTO v_has_quantity_remaining
  FROM pg_proc
  WHERE proname = 'bulk_import_order' AND pronamespace = 'public'::regnamespace;
  IF NOT COALESCE(v_has_quantity_remaining, false) THEN
    RAISE EXCEPTION 'codex-fix verification: bulk_import_order body does not seed quantity_remaining';
  END IF;

  RAISE NOTICE 'codex-fix: bulk_import_order now seeds order_items.quantity_remaining = total_units_needed.';
END
$$;
