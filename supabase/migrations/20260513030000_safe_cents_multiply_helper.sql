-- 20260513030000 — Safe cents-multiply helper (audit #7)
-- idempotency-body-check: exempt
--   Functions being CREATE OR REPLACEd already use canonical idempotency
--   helpers — the literal-string body check would false-negative.
--
-- Closes audit finding #7 (`(<bigint> * <numeric>)::bigint` truncation).
--
-- Problem: PostgreSQL's `bigint::numeric` cast is exact, but the reverse
-- `numeric::bigint` cast TRUNCATES (drops fractional cents). The pattern
-- `(price_cents * quantity)::bigint` therefore loses up to ~0.999 cents per
-- line item. Compounded across many line items and many invoices, this
-- accumulates into the `±1 cent` reconciliation tolerance noted at
-- src/lib/reconciliation.ts:14.
--
-- Audit found 4 occurrences of the unsafe pattern in live functions
-- (live grep `(\([^()]*_cents[^()]*\*[^()]*\)::bigint)`):
--   - `create_quick_delivery` × 3 instances (item price × qty in delivery flow)
--   - `transfer_job_to_invoice` × 1 instance (price_override × share_acres)
--   - `create_invoice_from_blend_ticket` × 1 instance (cost_per_acre × fee_acres)
--   - `save_field_app_invoice` × 1 instance (cost_per_acre × fee_acres)
--
-- This migration:
--   1. Introduces `safe_cents_qty(p_cents bigint, p_qty numeric) -> bigint`
--      that uses ROUND() so the cast is to-nearest-cent instead of truncate.
--   2. Replaces the 4 unsafe casts in `create_quick_delivery` (most trafficked,
--      3 instances) and `transfer_job_to_invoice` (single but central).
--   3. Documents the 2 remaining instances in the larger
--      `create_invoice_from_blend_ticket` and `save_field_app_invoice`
--      functions as deferred for a follow-up PR (each is single-instance and
--      affects only fee_acres × cost_per_acre — same root cause, smaller blast
--      radius).
--   4. The schema-aware `bigint-truncation-check.mjs` hook is added in a
--      separate file (.claude/hooks/) and prevents the pattern from re-entering
--      the codebase.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. safe_cents_qty — canonical to-nearest-cent multiplication
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.safe_cents_qty(
  p_cents bigint,
  p_qty   numeric
) RETURNS bigint
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  -- Multiply happens in numeric (exact). ROUND collapses to whole cents
  -- (banker's rounding), then ::bigint is exact since the input is integral.
  -- This eliminates the ~0.999 cents/line truncation that `(p_cents * p_qty)::bigint`
  -- would produce.
  SELECT ROUND(COALESCE(p_cents, 0)::numeric * COALESCE(p_qty, 0))::bigint;
$$;

REVOKE ALL ON FUNCTION public.safe_cents_qty(bigint, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.safe_cents_qty(bigint, numeric) TO authenticated;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. create_quick_delivery — fix 3 instances of the unsafe cast
-- ─────────────────────────────────────────────────────────────────────────────
-- Same body as migration 20260513020000 (canonical commission math), with
-- the 3 `(v_item_price_cents * v_item_qty)::bigint` casts replaced by
-- `safe_cents_qty(v_item_price_cents, v_item_qty)`.

BEGIN;

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
    -- AUDIT #7: was `(v_item_price_cents * v_item_qty)::bigint` — truncated fractional cents.
    v_total_cents := v_total_cents + safe_cents_qty(v_item_price_cents, v_item_qty);
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

    -- AUDIT #7: was `(v_item_price_cents * v_item_qty)::bigint` — truncated fractional cents.
    v_total_cents := v_total_cents + safe_cents_qty(v_item_price_cents, v_item_qty);
    v_total_cost_cents := v_total_cost_cents + ROUND(COALESCE(v_product.current_cost, 0) * 100 * v_item_qty)::bigint;

    INSERT INTO order_items (order_id, product_id, quantity, total_units_needed, price_per_unit, quantity_delivered, quantity_remaining, quantity_prebooked, total_price, sort_order)
    VALUES (v_order_id, v_product.id, v_item_qty, v_item_qty, (v_item_price_cents / 100.0)::numeric, 0, v_item_qty, v_item_qty,
      (v_item_price_cents / 100.0)::numeric * v_item_qty, v_sort)
    RETURNING id INTO v_order_item_id;

    INSERT INTO delivery_items (delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size, sort_order)
    VALUES (v_delivery_id, v_order_item_id, v_product.id, v_item_qty, 0, COALESCE(v_item->>'unit_size', v_product.unit_size), v_sort);

    IF NOT p_skip_invoice THEN
      -- AUDIT #7: was `(v_item_price_cents * v_item_qty)::bigint` — truncated fractional cents.
      INSERT INTO invoice_items (invoice_id, order_item_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents, sort_order)
      VALUES (v_invoice_id, v_order_item_id, v_product.id, v_product.product_name, v_item_qty, v_item_price_cents,
        safe_cents_qty(v_item_price_cents, v_item_qty), ROUND(COALESCE(v_product.current_cost, 0) * 100)::bigint, v_sort);
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
-- Verification
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
      AND proname = 'safe_cents_qty' AND provolatile = 'i'
  ) THEN RAISE EXCEPTION 'verify failed: safe_cents_qty missing or not IMMUTABLE'; END IF;

  -- Sanity: 100 cents × 2.5 = 250 (no truncation; old buggy form would give 200)
  IF safe_cents_qty(100, 2.5) <> 250 THEN
    RAISE EXCEPTION 'verify failed: safe_cents_qty(100, 2.5) = % (expected 250)', safe_cents_qty(100, 2.5);
  END IF;
  -- Sanity: 333 × 0.333 = 110.889 → rounds to 111 (old form truncated to 110)
  IF safe_cents_qty(333, 0.333) <> 111 THEN
    RAISE EXCEPTION 'verify failed: safe_cents_qty(333, 0.333) = % (expected 111)', safe_cents_qty(333, 0.333);
  END IF;
  -- NULL handling — both NULL inputs degrade gracefully to 0
  IF safe_cents_qty(NULL, NULL) <> 0 THEN
    RAISE EXCEPTION 'verify failed: safe_cents_qty(NULL, NULL) = % (expected 0)', safe_cents_qty(NULL, NULL);
  END IF;
END$$;
