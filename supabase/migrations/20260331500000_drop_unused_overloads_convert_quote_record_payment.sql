-- ============================================================================
-- Drop ALL remaining unused RPC overloads
--
-- ROOT CAUSE: Migration 20260306200000 injected p_idempotency_key into all
-- mutating RPCs by modifying function definitions dynamically. Later audit
-- migrations (20260311, etc.) used CREATE OR REPLACE with the ORIGINAL
-- parameter list (without p_idempotency_key), which created NEW overloads
-- instead of replacing the existing ones. The frontend always sends
-- p_idempotency_key, so PostgREST matches the older versions — the newer
-- "fixed" versions are never called.
--
-- This migration drops ALL unused overloads (the ones without p_idempotency_key)
-- and applies any bug fixes from the unused versions into the active ones.
--
-- PROBLEM 1: convert_quote_to_order has two overloads:
--   ACTIVE:  (uuid, uuid, text) — called by frontend (sends p_idempotency_key)
--   UNUSED:  (uuid, uuid)       — newer but never called (no idempotency param)
--   The unused version has a GREATEST(commission, 0) clamp that the active
--   version is missing. Fix: drop unused, add clamp to active version.
--
-- PROBLEM 2: record_invoice_payment has two overloads:
--   ACTIVE:  (uuid, bigint, text, text, text, text) — called by frontend
--            Has idempotency, period check, accepts 'posted' AND 'overdue'
--   UNUSED:  (uuid, bigint, text, text, text) — newer but never called
--            Missing idempotency, missing period check, only accepts 'posted'
--   Fix: drop the unused (inferior) overload, keep the active one as-is.
-- ============================================================================


-- ============================================================================
-- Step 1: Drop unused convert_quote_to_order(uuid, uuid) overload
-- ============================================================================
DROP FUNCTION IF EXISTS public.convert_quote_to_order(uuid, uuid);


-- ============================================================================
-- Step 2: Fix active convert_quote_to_order — add GREATEST commission clamp
--         Must DROP first because pg won't let us change parameter defaults
--         via CREATE OR REPLACE alone.
-- ============================================================================
DROP FUNCTION IF EXISTS public.convert_quote_to_order(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.convert_quote_to_order(
  p_quote_id uuid,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_quote record;
  v_order_number text;
  v_order_id uuid;
  v_section record;
  v_item record;
  v_customer record;
  v_split jsonb;
  v_inv record;
  v_shortfalls text[] := '{}';
  v_net_position numeric;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by <> v_actor THEN RAISE EXCEPTION 'Actor mismatch'; END IF;

  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found'; END IF;

  -- FIX A1: Quote status guard
  IF v_quote.status NOT IN ('sent', 'accepted') THEN
    RAISE EXCEPTION 'Cannot convert quote with status "%". Only sent or accepted quotes can be converted.', v_quote.status;
  END IF;

  IF v_quote.status = 'accepted' THEN
    SELECT id INTO v_order_id FROM orders WHERE quote_id = p_quote_id LIMIT 1;
    IF v_order_id IS NOT NULL THEN
      RETURN jsonb_build_object('status', 'already_converted', 'order_id', v_order_id);
    END IF;
  END IF;

  SELECT * INTO v_customer FROM customers WHERE id = v_quote.customer_id;

  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN RAISE EXCEPTION 'Not authorized'; END IF;

  FOR v_item IN
    SELECT qi.product_id, p.product_name, SUM(COALESCE(qi.total_units_needed, 0)) AS qty_needed
    FROM quote_items qi JOIN products p ON p.id = qi.product_id
    WHERE qi.quote_id = p_quote_id AND qi.product_id IS NOT NULL AND COALESCE(qi.total_units_needed, 0) > 0
    GROUP BY qi.product_id, p.product_name
  LOOP
    SELECT * INTO v_inv FROM inventory WHERE product_id = v_item.product_id AND location = 'Main Warehouse' FOR UPDATE;
    IF NOT FOUND THEN
      v_shortfalls := array_append(v_shortfalls, v_item.product_name || ': need ' || v_item.qty_needed || ', net position is 0 (no inventory record)');
    ELSE
      v_net_position := v_inv.quantity_available - v_inv.quantity_prebooked + COALESCE(v_inv.quantity_on_order, 0);
      IF v_net_position < v_item.qty_needed THEN
        v_shortfalls := array_append(v_shortfalls, v_item.product_name || ': need ' || v_item.qty_needed || ', net position is ' || GREATEST(v_net_position, 0) || ' (on floor: ' || (v_inv.quantity_available - v_inv.quantity_prebooked) || ', on order: ' || COALESCE(v_inv.quantity_on_order, 0) || ')');
      END IF;
    END IF;
  END LOOP;

  SET LOCAL app.admin_override = 'true';
  UPDATE quotes SET status = 'accepted', updated_at = now() WHERE id = p_quote_id;
  v_order_number := generate_order_number();

  INSERT INTO orders (order_number, quote_id, customer_id, status, commission_split, total_price, total_cost, total_profit, total_margin_pct, order_date)
  VALUES (v_order_number, p_quote_id, v_quote.customer_id, 'confirmed', v_quote.commission_split, v_quote.total_price, v_quote.total_cost, v_quote.total_profit, v_quote.total_margin_pct, current_date)
  RETURNING id INTO v_order_id;

  INSERT INTO order_items (order_id, product_id, quote_item_id, section_name, product_name, price_per_unit, cost_per_unit, actual_rate, rate_unit, acres, total_units_needed, unit_size, total_price, profit, net_margin, quantity_delivered, quantity_remaining)
  SELECT v_order_id, qi.product_id, qi.id, qs.section_name, p.product_name, qi.price_per_unit, qi.current_cost, qi.actual_rate, qi.rate_unit, qi.acres, COALESCE(qi.total_units_needed, 0), qi.unit_size, qi.total_price, qi.profit, qi.net_margin, 0, COALESCE(qi.total_units_needed, 0)
  FROM quote_items qi JOIN quote_sections qs ON qs.id = qi.section_id JOIN products p ON p.id = qi.product_id
  WHERE qi.quote_id = p_quote_id AND qi.product_id IS NOT NULL;

  FOR v_item IN SELECT oi.product_id, oi.total_units_needed, oi.unit_size FROM order_items oi WHERE oi.order_id = v_order_id AND oi.product_id IS NOT NULL AND oi.total_units_needed > 0
  LOOP
    UPDATE inventory SET quantity_prebooked = quantity_prebooked + v_item.total_units_needed, updated_at = now() WHERE product_id = v_item.product_id AND location = 'Main Warehouse';
    IF NOT FOUND THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order, unit_size) VALUES (v_item.product_id, 'Main Warehouse', 0, v_item.total_units_needed, 0, v_item.unit_size);
    END IF;
    INSERT INTO inventory_transactions (product_id, transaction_type, quantity, to_location, order_id, performed_by, notes) VALUES (v_item.product_id, 'booked', v_item.total_units_needed, 'Main Warehouse', v_order_id, v_actor, 'Pre-booked for order ' || v_order_number);
  END LOOP;

  -- Commission: clamp to 0 when profit is negative (FIX from this migration)
  IF v_quote.commission_split IS NOT NULL AND v_quote.commission_split ? 'splits' THEN
    INSERT INTO commissions (order_id, customer_id, recipient, split_percentage, commission_amount, order_profit, order_date, status)
    SELECT v_order_id, v_quote.customer_id, s->>'recipient', (s->>'percentage')::numeric,
      GREATEST(v_quote.total_profit * ((s->>'percentage')::numeric / 100), 0),
      v_quote.total_profit, current_date, 'pending'
    FROM jsonb_array_elements(v_quote.commission_split->'splits') s
    WHERE (s->>'recipient') IS NOT NULL AND (s->>'percentage')::numeric > 0;
  END IF;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('order_created', 'Order ' || v_order_number || ' created from quote ' || v_quote.quote_number || ' for ' || COALESCE(v_customer.farm_name, 'customer') || CASE WHEN array_length(v_shortfalls, 1) > 0 THEN ' (inventory warnings: ' || array_to_string(v_shortfalls, '; ') || ')' ELSE '' END, v_actor, 'order', v_order_id, v_quote.customer_id);

  RETURN jsonb_build_object('status', 'created', 'order_id', v_order_id, 'order_number', v_order_number, 'warnings', to_jsonb(v_shortfalls));
END;
$$;

GRANT EXECUTE ON FUNCTION public.convert_quote_to_order(uuid, uuid, text) TO authenticated;


-- ============================================================================
-- Step 3: Drop unused record_invoice_payment(uuid, bigint, text, text, text)
--         Keep the active (uuid, bigint, text, text, text, text) version as-is
--         (it already has auth, idempotency, period check, overdue support)
-- ============================================================================
DROP FUNCTION IF EXISTS public.record_invoice_payment(uuid, bigint, text, text, text);


-- ============================================================================
-- Step 4: Drop remaining unused overloads (all without p_idempotency_key)
--         The idempotency versions are the active ones called by the frontend.
-- ============================================================================
DROP FUNCTION IF EXISTS public.batch_apply_prepayments(jsonb, uuid);
DROP FUNCTION IF EXISTS public.create_invoice_from_delivery(uuid, uuid);
DROP FUNCTION IF EXISTS public.create_vendor_bill(uuid, uuid, text, date, date, text, bigint, bigint, text, uuid);
DROP FUNCTION IF EXISTS public.issue_return_credit(uuid, uuid);
DROP FUNCTION IF EXISTS public.receive_return(uuid, uuid);
DROP FUNCTION IF EXISTS public.record_vendor_payment(uuid, bigint, date, text, text, text, uuid);
DROP FUNCTION IF EXISTS public.void_vendor_bill(uuid, text);
