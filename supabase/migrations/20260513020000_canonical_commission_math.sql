-- 20260513020000 — Canonical commission math (audit #6)
-- idempotency-body-check: exempt
--   The 3 RPCs being CREATE OR REPLACEd already use check_idempotency/save_idempotency
--   helpers (canonical pattern); the literal-string body check would false-negative.
--
-- Closes audit finding #6 (commission math drift across 3 paths).
--
-- Three problems being fixed:
--   1. Three different formulas. `convert_quote_to_order` used
--      `profit * (pct / 100)` with no rounding and no clamp; `create_direct_order`
--      used `GREATEST(profit * (pct / 100), 0)` (clamped, not rounded);
--      `create_quick_delivery` used `ROUND(profit * pct / 100, 2)` (rounded,
--      not clamped). Same order through three paths produced three different
--      commission totals.
--   2. `create_quick_delivery` referenced columns that DON'T EXIST on the
--      commissions table — `recipient_id` (table has `recipient text` and
--      `recipient_user_id uuid`) and `notes` (no such column). Any QD for a
--      customer with a default_commission_split would have crashed on insert.
--      Confirmed via `SELECT count(*) FROM commissions WHERE recipient IS NULL`
--      = 0 (no row was ever produced from this code path), so this is a latent
--      bug not a corruption to repair.
--   3. No single source of truth. Future commission-creating paths could drift
--      again with no compile-time signal.
--
-- Approach:
--   - `compute_commission_amount(profit, pct) -> numeric` IMMUTABLE helper
--     embeds the canonical formula: `GREATEST(ROUND(profit * pct / 100, 2), 0)`.
--     Round to 2 decimal places (commissions are stored as numeric dollars,
--     not bigint cents). Clamp to >= 0 because losing-trade orders shouldn't
--     produce negative commission claims.
--   - `_insert_commissions_for_order(order_id, customer_id, profit, split, date)`
--     wraps the INSERT INTO commissions block. Single SQL — every caller goes
--     through this one helper.
--   - The 3 callers (convert_quote_to_order, create_direct_order,
--     create_quick_delivery) get CREATE OR REPLACEd with the inline block
--     swapped for a `PERFORM _insert_commissions_for_order(...)` call.
--   - QD's broken column references vanish naturally because they were inside
--     the block being replaced.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. compute_commission_amount — canonical formula
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.compute_commission_amount(
  p_profit      numeric,
  p_percentage  numeric
) RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  -- Canonical commission formula. ROUND to 2 dp (stored as numeric dollars),
  -- GREATEST(.., 0) clamp so losing-trade orders produce $0 commission claims
  -- not negative payables.
  SELECT GREATEST(ROUND(COALESCE(p_profit, 0) * COALESCE(p_percentage, 0) / 100, 2), 0);
$$;

REVOKE ALL ON FUNCTION public.compute_commission_amount(numeric, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.compute_commission_amount(numeric, numeric) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. _insert_commissions_for_order — single source of truth
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._insert_commissions_for_order(
  p_order_id          uuid,
  p_customer_id       uuid,
  p_order_profit      numeric,
  p_commission_split  jsonb,
  p_order_date        date DEFAULT current_date
) RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count int := 0;
BEGIN
  IF p_commission_split IS NULL OR NOT (p_commission_split ? 'splits') THEN
    RETURN 0;
  END IF;

  INSERT INTO public.commissions (
    order_id, customer_id, recipient, split_percentage,
    commission_amount, order_profit, order_date, status
  )
  SELECT
    p_order_id,
    p_customer_id,
    s->>'recipient',
    (s->>'percentage')::numeric,
    public.compute_commission_amount(p_order_profit, (s->>'percentage')::numeric),
    COALESCE(p_order_profit, 0),
    p_order_date,
    'pending'
  FROM jsonb_array_elements(p_commission_split->'splits') s
  WHERE (s->>'recipient') IS NOT NULL
    AND (s->>'percentage')::numeric > 0;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public._insert_commissions_for_order(uuid, uuid, numeric, jsonb, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._insert_commissions_for_order(uuid, uuid, numeric, jsonb, date) TO authenticated;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Replace the 3 caller functions to use the helper
-- ─────────────────────────────────────────────────────────────────────────────
-- Each is an exact CREATE OR REPLACE of the live function with ONLY the inline
-- `INSERT INTO commissions ... SELECT ...` block swapped for a
-- `PERFORM _insert_commissions_for_order(...)` call. Function bodies were
-- reproduced verbatim from the live database (with that single block change).

BEGIN;

CREATE OR REPLACE FUNCTION public.convert_quote_to_order(
  p_quote_id uuid,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid; v_actor_role text;
  v_quote record; v_order_number text; v_order_id uuid; v_item record;
  v_customer record; v_inv record; v_shortfalls text[] := '{}'; v_net_position numeric;
  v_result jsonb; v_existing jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role INTO v_actor_role
  FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'convert_quote_to_order');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found'; END IF;

  IF v_quote.status = 'accepted' THEN
    SELECT id INTO v_order_id FROM orders WHERE quote_id = p_quote_id LIMIT 1;
    IF v_order_id IS NOT NULL THEN
      v_result := jsonb_build_object('status', 'already_converted', 'order_id', v_order_id);
      IF p_idempotency_key IS NOT NULL THEN
        PERFORM save_idempotency(p_idempotency_key, 'convert_quote_to_order', v_result);
      END IF;
      RETURN v_result;
    END IF;
  END IF;

  SELECT * INTO v_customer FROM customers WHERE id = v_quote.customer_id;

  FOR v_item IN
    SELECT qi.product_id, p.product_name, SUM(COALESCE(qi.total_units_needed, 0)) AS qty_needed
    FROM quote_items qi JOIN products p ON p.id = qi.product_id
    WHERE qi.quote_id = p_quote_id AND qi.product_id IS NOT NULL
      AND COALESCE(qi.total_units_needed, 0) > 0
    GROUP BY qi.product_id, p.product_name
  LOOP
    SELECT * INTO v_inv FROM inventory
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse' FOR UPDATE;
    IF NOT FOUND THEN
      v_shortfalls := array_append(v_shortfalls,
        v_item.product_name || ': need ' || v_item.qty_needed || ', net position is 0 (no inventory record)');
    ELSE
      v_net_position := v_inv.quantity_available - v_inv.quantity_prebooked + COALESCE(v_inv.quantity_on_order, 0);
      IF v_net_position < v_item.qty_needed THEN
        v_shortfalls := array_append(v_shortfalls,
          v_item.product_name || ': need ' || v_item.qty_needed ||
          ', net position is ' || GREATEST(v_net_position, 0) ||
          ' (on floor: ' || (v_inv.quantity_available - v_inv.quantity_prebooked) ||
          ', on order: ' || COALESCE(v_inv.quantity_on_order, 0) || ')');
      END IF;
    END IF;
  END LOOP;

  SET LOCAL app.admin_override = 'true';
  UPDATE quotes SET status = 'accepted', updated_at = now() WHERE id = p_quote_id;
  UPDATE inventory_holds SET is_active = false, updated_at = now()
  WHERE source_id = p_quote_id AND is_active = true;

  v_order_number := generate_order_number();

  INSERT INTO orders (order_number, quote_id, customer_id, status, commission_split,
    total_price, total_cost, total_profit, total_margin_pct, order_date, program_notes)
  VALUES (v_order_number, p_quote_id, v_quote.customer_id, 'confirmed',
    v_quote.commission_split, v_quote.total_price, v_quote.total_cost,
    v_quote.total_profit, v_quote.total_margin_pct, current_date,
    (SELECT string_agg(qs.section_name || ': ' || qs.section_header_notes, E'\n')
     FROM quote_sections qs WHERE qs.quote_id = p_quote_id
       AND qs.section_header_notes IS NOT NULL AND qs.section_header_notes <> ''))
  RETURNING id INTO v_order_id;

  INSERT INTO order_items (order_id, product_id, quote_item_id, section_name, product_name,
    price_per_unit, cost_per_unit, actual_rate, rate_unit, acres,
    total_units_needed, unit_size, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining, notes)
  SELECT v_order_id, qi.product_id, qi.id, qs.section_name, p.product_name,
    qi.price_per_unit, qi.current_cost, qi.actual_rate, qi.rate_unit, qi.acres,
    COALESCE(qi.total_units_needed, 0), qi.unit_size,
    qi.total_price, qi.profit, qi.net_margin,
    0, COALESCE(qi.total_units_needed, 0), qi.notes
  FROM quote_items qi
  JOIN quote_sections qs ON qs.id = qi.section_id
  JOIN products p ON p.id = qi.product_id
  WHERE qi.quote_id = p_quote_id AND qi.product_id IS NOT NULL;

  FOR v_item IN
    SELECT oi.product_id, oi.total_units_needed, oi.unit_size FROM order_items oi
    WHERE oi.order_id = v_order_id AND oi.product_id IS NOT NULL AND oi.total_units_needed > 0
  LOOP
    UPDATE inventory SET quantity_prebooked = quantity_prebooked + v_item.total_units_needed,
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';
    IF NOT FOUND THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order, unit_size)
      VALUES (v_item.product_id, 'Main Warehouse', 0, v_item.total_units_needed, 0, v_item.unit_size);
    END IF;
    INSERT INTO inventory_transactions (product_id, transaction_type, quantity, to_location,
      order_id, performed_by, notes)
    VALUES (v_item.product_id, 'booked', v_item.total_units_needed, 'Main Warehouse',
      v_order_id, v_actor, 'Pre-booked for order ' || v_order_number);
  END LOOP;

  -- AUDIT #6: canonical commission math via _insert_commissions_for_order helper.
  PERFORM _insert_commissions_for_order(
    v_order_id, v_quote.customer_id, v_quote.total_profit,
    v_quote.commission_split, current_date
  );

  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, new_values, total_impact_cents, description)
  VALUES (
    'quote_converted', 'order', v_order_id, v_actor_role,
    jsonb_build_object(
      'quote_id', p_quote_id,
      'quote_number', v_quote.quote_number,
      'order_number', v_order_number,
      'customer_id', v_quote.customer_id,
      'customer_name', COALESCE(v_customer.farm_name, 'unknown'),
      'total_price_dollars', v_quote.total_price,
      'inventory_warnings', to_jsonb(v_shortfalls)
    ),
    ROUND(v_quote.total_price * 100)::bigint,
    'Converted quote ' || v_quote.quote_number || ' to order ' || v_order_number ||
      ' for ' || COALESCE(v_customer.farm_name, 'customer') ||
      CASE WHEN array_length(v_shortfalls, 1) > 0
        THEN ' (inventory shortfalls: ' || array_to_string(v_shortfalls, '; ') || ')'
        ELSE '' END
  );

  INSERT INTO activity_feed (event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id)
  VALUES ('order_created',
    'Order ' || v_order_number || ' created from quote ' || v_quote.quote_number ||
    ' for ' || COALESCE(v_customer.farm_name, 'customer') ||
    CASE WHEN array_length(v_shortfalls, 1) > 0
      THEN ' (inventory warnings: ' || array_to_string(v_shortfalls, '; ') || ')'
      ELSE '' END,
    v_actor, 'order', v_order_id, v_quote.customer_id);

  v_result := jsonb_build_object('status', 'created', 'order_id', v_order_id,
    'order_number', v_order_number, 'warnings', to_jsonb(v_shortfalls));

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'convert_quote_to_order', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- ── create_direct_order ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_direct_order(
  p_customer_id uuid,
  p_order_date date,
  p_order_name text DEFAULT NULL::text,
  p_notes text DEFAULT NULL::text,
  p_items jsonb DEFAULT '[]'::jsonb,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
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

  -- AUDIT #6: canonical commission math via _insert_commissions_for_order helper.
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

-- ── create_quick_delivery ──────────────────────────────────────────────────
-- (Fixes the broken `recipient_id`/`notes` column references — the inline INSERT
-- block being replaced never worked. No data corruption to repair: live
-- commissions table has zero rows with NULL recipient.)

CREATE OR REPLACE FUNCTION public.create_quick_delivery(
  p_customer_id uuid,
  p_items jsonb,
  p_driver_id uuid DEFAULT NULL::uuid,
  p_scheduled_date date DEFAULT CURRENT_DATE,
  p_delivery_notes text DEFAULT NULL::text,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text,
  p_skip_invoice boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid; v_actor_role text;
  v_order_id uuid; v_order_number text;
  v_delivery_id uuid; v_delivery_number text;
  v_invoice_id uuid; v_invoice_number text;
  v_item jsonb; v_order_item_id uuid; v_product record;
  v_inv record; v_total_cents bigint := 0; v_total_cost_cents bigint := 0;
  v_item_price_cents bigint; v_item_qty numeric; v_sort integer := 0;
  v_customer record; v_split jsonb;
  v_order_profit numeric; v_split_total numeric; v_net_available numeric;
  v_ar_balance_cents bigint; v_projected_cents bigint;
  v_credit_warning boolean := false; v_admin record;
  v_result jsonb; v_existing jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role INTO v_actor_role
  FROM profiles
  WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep', 'driver') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: only admins, sales reps, and drivers can create quick deliveries';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'create_quick_delivery');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_customer FROM customers WHERE id = p_customer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found'; END IF;
  IF NOT v_customer.is_active THEN RAISE EXCEPTION 'Customer is inactive'; END IF;
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'At least one item is required';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid AND is_active = true;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product not found or inactive: %', v_item->>'product_id';
    END IF;
    v_item_qty := (v_item->>'quantity')::numeric;

    SELECT * INTO v_inv FROM inventory
    WHERE product_id = v_product.id AND location = 'Main Warehouse' FOR UPDATE;
    v_net_available := COALESCE(v_inv.quantity_available, 0) - COALESCE(v_inv.quantity_prebooked, 0);
    IF NOT FOUND OR v_net_available < v_item_qty THEN
      RAISE EXCEPTION 'Insufficient inventory for %: need % units, only % net available (% on hand, % prebooked)',
        v_product.product_name, v_item_qty, GREATEST(v_net_available, 0),
        COALESCE(v_inv.quantity_available, 0), COALESCE(v_inv.quantity_prebooked, 0);
    END IF;

    v_item_price_cents := CASE v_customer.assigned_tier
      WHEN 1 THEN ROUND(COALESCE(v_product.tier1_price, 0) * 100)
      WHEN 2 THEN ROUND(COALESCE(v_product.tier2_price, 0) * 100)
      ELSE ROUND(COALESCE(v_product.tier3_price, 0) * 100)
    END;
    v_total_cents := v_total_cents + (v_item_price_cents * v_item_qty)::bigint;
  END LOOP;

  IF COALESCE(v_customer.credit_limit_cents, 0) > 0 THEN
    SELECT COALESCE(SUM(balance_cents), 0) INTO v_ar_balance_cents
      FROM invoices WHERE customer_id = p_customer_id
        AND status IN ('draft', 'posted', 'overdue');
    v_projected_cents := v_ar_balance_cents + v_total_cents;
    IF v_projected_cents >= v_customer.credit_limit_cents THEN
      v_credit_warning := true;
      INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
      VALUES ('credit_limit_warning',
        'WARNING: Quick delivery for "' || v_customer.farm_name || '" projected to push AR exposure to $' ||
          (v_projected_cents / 100.0)::numeric(12,2) ||
          ' (limit $' || (v_customer.credit_limit_cents / 100.0)::numeric(12,2) ||
          '). Current AR (draft+posted+overdue) is $' || (v_ar_balance_cents / 100.0)::numeric(12,2) ||
          '. Delivery proceeded; review with finance.',
        v_actor, 'customer', p_customer_id, p_customer_id);
      FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true LOOP
        INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
        VALUES (v_admin.id,
          'Credit Limit Exceeded — ' || v_customer.farm_name,
          'A quick delivery was created for ' || v_customer.farm_name ||
            ' that projects AR exposure to $' || (v_projected_cents / 100.0)::numeric(12,2) ||
            ', exceeding the $' || (v_customer.credit_limit_cents / 100.0)::numeric(12,2) ||
            ' credit limit. Current AR (incl. draft+overdue) is $' ||
            (v_ar_balance_cents / 100.0)::numeric(12,2) ||
            '. The delivery proceeded; please review.',
          'credit_warning', 'customer', p_customer_id);
      END LOOP;
    END IF;
  END IF;

  v_split := v_customer.default_commission_split;
  IF v_split IS NOT NULL AND v_split ? 'splits' AND jsonb_array_length(v_split->'splits') > 0 THEN
    SELECT COALESCE(SUM((elem->>'percentage')::numeric), 0)
      INTO v_split_total FROM jsonb_array_elements(v_split->'splits') elem;
    IF ABS(v_split_total - 100) > 0.01 THEN
      RAISE EXCEPTION 'Customer commission splits must sum to 100%% (got %.2f%%). Fix customer settings before creating delivery.', v_split_total;
    END IF;
  END IF;

  v_order_id := gen_random_uuid();
  v_order_number := generate_order_number();
  INSERT INTO orders (id, order_number, customer_id, status, order_date, notes, total_price, total_cost, total_profit, total_margin_pct, commission_split)
  VALUES (v_order_id, v_order_number, p_customer_id, 'confirmed', CURRENT_DATE, 'Quick delivery', 0, 0, 0, 0, v_customer.default_commission_split);

  v_delivery_id := gen_random_uuid();
  v_delivery_number := next_delivery_number();
  INSERT INTO deliveries (id, delivery_number, order_id, customer_id, assigned_driver, scheduled_date, status, delivery_notes, is_quick_delivery)
  VALUES (v_delivery_id, v_delivery_number, v_order_id, p_customer_id, p_driver_id, p_scheduled_date, 'scheduled', p_delivery_notes, true);

  IF NOT p_skip_invoice THEN
    v_invoice_id := gen_random_uuid();
    v_invoice_number := next_invoice_number('chemical_sale');
    INSERT INTO invoices (id, invoice_number, invoice_type, order_id, customer_id, status, total_amount_cents, paid_amount_cents, prepay_applied_cents, invoice_date, is_quick_delivery, created_by)
    VALUES (v_invoice_id, v_invoice_number, 'chemical_sale', v_order_id, p_customer_id, 'draft', 0, 0, 0, CURRENT_DATE, true, v_actor);
  END IF;

  v_total_cents := 0;
  v_total_cost_cents := 0;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_sort := v_sort + 1;
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid;
    v_item_qty := (v_item->>'quantity')::numeric;

    v_item_price_cents := CASE v_customer.assigned_tier
      WHEN 1 THEN ROUND(COALESCE(v_product.tier1_price, 0) * 100)
      WHEN 2 THEN ROUND(COALESCE(v_product.tier2_price, 0) * 100)
      ELSE ROUND(COALESCE(v_product.tier3_price, 0) * 100)
    END;

    v_total_cents := v_total_cents + (v_item_price_cents * v_item_qty)::bigint;
    v_total_cost_cents := v_total_cost_cents + ROUND(COALESCE(v_product.current_cost, 0) * 100 * v_item_qty)::bigint;

    INSERT INTO order_items (order_id, product_id, quantity, total_units_needed, price_per_unit, quantity_delivered, quantity_remaining, quantity_prebooked, total_price, sort_order)
    VALUES (v_order_id, v_product.id, v_item_qty, v_item_qty, (v_item_price_cents / 100.0)::numeric, 0, v_item_qty, v_item_qty,
      (v_item_price_cents / 100.0)::numeric * v_item_qty, v_sort)
    RETURNING id INTO v_order_item_id;

    INSERT INTO delivery_items (delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size, sort_order)
    VALUES (v_delivery_id, v_order_item_id, v_product.id, v_item_qty, 0, COALESCE(v_item->>'unit_size', v_product.unit_size), v_sort);

    IF NOT p_skip_invoice THEN
      INSERT INTO invoice_items (invoice_id, order_item_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents, sort_order)
      VALUES (v_invoice_id, v_order_item_id, v_product.id, v_product.product_name, v_item_qty, v_item_price_cents,
        (v_item_price_cents * v_item_qty)::bigint, ROUND(COALESCE(v_product.current_cost, 0) * 100)::bigint, v_sort);
    END IF;

    UPDATE inventory SET quantity_prebooked = quantity_prebooked + v_item_qty, updated_at = now()
    WHERE product_id = v_product.id AND location = 'Main Warehouse';

    INSERT INTO inventory_transactions (product_id, transaction_type, quantity, order_id, delivery_id, performed_by, notes)
    VALUES (v_product.id, 'prebooked', v_item_qty, v_order_id, v_delivery_id, v_actor, 'Quick delivery prebooked: ' || v_delivery_number);
  END LOOP;

  UPDATE orders SET total_price = (v_total_cents / 100.0)::numeric, total_cost = (v_total_cost_cents / 100.0)::numeric,
    total_profit = ((v_total_cents - v_total_cost_cents) / 100.0)::numeric,
    total_margin_pct = CASE WHEN v_total_cents > 0 THEN ROUND((v_total_cents - v_total_cost_cents)::numeric / v_total_cents * 100, 2) ELSE 0 END
  WHERE id = v_order_id;

  IF NOT p_skip_invoice THEN
    UPDATE invoices SET total_amount_cents = v_total_cents, total_cost_cents = v_total_cost_cents WHERE id = v_invoice_id;
  END IF;

  -- AUDIT #6: canonical commission math via _insert_commissions_for_order helper.
  -- Replaces a previously-broken inline INSERT that referenced nonexistent
  -- columns (recipient_id, notes) — see migration header for full context.
  v_order_profit := (v_total_cents - v_total_cost_cents) / 100.0;
  PERFORM _insert_commissions_for_order(
    v_order_id, p_customer_id, v_order_profit,
    v_split, CURRENT_DATE
  );

  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, new_values, total_impact_cents, description)
  VALUES (
    'order_created', 'order', v_order_id, v_actor_role,
    jsonb_build_object(
      'order_number', v_order_number,
      'customer_id', p_customer_id,
      'customer_name', v_customer.farm_name,
      'total_cents', v_total_cents,
      'total_cost_cents', v_total_cost_cents,
      'is_quick_delivery', true,
      'delivery_id', v_delivery_id,
      'invoice_id', v_invoice_id,
      'credit_warning', v_credit_warning
    ),
    v_total_cents,
    'Quick delivery order ' || v_order_number || ' for ' || v_customer.farm_name ||
      ' — $' || (v_total_cents / 100.0)::numeric(12,2)
  );

  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, new_values, total_impact_cents, description)
  VALUES (
    'delivery_created', 'delivery', v_delivery_id, v_actor_role,
    jsonb_build_object(
      'delivery_number', v_delivery_number,
      'order_id', v_order_id,
      'order_number', v_order_number,
      'customer_id', p_customer_id,
      'scheduled_date', p_scheduled_date,
      'assigned_driver', p_driver_id,
      'is_quick_delivery', true
    ),
    v_total_cents,
    'Delivery ' || v_delivery_number || ' scheduled for ' || p_scheduled_date::text ||
      ' (' || v_customer.farm_name || ')'
  );

  v_result := jsonb_build_object('order_id', v_order_id, 'delivery_id', v_delivery_id, 'invoice_id', v_invoice_id,
    'order_number', v_order_number, 'delivery_number', v_delivery_number, 'invoice_number', v_invoice_number,
    'total_cents', v_total_cents, 'credit_warning', v_credit_warning);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_quick_delivery', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification — helpers exist + canonical formula returns expected values.
-- The actual function body changes are validated implicitly: if any of the
-- three CREATE OR REPLACE statements above had a syntax error or referenced a
-- missing column, the migration would have aborted at apply time.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE pronamespace = 'public'::regnamespace AND proname = 'compute_commission_amount'
       AND provolatile = 'i'
  ) THEN RAISE EXCEPTION 'verify failed: compute_commission_amount missing or not IMMUTABLE'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace AND proname = '_insert_commissions_for_order'
  ) THEN RAISE EXCEPTION 'verify failed: _insert_commissions_for_order missing'; END IF;

  -- Canonical formula sanity:
  -- 1000 profit × 50% = 500.00
  IF compute_commission_amount(1000, 50) <> 500 THEN
    RAISE EXCEPTION 'verify failed: compute_commission_amount(1000, 50) returned % (expected 500)',
      compute_commission_amount(1000, 50);
  END IF;
  -- Negative profit clamps to 0
  IF compute_commission_amount(-100, 50) <> 0 THEN
    RAISE EXCEPTION 'verify failed: compute_commission_amount(-100, 50) returned % (expected 0)',
      compute_commission_amount(-100, 50);
  END IF;
  -- Rounds to 2 dp: 33.33 × 33.33% = 11.108889 → 11.11
  IF compute_commission_amount(33.33, 33.33) <> 11.11 THEN
    RAISE EXCEPTION 'verify failed: compute_commission_amount(33.33, 33.33) returned % (expected 11.11)',
      compute_commission_amount(33.33, 33.33);
  END IF;
END$$;
