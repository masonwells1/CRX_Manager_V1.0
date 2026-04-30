-- =============================================================================
-- Migration: 20260430240000_field_app_workflow_phase12.sql
-- Phase 12 — Sprint A3 (delivery RPC auth gates) + part of Sprint D
--
-- Sprint A3: tighten actor validation on the 3 delivery RPCs, replacing the
--   `v_actor := COALESCE(p_performed_by, auth.uid())` anti-pattern with a
--   strict check. Each function's existing role check stays in place.
--
-- Sprint D (folded, mechanical part only): complete_delivery now requires
--   status='in_progress' before completion. Previously it allowed completing
--   a delivery directly from 'scheduled', skipping the start/confirm step.
--   The drivers-can-complete and auto-invoice business decisions still
--   require Mason's input and are deferred to Sprint D-policy.
--
-- Pattern (consistent with Phase 7/9/10):
--   v_actor := auth.uid();
--   IF v_actor IS NULL THEN RAISE 'Not authenticated'; END IF;
--   IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
--     RAISE 'p_performed_by does not match authenticated user';
--   END IF;
--
-- Note: p_performed_by is DEFAULT NULL on these RPCs, so the mismatch check
-- only fires when the caller explicitly passes a value. Frontend code that
-- relies on the default falls through to auth.uid() naturally.
-- =============================================================================


-- =============================================================================
-- 1. confirm_delivery — strict actor check, existing role check preserved
-- =============================================================================

CREATE OR REPLACE FUNCTION public.confirm_delivery(
  p_delivery_id uuid,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_delivery record;
  v_actor uuid;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  -- ── Phase 12 Sprint A3: strict actor check ──────────────────────────────
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'confirm_delivery');
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  SELECT * INTO v_delivery
  FROM deliveries WHERE id = p_delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found';
  END IF;

  IF v_delivery.status != 'scheduled' THEN
    RAISE EXCEPTION 'Delivery must be in scheduled status to start. Current status: %', v_delivery.status;
  END IF;

  -- Existing role check: admin/sales OR assigned driver
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true
      AND (
        role IN ('admin', 'sales_rep')
        OR (role = 'driver' AND v_actor = v_delivery.assigned_driver)
      )
  ) THEN
    RAISE EXCEPTION 'Not authorized to start this delivery';
  END IF;

  UPDATE deliveries SET
    status = 'in_progress',
    updated_at = now()
  WHERE id = p_delivery_id;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_confirmed',
    'Delivery ' || v_delivery.delivery_number || ' confirmed and started',
    v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  IF v_delivery.assigned_driver IS NOT NULL AND v_actor != v_delivery.assigned_driver THEN
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    VALUES (
      v_delivery.assigned_driver,
      'Delivery Started',
      'Delivery ' || v_delivery.delivery_number || ' has been started and is ready for completion.',
      'delivery_update', 'delivery', p_delivery_id
    );
  END IF;

  v_result := jsonb_build_object('status', 'confirmed', 'delivery_id', p_delivery_id);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'confirm_delivery', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.confirm_delivery(uuid, uuid, text) TO authenticated;


-- =============================================================================
-- 2. complete_delivery — strict actor check + require status='in_progress'
-- =============================================================================

CREATE OR REPLACE FUNCTION public.complete_delivery(
  p_delivery_id uuid,
  p_signed_by text,
  p_performed_by uuid DEFAULT NULL,
  p_quantities jsonb DEFAULT NULL,
  p_issue_type text DEFAULT NULL,
  p_issue_notes text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_delivery record;
  v_item record;
  v_inv record;
  v_qty_to_deliver numeric;
  v_deduct_from_prebooked numeric;
  v_any_partial boolean := false;
  v_all_delivered boolean;
  v_linked_invoice record;
  v_result jsonb;
  v_existing jsonb;
  v_actor uuid;
  v_actor_role text;
BEGIN
  -- ── Phase 12 Sprint A3: strict actor check ──────────────────────────────
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;

  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor;
  IF v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'Only admin or sales_rep can complete deliveries';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'complete_delivery');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_delivery FROM deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery not found: %', p_delivery_id; END IF;

  -- ── Phase 12 Sprint D (folded): require in_progress ─────────────────────
  -- Previously the function allowed completing 'scheduled' deliveries
  -- directly, skipping the confirm/start step. Now enforces the documented
  -- two-step lifecycle: scheduled → in_progress (via confirm_delivery)
  -- → completed (via this RPC).
  IF v_delivery.status != 'in_progress' THEN
    RAISE EXCEPTION 'Delivery must be in_progress to complete (current status: %). Call confirm_delivery() first.', v_delivery.status;
  END IF;

  -- Existing inventory pre-check
  FOR v_item IN
    SELECT di.*, p.product_name
    FROM delivery_items di JOIN products p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id
  LOOP
    IF p_quantities IS NOT NULL AND p_quantities ? v_item.id::text THEN
      v_qty_to_deliver := GREATEST(0, LEAST((p_quantities->>v_item.id::text)::numeric, v_item.quantity));
    ELSE
      v_qty_to_deliver := v_item.quantity;
    END IF;

    IF v_qty_to_deliver < v_item.quantity THEN v_any_partial := true; END IF;
    IF v_qty_to_deliver = 0 THEN CONTINUE; END IF;

    SELECT * INTO v_inv FROM inventory
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse' FOR UPDATE;

    IF NOT FOUND OR COALESCE(v_inv.quantity_available, 0) < v_qty_to_deliver THEN
      RAISE EXCEPTION 'Insufficient inventory for %: need % units, only % on-hand',
        v_item.product_name, v_qty_to_deliver,
        COALESCE(v_inv.quantity_available, 0);
    END IF;
  END LOOP;

  UPDATE deliveries SET
    status = 'completed', completed_at = now(), signed_by = p_signed_by,
    issue_type = COALESCE(p_issue_type, issue_type),
    issue_notes = CASE WHEN p_issue_notes IS NOT NULL THEN p_issue_notes ELSE issue_notes END
  WHERE id = p_delivery_id;

  FOR v_item IN
    SELECT di.*, p.product_name
    FROM delivery_items di JOIN products p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id
  LOOP
    IF p_quantities IS NOT NULL AND p_quantities ? v_item.id::text THEN
      v_qty_to_deliver := GREATEST(0, LEAST((p_quantities->>v_item.id::text)::numeric, v_item.quantity));
    ELSE
      v_qty_to_deliver := v_item.quantity;
    END IF;

    UPDATE delivery_items SET quantity_delivered = v_qty_to_deliver WHERE id = v_item.id;
    IF v_qty_to_deliver = 0 THEN CONTINUE; END IF;

    UPDATE order_items SET
      quantity_delivered = quantity_delivered + v_qty_to_deliver,
      quantity_remaining = GREATEST(quantity_remaining - v_qty_to_deliver, 0)
    WHERE id = v_item.order_item_id;

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, from_location,
      order_id, delivery_id, performed_by, notes
    ) VALUES (
      v_item.product_id, 'delivered', v_qty_to_deliver, 'Main Warehouse',
      v_delivery.order_id, p_delivery_id, v_actor,
      'Delivery ' || v_delivery.delivery_number ||
        CASE WHEN v_qty_to_deliver < v_item.quantity
          THEN ' (partial: ' || v_qty_to_deliver || '/' || v_item.quantity || ')'
          ELSE '' END || '. Signed by: ' || p_signed_by
    );

    SELECT * INTO v_inv FROM inventory
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

    v_deduct_from_prebooked := LEAST(v_qty_to_deliver, COALESCE(v_inv.quantity_prebooked, 0));

    UPDATE inventory SET
      quantity_available = quantity_available - v_qty_to_deliver,
      quantity_prebooked = quantity_prebooked - v_deduct_from_prebooked,
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';
  END LOOP;

  IF v_any_partial THEN
    FOR v_item IN
      SELECT di.*, p.product_name
      FROM delivery_items di JOIN products p ON p.id = di.product_id
      WHERE di.delivery_id = p_delivery_id AND di.quantity_delivered < di.quantity
    LOOP
      INSERT INTO delivery_remainders (
        original_delivery_id, order_id, order_item_id,
        customer_id, product_id, quantity_remaining, unit_size
      ) VALUES (
        p_delivery_id, v_delivery.order_id, v_item.order_item_id,
        v_delivery.customer_id, v_item.product_id,
        v_item.quantity - v_item.quantity_delivered, v_item.unit_size
      );
    END LOOP;
  END IF;

  SELECT NOT EXISTS (
    SELECT 1 FROM order_items WHERE order_id = v_delivery.order_id AND quantity_remaining > 0
  ) INTO v_all_delivered;

  UPDATE orders SET
    status = CASE WHEN v_all_delivered THEN 'fulfilled' ELSE 'partially_fulfilled' END,
    updated_at = now()
  WHERE id = v_delivery.order_id;

  IF v_any_partial AND v_delivery.order_id IS NOT NULL THEN
    FOR v_linked_invoice IN
      SELECT * FROM invoices
      WHERE order_id = v_delivery.order_id AND status = 'draft' AND delivery_id = p_delivery_id
    LOOP
      UPDATE invoice_items ii SET
        quantity = di.quantity_delivered,
        extended_cents = ROUND(di.quantity_delivered * ii.unit_price_cents)
      FROM delivery_items di
      WHERE di.delivery_id = p_delivery_id
        AND ii.invoice_id = v_linked_invoice.id
        AND ii.product_id = di.product_id;

      UPDATE invoices SET
        total_amount_cents = (
          SELECT COALESCE(SUM(extended_cents), 0) FROM invoice_items WHERE invoice_id = v_linked_invoice.id
        ),
        updated_at = now()
      WHERE id = v_linked_invoice.id;
    END LOOP;
  END IF;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_completed',
    'Delivery ' || v_delivery.delivery_number || ' completed. Signed by: ' || p_signed_by ||
      CASE WHEN v_any_partial THEN ' (partial delivery — remainders created)' ELSE '' END,
    v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  v_result := jsonb_build_object(
    'status', CASE WHEN v_any_partial THEN 'partial' ELSE 'completed' END,
    'delivery_id', p_delivery_id,
    'order_fulfilled', v_all_delivered
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'complete_delivery', v_result);
  END IF;

  RETURN v_result;
END;
$$;


-- =============================================================================
-- 3. create_quick_delivery — strict actor check, existing role check preserved
-- =============================================================================

CREATE OR REPLACE FUNCTION public.create_quick_delivery(
  p_customer_id      uuid,
  p_items            jsonb,
  p_driver_id        uuid    DEFAULT NULL,
  p_scheduled_date   date    DEFAULT CURRENT_DATE,
  p_delivery_notes   text    DEFAULT NULL,
  p_performed_by     uuid    DEFAULT NULL,
  p_idempotency_key  text    DEFAULT NULL,
  p_skip_invoice     boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor             uuid;
  v_order_id          uuid;
  v_order_number      text;
  v_delivery_id       uuid;
  v_delivery_number   text;
  v_invoice_id        uuid;
  v_invoice_number    text;
  v_item              jsonb;
  v_order_item_id     uuid;
  v_product           record;
  v_inv               record;
  v_total_cents       bigint  := 0;
  v_total_cost_cents  bigint  := 0;
  v_item_price_cents  bigint;
  v_item_qty          numeric;
  v_sort              integer := 0;
  v_customer          record;
  v_split             jsonb;
  v_split_entry       jsonb;
  v_order_profit      numeric;
  v_split_total       numeric;
  v_net_available     numeric;
  v_ar_balance_cents  bigint;
  v_result            jsonb;
BEGIN
  -- ── Phase 12 Sprint A3: strict actor check ──────────────────────────────
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;

  -- Existing role check: admin/sales/driver
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep', 'driver')
  ) THEN
    RAISE EXCEPTION 'Not authorized to create quick deliveries';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    DECLARE v_existing jsonb;
    BEGIN
      v_existing := check_idempotency(p_idempotency_key, 'create_quick_delivery');
      IF (v_existing->>'status') = 'created' THEN
        RETURN v_existing->'result';
      END IF;
    END;
  END IF;

  SELECT * INTO v_customer FROM customers WHERE id = p_customer_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer not found';
  END IF;

  IF NOT v_customer.is_active THEN
    RAISE EXCEPTION 'Customer is inactive';
  END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'At least one item is required';
  END IF;

  IF COALESCE(v_customer.credit_limit_cents, 0) > 0 THEN
    SELECT COALESCE(SUM(balance_cents), 0)
      INTO v_ar_balance_cents
      FROM invoices
     WHERE customer_id = p_customer_id
       AND status = 'posted';

    IF v_ar_balance_cents >= v_customer.credit_limit_cents THEN
      RAISE EXCEPTION
        'Credit limit exceeded for customer "%": limit $%, current AR balance $%',
        v_customer.farm_name,
        (v_customer.credit_limit_cents / 100.0)::numeric(12,2),
        (v_ar_balance_cents            / 100.0)::numeric(12,2);
    END IF;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT * INTO v_product
    FROM products WHERE id = (v_item->>'product_id')::uuid AND is_active = true;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product not found or inactive: %', v_item->>'product_id';
    END IF;

    v_item_qty := (v_item->>'quantity')::numeric;

    SELECT * INTO v_inv
    FROM inventory
    WHERE product_id = v_product.id AND location = 'Main Warehouse'
    FOR UPDATE;

    v_net_available := COALESCE(v_inv.quantity_available, 0) - COALESCE(v_inv.quantity_prebooked, 0);

    IF NOT FOUND OR v_net_available < v_item_qty THEN
      RAISE EXCEPTION 'Insufficient inventory for %: need % units, only % net available (% on hand, % prebooked)',
        v_product.product_name,
        v_item_qty,
        GREATEST(v_net_available, 0),
        COALESCE(v_inv.quantity_available, 0),
        COALESCE(v_inv.quantity_prebooked, 0);
    END IF;
  END LOOP;

  v_split := v_customer.default_commission_split;
  IF v_split IS NOT NULL AND v_split ? 'splits' AND jsonb_array_length(v_split->'splits') > 0 THEN
    SELECT COALESCE(SUM((elem->>'percentage')::numeric), 0)
    INTO v_split_total
    FROM jsonb_array_elements(v_split->'splits') elem;

    IF ABS(v_split_total - 100) > 0.01 THEN
      RAISE EXCEPTION 'Customer commission splits must sum to 100%% (got %.2f%%). Fix customer settings before creating delivery.', v_split_total;
    END IF;
  END IF;

  v_order_id     := gen_random_uuid();
  v_order_number := generate_order_number();

  INSERT INTO orders (
    id, order_number, customer_id, status,
    order_date, notes, total_price, total_cost, total_profit, total_margin_pct,
    commission_split
  ) VALUES (
    v_order_id, v_order_number, p_customer_id, 'confirmed',
    CURRENT_DATE, 'Quick delivery', 0, 0, 0, 0,
    v_customer.default_commission_split
  );

  v_delivery_id     := gen_random_uuid();
  v_delivery_number := next_delivery_number();

  INSERT INTO deliveries (
    id, delivery_number, order_id, customer_id,
    assigned_driver, scheduled_date, status,
    delivery_notes, is_quick_delivery
  ) VALUES (
    v_delivery_id, v_delivery_number, v_order_id, p_customer_id,
    p_driver_id, p_scheduled_date, 'scheduled',
    p_delivery_notes, true
  );

  IF NOT p_skip_invoice THEN
    v_invoice_id     := gen_random_uuid();
    v_invoice_number := next_invoice_number('chemical_sale');

    INSERT INTO invoices (
      id, invoice_number, invoice_type, order_id, customer_id,
      status, total_amount_cents, paid_amount_cents, prepay_applied_cents,
      invoice_date, is_quick_delivery, created_by
    ) VALUES (
      v_invoice_id, v_invoice_number, 'chemical_sale', v_order_id, p_customer_id,
      'draft', 0, 0, 0,
      CURRENT_DATE, true, v_actor
    );
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_sort := v_sort + 1;

    SELECT * INTO v_product
    FROM products WHERE id = (v_item->>'product_id')::uuid;

    v_item_qty := (v_item->>'quantity')::numeric;

    v_item_price_cents := COALESCE(
      NULLIF((v_item->>'price_cents')::bigint, 0),
      CASE v_customer.assigned_tier
        WHEN 1 THEN ROUND(COALESCE(v_product.tier1_price, 0) * 100)
        WHEN 2 THEN ROUND(COALESCE(v_product.tier2_price, 0) * 100)
        ELSE        ROUND(COALESCE(v_product.tier3_price, 0) * 100)
      END
    );

    v_total_cents      := v_total_cents      + (v_item_price_cents * v_item_qty)::bigint;
    v_total_cost_cents := v_total_cost_cents + ROUND(COALESCE(v_product.current_cost, 0) * 100 * v_item_qty)::bigint;

    INSERT INTO order_items (
      order_id, product_id, quantity, total_units_needed, price_per_unit,
      quantity_delivered, quantity_remaining, quantity_prebooked,
      total_price, sort_order
    ) VALUES (
      v_order_id, v_product.id, v_item_qty, v_item_qty,
      (v_item_price_cents / 100.0)::numeric,
      0, v_item_qty, v_item_qty,
      (v_item_price_cents / 100.0)::numeric * v_item_qty,
      v_sort
    ) RETURNING id INTO v_order_item_id;

    INSERT INTO delivery_items (
      delivery_id, order_item_id, product_id,
      quantity, quantity_delivered, unit_size, sort_order
    ) VALUES (
      v_delivery_id, v_order_item_id, v_product.id,
      v_item_qty, 0,
      COALESCE(v_item->>'unit_size', v_product.unit_size),
      v_sort
    );

    IF NOT p_skip_invoice THEN
      INSERT INTO invoice_items (
        invoice_id, order_item_id, product_id,
        description, quantity, unit_price_cents, extended_cents,
        cost_cents, sort_order
      ) VALUES (
        v_invoice_id, v_order_item_id, v_product.id,
        v_product.product_name,
        v_item_qty,
        v_item_price_cents,
        (v_item_price_cents * v_item_qty)::bigint,
        ROUND(COALESCE(v_product.current_cost, 0) * 100)::bigint,
        v_sort
      );
    END IF;

    UPDATE inventory SET
      quantity_prebooked = quantity_prebooked + v_item_qty,
      updated_at         = now()
    WHERE product_id = v_product.id AND location = 'Main Warehouse';

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity,
      order_id, delivery_id, performed_by, notes
    ) VALUES (
      v_product.id, 'prebooked', v_item_qty,
      v_order_id, v_delivery_id, v_actor,
      'Quick delivery prebooked: ' || v_delivery_number
    );
  END LOOP;

  UPDATE orders SET
    total_price  = (v_total_cents      / 100.0)::numeric,
    total_cost   = (v_total_cost_cents / 100.0)::numeric,
    total_profit = ((v_total_cents - v_total_cost_cents) / 100.0)::numeric,
    total_margin_pct = CASE WHEN v_total_cents > 0
      THEN ROUND((v_total_cents - v_total_cost_cents)::numeric / v_total_cents * 100, 2)
      ELSE 0
    END
  WHERE id = v_order_id;

  IF NOT p_skip_invoice THEN
    UPDATE invoices SET
      total_amount_cents = v_total_cents,
      total_cost_cents   = v_total_cost_cents
    WHERE id = v_invoice_id;
  END IF;

  IF v_split IS NOT NULL AND v_split ? 'splits' THEN
    v_order_profit := (v_total_cents - v_total_cost_cents) / 100.0;

    FOR v_split_entry IN
      SELECT * FROM jsonb_array_elements(v_split->'splits')
    LOOP
      INSERT INTO commissions (
        order_id, recipient_id, commission_amount, status,
        split_percentage, notes
      ) VALUES (
        v_order_id,
        (v_split_entry->>'recipient')::uuid,
        ROUND(v_order_profit * (v_split_entry->>'percentage')::numeric / 100, 2),
        'pending',
        (v_split_entry->>'percentage')::numeric,
        'Quick delivery: ' || v_delivery_number
      );
    END LOOP;
  END IF;

  v_result := jsonb_build_object(
    'order_id',        v_order_id,
    'delivery_id',     v_delivery_id,
    'invoice_id',      v_invoice_id,
    'order_number',    v_order_number,
    'delivery_number', v_delivery_number,
    'invoice_number',  v_invoice_number,
    'total_cents',     v_total_cents
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_quick_delivery', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_quick_delivery(uuid, jsonb, uuid, date, text, uuid, text, boolean) TO authenticated;


-- =============================================================================
-- Verification
-- =============================================================================

DO $$
DECLARE c1 int; c2 int; c3 int;
BEGIN
  SELECT count(*) INTO c1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='confirm_delivery';
  SELECT count(*) INTO c2 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='complete_delivery';
  SELECT count(*) INTO c3 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='create_quick_delivery';
  IF c1 != 1 OR c2 != 1 OR c3 != 1 THEN
    RAISE EXCEPTION 'VERIFICATION FAILED: overload counts confirm=%, complete=%, quick=%', c1, c2, c3;
  END IF;
  RAISE NOTICE 'Phase 12 verified';
END $$;
