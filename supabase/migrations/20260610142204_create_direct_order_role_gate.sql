-- idempotency-body-check: exempt
-- ============================================================================
-- create_direct_order: add the missing admin/sales_rep role gate (audit W1)
-- ----------------------------------------------------------------------------
-- Finding: docs/audits/2026-06-10-sell-side-excellence-audit.md §4 W1.
-- The live function checked auth.uid() + actor-mismatch but NEVER checked the
-- caller's role, so any authenticated user (driver/applicator) could create
-- confirmed orders (with inventory prebooks + commission rows) by calling the
-- RPC directly. Every actor-forgery sweep skipped it because it DOES reference
-- auth.uid() — auth-only is not role-gated.
--
-- Fix: insert the canonical role check (matching convert_quote_to_order)
-- after the actor-mismatch check and BEFORE the idempotency check, so cached
-- results never leak to unauthorized callers. Role set mirrors the UI route
-- (App.tsx:178 — admin, sales_rep). Body otherwise VERBATIM from live
-- (pre-apply prosrc md5 b16e630f34242ea92ffe0ee89d1bf0f7; post-apply
-- fidelity check: prosrc minus the two inserted fragments == that md5).
-- Existing error strings ('Authentication required', 'Actor mismatch') are
-- deliberately left untouched to avoid changing caller-visible behavior.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_direct_order(p_customer_id uuid, p_order_date date, p_order_name text DEFAULT NULL, p_notes text DEFAULT NULL, p_items jsonb DEFAULT '[]'::jsonb, p_performed_by uuid DEFAULT NULL, p_idempotency_key text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_actor_role text;
  v_order_id uuid;
  v_order_number text;
  v_item jsonb;
  v_total_price numeric := 0;
  v_total_cost numeric := 0;
  v_total_profit numeric;
  v_total_margin_pct numeric;
  v_customer record;
  v_cached_result jsonb;
  v_result jsonb;
  v_inv record;
  v_warnings text[] := '{}';
  v_qty numeric;
  v_net_position numeric;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by <> v_actor THEN
    RAISE EXCEPTION 'Actor mismatch';
  END IF;

  SELECT role INTO v_actor_role
  FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'create_direct_order');
    IF v_cached_result IS NOT NULL THEN RETURN v_cached_result; END IF;
  END IF;

  SELECT * INTO v_customer FROM customers WHERE id = p_customer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found: %', p_customer_id; END IF;

  v_order_number := generate_order_number();

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF (v_item->>'product_id') IS NULL THEN CONTINUE; END IF;
    v_qty := COALESCE((v_item->>'quantity')::numeric, 0);
    IF v_qty <= 0 THEN CONTINUE; END IF;
    SELECT * INTO v_inv FROM inventory
    WHERE product_id = (v_item->>'product_id')::uuid AND location = 'Main Warehouse';
    IF NOT FOUND THEN
      v_warnings := array_append(v_warnings,
        COALESCE(v_item->>'product_name', 'Unknown product') ||
        ': need ' || v_qty || ', net position is 0 (no inventory record)');
    ELSE
      v_net_position := v_inv.quantity_available - v_inv.quantity_prebooked + COALESCE(v_inv.quantity_on_order, 0);
      IF v_net_position < v_qty THEN
        v_warnings := array_append(v_warnings,
          COALESCE(v_item->>'product_name', 'Unknown product') ||
          ': need ' || v_qty ||
          ', net position is ' || GREATEST(v_net_position, 0) ||
          ' (on floor: ' || (v_inv.quantity_available - v_inv.quantity_prebooked) ||
          ', on order: ' || COALESCE(v_inv.quantity_on_order, 0) || ')');
      END IF;
    END IF;
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_total_price := v_total_price
      + COALESCE((v_item->>'quantity')::numeric, 0)
      * COALESCE((v_item->>'price_per_unit')::numeric, 0);
    v_total_cost := v_total_cost
      + COALESCE((v_item->>'quantity')::numeric, 0)
      * COALESCE((v_item->>'unit_cost')::numeric, 0);
  END LOOP;

  v_total_profit := v_total_price - v_total_cost;
  v_total_margin_pct := CASE
    WHEN v_total_price > 0 THEN (v_total_profit / v_total_price) * 100
    ELSE 0
  END;

  INSERT INTO orders (
    order_number, order_name, customer_id, status,
    total_price, total_cost, total_profit, total_margin_pct,
    order_date, notes
  ) VALUES (
    v_order_number, NULLIF(TRIM(COALESCE(p_order_name, '')), ''),
    p_customer_id, 'confirmed',
    v_total_price, v_total_cost, v_total_profit, v_total_margin_pct,
    p_order_date,
    NULLIF(TRIM(COALESCE(p_notes, '')), '')
  ) RETURNING id INTO v_order_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF (v_item->>'product_id') IS NULL OR COALESCE((v_item->>'quantity')::numeric, 0) <= 0 THEN
      CONTINUE;
    END IF;
    INSERT INTO order_items (
      order_id, product_id, product_name,
      price_per_unit, cost_per_unit,
      total_units_needed, unit_size,
      total_price, profit, net_margin,
      quantity_delivered, quantity_remaining
    ) VALUES (
      v_order_id, (v_item->>'product_id')::uuid, v_item->>'product_name',
      COALESCE((v_item->>'price_per_unit')::numeric, 0),
      COALESCE((v_item->>'unit_cost')::numeric, 0),
      (v_item->>'quantity')::numeric, v_item->>'unit_size',
      COALESCE((v_item->>'quantity')::numeric, 0) * COALESCE((v_item->>'price_per_unit')::numeric, 0),
      (COALESCE((v_item->>'price_per_unit')::numeric, 0) - COALESCE((v_item->>'unit_cost')::numeric, 0))
        * COALESCE((v_item->>'quantity')::numeric, 0),
      CASE WHEN COALESCE((v_item->>'price_per_unit')::numeric, 0) > 0
        THEN ((COALESCE((v_item->>'price_per_unit')::numeric, 0) - COALESCE((v_item->>'unit_cost')::numeric, 0))
              / (v_item->>'price_per_unit')::numeric) * 100
        ELSE 0
      END,
      0, (v_item->>'quantity')::numeric
    );
    UPDATE inventory SET
      quantity_prebooked = quantity_prebooked + (v_item->>'quantity')::numeric,
      updated_at = now()
    WHERE product_id = (v_item->>'product_id')::uuid AND location = 'Main Warehouse';
    IF NOT FOUND THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order, unit_size)
      VALUES ((v_item->>'product_id')::uuid, 'Main Warehouse', 0, (v_item->>'quantity')::numeric, 0, v_item->>'unit_size');
    END IF;
    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      order_id, performed_by, notes
    ) VALUES (
      (v_item->>'product_id')::uuid, 'booked', (v_item->>'quantity')::numeric,
      'Main Warehouse', v_order_id, v_actor,
      'Pre-booked for order ' || v_order_number
    );
  END LOOP;

  PERFORM _insert_commissions_for_order(
    v_order_id, p_customer_id, v_total_profit,
    v_customer.default_commission_split, p_order_date
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'order_created',
    'Direct order ' || v_order_number || COALESCE(' (' || NULLIF(TRIM(COALESCE(p_order_name, '')), '') || ')', '') || ' created for ' || COALESCE(v_customer.farm_name, 'customer') ||
    CASE WHEN array_length(v_warnings, 1) > 0
      THEN ' (inventory warnings: ' || array_to_string(v_warnings, '; ') || ')'
      ELSE '' END,
    v_actor, 'order', v_order_id, p_customer_id
  );

  v_result := jsonb_build_object(
    'status', 'created', 'order_id', v_order_id,
    'order_number', v_order_number, 'warnings', to_jsonb(v_warnings)
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_direct_order', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Self-verification: exactly one overload, gate present
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_count int;
  v_src text;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc
  WHERE proname = 'create_direct_order' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'create_direct_order overload count = %, expected 1', v_count;
  END IF;

  SELECT prosrc INTO v_src
  FROM pg_proc
  WHERE proname = 'create_direct_order' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%INSUFFICIENT_ROLE%' THEN
    RAISE EXCEPTION 'create_direct_order role gate missing after apply';
  END IF;
END $$;
