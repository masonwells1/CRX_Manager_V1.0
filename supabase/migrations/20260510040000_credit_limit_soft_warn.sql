-- idempotency-body-check: exempt
-- create_quick_delivery uses the check_idempotency() / save_idempotency() helpers.
--
-- ============================================================================
-- PR-06: Quick-delivery credit limit — soft warn instead of hard block
--
-- Mason's policy decision (Q4): when a customer is over (or projected over)
-- their credit limit, the quick-delivery RPC should still create the
-- delivery, but emit an admin notification + activity_feed entry. The
-- previous hard exception was blocking legitimate sales.
--
-- Changes vs the PR-02 version (20260510020000_fix_idempotency_replay_canonical.sql):
--   1. Credit-check block now scopes AR balance to status IN ('draft',
--      'posted', 'overdue') — previously only 'posted'. Draft invoices are
--      already-promised dollars; overdue are unpaid past-due.
--   2. The new delivery's projected total is added to the AR balance for the
--      comparison (post-delivery exposure, not current-state).
--   3. RAISE EXCEPTION removed. If projected exposure exceeds the limit:
--        - INSERT activity_feed entry (event_type 'credit_limit_warning')
--        - INSERT notifications row for every active admin
--      The delivery proceeds normally.
--   4. Credit check moved AFTER the items pre-check loop so the projected
--      total is known. Previously it ran before any item processing.
--
-- All other behavior preserved verbatim from the PR-02 version (same
-- signature, same return shape, same idempotency contract).
-- ============================================================================

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
  v_projected_cents   bigint;
  v_credit_warning    boolean := false;
  v_admin             record;
  v_result            jsonb;
  v_existing          jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep', 'driver')
  ) THEN
    RAISE EXCEPTION 'Not authorized to create quick deliveries';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'create_quick_delivery');
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  SELECT * INTO v_customer FROM customers WHERE id = p_customer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found'; END IF;
  IF NOT v_customer.is_active THEN RAISE EXCEPTION 'Customer is inactive'; END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'At least one item is required';
  END IF;

  -- Pre-check loop: validate inventory + accumulate projected total
  -- (PR-06 needs the projected total for the credit warn calculation)
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

    -- PR-06: accumulate projected total for credit-limit calculation
    v_item_price_cents := COALESCE(
      NULLIF((v_item->>'price_cents')::bigint, 0),
      CASE v_customer.assigned_tier
        WHEN 1 THEN ROUND(COALESCE(v_product.tier1_price, 0) * 100)
        WHEN 2 THEN ROUND(COALESCE(v_product.tier2_price, 0) * 100)
        ELSE        ROUND(COALESCE(v_product.tier3_price, 0) * 100)
      END
    );
    v_total_cents := v_total_cents + (v_item_price_cents * v_item_qty)::bigint;
  END LOOP;

  -- PR-06: credit-limit soft warn (Q4 decision).
  -- Include draft + posted + overdue invoices in the AR balance, plus the
  -- new delivery's projected total. Notify admins if exposure exceeds limit
  -- but proceed with the delivery — never block.
  IF COALESCE(v_customer.credit_limit_cents, 0) > 0 THEN
    SELECT COALESCE(SUM(balance_cents), 0)
      INTO v_ar_balance_cents
      FROM invoices
     WHERE customer_id = p_customer_id
       AND status IN ('draft', 'posted', 'overdue');

    v_projected_cents := v_ar_balance_cents + v_total_cents;

    IF v_projected_cents >= v_customer.credit_limit_cents THEN
      v_credit_warning := true;

      INSERT INTO activity_feed (
        event_type, description, performed_by,
        related_entity_type, related_entity_id, customer_id
      ) VALUES (
        'credit_limit_warning',
        'WARNING: Quick delivery for "' || v_customer.farm_name || '" projected to push AR exposure to $' ||
          (v_projected_cents     / 100.0)::numeric(12,2) ||
          ' (limit $' || (v_customer.credit_limit_cents / 100.0)::numeric(12,2) ||
          '). Current AR (draft+posted+overdue) is $' ||
          (v_ar_balance_cents    / 100.0)::numeric(12,2) ||
          '. Delivery proceeded; review with finance.',
        v_actor, 'customer', p_customer_id, p_customer_id
      );

      FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
      LOOP
        INSERT INTO notifications (
          user_id, title, message, notification_type,
          related_entity_type, related_entity_id
        ) VALUES (
          v_admin.id,
          'Credit Limit Exceeded — ' || v_customer.farm_name,
          'A quick delivery was created for ' || v_customer.farm_name ||
            ' that projects AR exposure to $' || (v_projected_cents / 100.0)::numeric(12,2) ||
            ', exceeding the $' || (v_customer.credit_limit_cents / 100.0)::numeric(12,2) ||
            ' credit limit. Current AR (incl. draft+overdue) is $' ||
            (v_ar_balance_cents / 100.0)::numeric(12,2) ||
            '. The delivery proceeded; please review.',
          'credit_warning', 'customer', p_customer_id
        );
      END LOOP;
    END IF;
  END IF;

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

  -- Reset v_total_cents — the pre-check loop already populated it. Recompute
  -- v_total_cost_cents during the insert loop (the pre-check didn't touch cost).
  -- We want the INSERT-time total to match the pre-check total, so we rely on
  -- the deterministic pricing logic being identical.
  v_total_cents      := 0;
  v_total_cost_cents := 0;

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
    'order_id',          v_order_id,
    'delivery_id',       v_delivery_id,
    'invoice_id',        v_invoice_id,
    'order_number',      v_order_number,
    'delivery_number',   v_delivery_number,
    'invoice_number',    v_invoice_number,
    'total_cents',       v_total_cents,
    'credit_warning',    v_credit_warning  -- PR-06: surfaces the warn status to the caller
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_quick_delivery', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_quick_delivery(uuid, jsonb, uuid, date, text, uuid, text, boolean) TO authenticated;


-- Verification: signature unchanged, exactly one overload
DO $$
DECLARE c1 int;
BEGIN
  SELECT count(*) INTO c1 FROM pg_proc
   WHERE pronamespace='public'::regnamespace AND proname='create_quick_delivery';
  IF c1 != 1 THEN
    RAISE EXCEPTION 'create_quick_delivery has % overloads (expected 1)', c1;
  END IF;
END $$;
