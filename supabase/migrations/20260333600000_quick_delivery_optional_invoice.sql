-- Quick Delivery: optional invoice creation + fix missing save_idempotency + fix search_path
-- Changes:
--   1. Add p_skip_invoice boolean DEFAULT false parameter
--   2. Fix SET search_path = public, pg_temp (was missing pg_temp)
--   3. Fix missing save_idempotency() call at end of function
--   4. Wrap invoice creation in IF NOT p_skip_invoice conditional

-- Drop old signature to avoid overloads
DROP FUNCTION IF EXISTS public.create_quick_delivery(uuid, jsonb, uuid, date, text, uuid, text);

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
  v_actor := COALESCE(p_performed_by, auth.uid());

  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep', 'driver')
  ) THEN
    RAISE EXCEPTION 'Not authorized to create quick deliveries';
  END IF;

  -- Idempotency check
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

  -- Credit limit check (skip if limit is 0 = no limit configured)
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

  -- Pre-check inventory availability before creating anything
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

  -- Commission split validation
  v_split := v_customer.default_commission_split;
  IF v_split IS NOT NULL AND v_split ? 'splits' AND jsonb_array_length(v_split->'splits') > 0 THEN
    SELECT COALESCE(SUM((elem->>'percentage')::numeric), 0)
    INTO v_split_total
    FROM jsonb_array_elements(v_split->'splits') elem;

    IF ABS(v_split_total - 100) > 0.01 THEN
      RAISE EXCEPTION 'Customer commission splits must sum to 100%% (got %.2f%%). Fix customer settings before creating delivery.', v_split_total;
    END IF;
  END IF;

  -- Step 1: Create Order
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

  -- Step 2: Create Delivery
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

  -- Step 3: Create Invoice (draft) — only if not skipped
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

  -- Step 4: Process items
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_sort := v_sort + 1;

    SELECT * INTO v_product
    FROM products WHERE id = (v_item->>'product_id')::uuid;

    v_item_qty := (v_item->>'quantity')::numeric;

    -- Price: use explicit override or customer-tier price
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

    -- Create order item
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

    -- Create delivery item
    INSERT INTO delivery_items (
      delivery_id, order_item_id, product_id,
      quantity, quantity_delivered, unit_size, sort_order
    ) VALUES (
      v_delivery_id, v_order_item_id, v_product.id,
      v_item_qty, 0,
      COALESCE(v_item->>'unit_size', v_product.unit_size),
      v_sort
    );

    -- Create invoice item (only if invoice was created)
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

    -- Prebook inventory (quick delivery starts as scheduled)
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

  -- Update order totals
  UPDATE orders SET
    total_price  = (v_total_cents      / 100.0)::numeric,
    total_cost   = (v_total_cost_cents / 100.0)::numeric,
    total_profit = ((v_total_cents - v_total_cost_cents) / 100.0)::numeric,
    total_margin_pct = CASE WHEN v_total_cents > 0
      THEN ROUND((v_total_cents - v_total_cost_cents)::numeric / v_total_cents * 100, 2)
      ELSE 0
    END
  WHERE id = v_order_id;

  -- Update invoice totals (only if invoice was created)
  IF NOT p_skip_invoice THEN
    UPDATE invoices SET
      total_amount_cents = v_total_cents,
      total_cost_cents   = v_total_cost_cents
    WHERE id = v_invoice_id;
  END IF;

  -- Create commission records if split configured
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

  -- Save idempotency (was missing in previous version!)
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_quick_delivery', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_quick_delivery(uuid, jsonb, uuid, date, text, uuid, text, boolean) TO authenticated;
