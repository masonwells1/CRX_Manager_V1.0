-- idempotency-body-check: exempt
-- All three functions use the check_idempotency() / save_idempotency() helpers
-- (defined in 20260210000000_tier3_idempotency_and_triggers.sql) which read/write
-- idempotency_keys internally. The body-check hook can't see through the helper
-- indirection.
--
-- ============================================================================
-- PR-02: Fix broken idempotency replay in 3 mutating RPCs
--
-- Bug. check_idempotency() returns the bare jsonb result that was stored by
-- save_idempotency() (or NULL on cache miss). It does NOT wrap the result in a
-- {status, result} envelope. But three RPCs check the cached value as if it had
-- that wrapper:
--
--   IF (v_existing->>'status') = 'completed' THEN
--     RETURN v_existing->'result';
--
-- Both branches are dead code: the bare result has no 'status' key, so the IF is
-- always false. Network retries with the same idempotency key bypass the cache
-- and re-execute the mutation — silently double-recording payments, double-
-- creating quick deliveries, double-applying order edits.
--
-- This migration replaces each broken block with the canonical pattern from
-- CLAUDE.md ("Canonical Patterns for New RPCs"):
--
--   IF p_idempotency_key IS NOT NULL THEN
--     v_existing := check_idempotency(p_idempotency_key, '<rpc_name>');
--     IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
--   END IF;
--
-- For record_invoice_payment which returns uuid, the cached jsonb is unpacked
-- via (v_existing->>'payment_id')::uuid — matching the save_idempotency call
-- shape jsonb_build_object('payment_id', v_pay_id).
--
-- All function bodies are otherwise verbatim from their most recent definitive
-- migrations:
--   - record_invoice_payment → 20260330200000_prelaunch_final_fixes.sql
--   - create_quick_delivery  → 20260430240000_field_app_workflow_phase12.sql
--   - update_order_items     → 20260334000000_fix_order_item_delete_fk_checks.sql
--
-- Out of scope of this PR (per implementation plan but adjusted for reality):
--   - receive_po_items: already uses the canonical pattern correctly. Verified
--     by reading current pg_proc body — uses `IF v_existing IS NOT NULL`.
--   - create_prepay_check_splits: does NOT exist in the production database.
--     The defining migration (20260327200000_wave4_security_integrity.sql) was
--     never applied or was later dropped. Cannot fix what isn't there.
--
-- The record_invoice_payment search_path is also normalized from `public` to
-- `public, pg_temp` to match the canonical SECURITY DEFINER pattern (the other
-- two functions already use the canonical form).
-- ============================================================================


-- ─── record_invoice_payment ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_invoice_payment(
  p_invoice_id       uuid,
  p_amount_cents     bigint,
  p_payment_method   text,
  p_reference_number text DEFAULT NULL,
  p_notes            text DEFAULT NULL,
  p_idempotency_key  text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inv        record;
  v_pay_id     uuid;
  v_actor_role text;
  v_new_paid   bigint;
  v_existing   jsonb;
BEGIN
  -- Role check: admin or sales_rep only
  SELECT role INTO v_actor_role FROM profiles WHERE id = auth.uid();
  IF v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'Not authorized to record invoice payments';
  END IF;

  -- Idempotency check (PR-02 fix: check_idempotency returns the bare result, not {status, result})
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'record_invoice_payment');
    IF v_existing IS NOT NULL THEN
      RETURN (v_existing->>'payment_id')::uuid;
    END IF;
  END IF;

  -- Reject if accounting period is closed
  PERFORM check_period_open(now()::date);

  SELECT * INTO v_inv
  FROM public.invoices
  WHERE id = p_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found: %', p_invoice_id;
  END IF;

  IF v_inv.status NOT IN ('posted', 'overdue') THEN
    RAISE EXCEPTION 'Cannot record payment on invoice with status: %', v_inv.status;
  END IF;

  IF p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be positive';
  END IF;

  -- Guard: do not allow over-payment
  IF p_amount_cents > v_inv.balance_cents THEN
    RAISE EXCEPTION 'Payment amount ($%) exceeds remaining balance ($%)',
      (p_amount_cents  / 100.0)::numeric(12,2),
      (v_inv.balance_cents / 100.0)::numeric(12,2);
  END IF;

  -- payments.amount is stored as numeric dollars (not cents)
  INSERT INTO public.payments (
    order_id, customer_id, amount, payment_method,
    reference_number, notes, recorded_by
  ) VALUES (
    v_inv.order_id,
    v_inv.customer_id,
    (p_amount_cents / 100.0)::numeric(12,2),
    p_payment_method,
    p_reference_number,
    p_notes,
    auth.uid()
  ) RETURNING id INTO v_pay_id;

  -- Calculate new paid total
  v_new_paid := v_inv.paid_amount_cents + p_amount_cents;

  -- Set status='paid' when fully paid (matches allocate_payment behavior).
  -- balance_cents is a GENERATED column = total_amount_cents - paid_amount_cents - prepay_applied_cents - write_off_cents
  UPDATE public.invoices SET
    paid_amount_cents = v_new_paid,
    status = CASE
      WHEN (v_inv.total_amount_cents - v_new_paid - v_inv.prepay_applied_cents - v_inv.write_off_cents) <= 0
      THEN 'paid'
      ELSE status
    END,
    updated_at = now()
  WHERE id = p_invoice_id;

  INSERT INTO public.financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'payment_recorded', 'payment', v_pay_id,
    v_actor_role,
    jsonb_build_object(
      'invoice_id',     p_invoice_id,
      'invoice_number', v_inv.invoice_number,
      'amount_cents',   p_amount_cents,
      'method',         p_payment_method,
      'reference',      p_reference_number
    ),
    p_amount_cents,
    'Payment of $' || (p_amount_cents / 100.0)::numeric(12,2) || ' on ' || v_inv.invoice_number
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(
      p_idempotency_key,
      'record_invoice_payment',
      jsonb_build_object('payment_id', v_pay_id)
    );
  END IF;

  RETURN v_pay_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_invoice_payment(uuid, bigint, text, text, text, text) TO authenticated;


-- ─── create_quick_delivery ─────────────────────────────────────────────────
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
  v_existing          jsonb;
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

  -- Idempotency check (PR-02 fix: check_idempotency returns the bare result, not {status, result})
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'create_quick_delivery');
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
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


-- ─── update_order_items ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_order_items(
  p_order_id        uuid,
  p_items           jsonb,
  p_performed_by    uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid;
  v_order      record;
  v_old_item   record;
  v_item       jsonb;
  v_qty_diff   numeric;
  v_new_total  numeric;
  v_result     jsonb;
  v_passed_ids uuid[];
  v_new_item_id uuid;
  v_product    record;
  v_new_qty    numeric;
  v_new_price  numeric;
  v_new_cost   numeric;
  v_new_items_added integer := 0;
  v_new_product_id uuid;
  v_old_remaining numeric;
  v_blocking_table text;
  v_existing   jsonb;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found: %', p_order_id;
  END IF;

  -- Only allow edits on pending/confirmed orders
  IF v_order.status NOT IN ('confirmed', 'pending') THEN
    RAISE EXCEPTION 'Cannot edit order in status: %', v_order.status;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to update order items';
  END IF;

  -- Idempotency check (PR-02 fix: check_idempotency returns the bare result, not {status, result})
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'update_order_items');
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  -- Collect the IDs passed from the frontend (only items with an id = existing items)
  SELECT array_agg((el->>'id')::uuid)
    INTO v_passed_ids
    FROM jsonb_array_elements(p_items) el
   WHERE (el->>'id') IS NOT NULL;

  -- ========== FK-SAFE ITEM REMOVAL ==========
  -- Check each item being removed for blocking FK references
  FOR v_old_item IN
    SELECT oi.*
      FROM order_items oi
     WHERE oi.order_id = p_order_id
       AND (v_passed_ids IS NULL OR oi.id != ALL(v_passed_ids))
  LOOP
    -- 1. Delivery items — block only for ACTIVE deliveries, clean up cancelled/voided
    IF v_old_item.quantity_delivered > 0 THEN
      RAISE EXCEPTION 'Cannot remove "%" — % unit(s) have already been delivered. Edit the quantity instead.',
        v_old_item.product_name, v_old_item.quantity_delivered;
    END IF;

    -- Block if linked to an active (non-cancelled, non-voided) delivery
    IF EXISTS (
      SELECT 1 FROM delivery_items di
        JOIN deliveries d ON d.id = di.delivery_id
       WHERE di.order_item_id = v_old_item.id
         AND d.status NOT IN ('cancelled', 'voided')
       LIMIT 1
    ) THEN
      RAISE EXCEPTION 'Cannot remove "%" — it is linked to an active delivery. Remove it from the delivery first.',
        v_old_item.product_name;
    END IF;

    -- Safe: delete delivery_items from cancelled/voided deliveries
    DELETE FROM delivery_items
     WHERE order_item_id = v_old_item.id
       AND delivery_id IN (
         SELECT id FROM deliveries WHERE status IN ('cancelled', 'voided')
       );

    -- 2. Return items — block only for active returns, clean up cancelled/rejected
    IF EXISTS (
      SELECT 1 FROM return_items ri
        JOIN returns r ON r.id = ri.return_id
       WHERE ri.order_item_id = v_old_item.id
         AND r.status NOT IN ('cancelled', 'rejected')
       LIMIT 1
    ) THEN
      RAISE EXCEPTION 'Cannot remove "%" — it is linked to a return/RMA. Process or cancel the return first.',
        v_old_item.product_name;
    END IF;

    -- Safe: NULL out order_item_id on cancelled/rejected return items
    UPDATE return_items SET order_item_id = NULL
     WHERE order_item_id = v_old_item.id
       AND return_id IN (
         SELECT id FROM returns WHERE status IN ('cancelled', 'rejected')
       );

    -- 3. Delivery remainders — clean up resolved/cancelled, block for active
    DELETE FROM delivery_remainders
     WHERE order_item_id = v_old_item.id
       AND (status IN ('resolved', 'cancelled')
            OR original_delivery_id IN (
              SELECT id FROM deliveries WHERE status IN ('cancelled', 'voided')
            ));

    IF EXISTS (SELECT 1 FROM delivery_remainders WHERE order_item_id = v_old_item.id LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot remove "%" — it has active delivery remainder records. Resolve or cancel them first.',
        v_old_item.product_name;
    END IF;

    -- 4. Order line allocations — safe to delete (they track payment splits per line)
    DELETE FROM order_line_allocations WHERE order_item_id = v_old_item.id;

    -- 5. Invoice items — NULL out for draft/voided/cancelled invoices, block for posted/paid
    IF EXISTS (
      SELECT 1 FROM invoice_items ii
        JOIN invoices inv ON inv.id = ii.invoice_id
       WHERE ii.order_item_id = v_old_item.id
         AND inv.status NOT IN ('draft', 'voided', 'cancelled')
       LIMIT 1
    ) THEN
      RAISE EXCEPTION 'Cannot remove "%" — it is linked to a posted or paid invoice. Void the invoice first.',
        v_old_item.product_name;
    END IF;

    -- Safe: NULL out order_item_id on draft/voided/cancelled invoice items
    UPDATE invoice_items SET order_item_id = NULL
     WHERE order_item_id = v_old_item.id
       AND invoice_id IN (
         SELECT id FROM invoices WHERE status IN ('draft', 'voided', 'cancelled')
       );

    -- Release prebooked inventory for items being removed
    IF v_old_item.quantity_remaining > 0 THEN
      UPDATE inventory
         SET quantity_prebooked = GREATEST(quantity_prebooked - v_old_item.quantity_remaining, 0),
             updated_at = now()
       WHERE product_id = v_old_item.product_id AND location = 'Main Warehouse';

      INSERT INTO inventory_transactions (
        product_id, transaction_type, quantity,
        order_id, performed_by, notes
      ) VALUES (
        v_old_item.product_id, 'released', v_old_item.quantity_remaining,
        p_order_id, v_actor,
        'Order edit: item removed from ' || v_order.order_number
      );
    END IF;

    -- Now safe to delete this item (blend_ticket_to_order_items cascades automatically)
    DELETE FROM order_items WHERE id = v_old_item.id;
  END LOOP;

  -- Process each item in the payload
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    IF (v_item->>'id') IS NOT NULL THEN
      -- ========== EXISTING ITEM: update price/qty/product ==========
      SELECT * INTO v_old_item FROM order_items WHERE id = (v_item->>'id')::uuid;
      IF NOT FOUND THEN CONTINUE; END IF;

      v_new_product_id := COALESCE((v_item->>'product_id')::uuid, v_old_item.product_id);
      v_qty_diff := (v_item->>'total_units_needed')::numeric - v_old_item.total_units_needed;

      -- *** Handle product swap ***
      IF v_new_product_id IS DISTINCT FROM v_old_item.product_id THEN
        -- Product changed! Release ALL prebooked from old product, add to new product
        v_old_remaining := GREATEST(v_old_item.total_units_needed - v_old_item.quantity_delivered, 0);

        -- Release old product prebooked
        IF v_old_remaining > 0 THEN
          UPDATE inventory SET
            quantity_prebooked = GREATEST(quantity_prebooked - v_old_remaining, 0),
            updated_at = now()
          WHERE product_id = v_old_item.product_id AND location = 'Main Warehouse';

          INSERT INTO inventory_transactions (
            product_id, transaction_type, quantity,
            order_id, performed_by, notes
          ) VALUES (
            v_old_item.product_id, 'released', v_old_remaining,
            p_order_id, v_actor,
            'Order edit: product swapped from ' || v_old_item.product_name || ' on ' || v_order.order_number
          );
        END IF;

        -- Add new product prebooked (use new quantity)
        v_new_qty := (v_item->>'total_units_needed')::numeric;
        IF v_new_qty > 0 THEN
          UPDATE inventory SET
            quantity_prebooked = quantity_prebooked + v_new_qty,
            updated_at = now()
          WHERE product_id = v_new_product_id AND location = 'Main Warehouse';

          INSERT INTO inventory_transactions (
            product_id, transaction_type, quantity,
            order_id, performed_by, notes
          ) VALUES (
            v_new_product_id, 'prebooked', v_new_qty,
            p_order_id, v_actor,
            'Order edit: product swapped to ' || COALESCE(v_item->>'product_name', '') || ' on ' || v_order.order_number
          );
        END IF;

        -- Look up cost for new product if not provided
        v_new_cost := COALESCE((v_item->>'cost_per_unit')::numeric, 0);
        IF v_new_cost = 0 THEN
          SELECT current_cost INTO v_new_cost FROM products WHERE id = v_new_product_id;
          v_new_cost := COALESCE(v_new_cost, 0);
        END IF;

        -- Update the order item with new product info
        UPDATE order_items SET
          product_id         = v_new_product_id,
          product_name       = COALESCE(v_item->>'product_name', product_name),
          unit_size          = COALESCE(v_item->>'unit_size', unit_size),
          cost_per_unit      = v_new_cost,
          price_per_unit     = (v_item->>'price_per_unit')::numeric,
          total_units_needed = (v_item->>'total_units_needed')::numeric,
          quantity_remaining = GREATEST(
            (v_item->>'total_units_needed')::numeric - v_old_item.quantity_delivered, 0
          ),
          total_price = (v_item->>'price_per_unit')::numeric * (v_item->>'total_units_needed')::numeric,
          profit      = ((v_item->>'price_per_unit')::numeric - v_new_cost) * (v_item->>'total_units_needed')::numeric,
          net_margin  = CASE WHEN (v_item->>'price_per_unit')::numeric > 0
            THEN ROUND((((v_item->>'price_per_unit')::numeric - v_new_cost) / (v_item->>'price_per_unit')::numeric) * 100, 2)
            ELSE 0
          END
        WHERE id = v_old_item.id;

      ELSE
        -- *** Same product: just update price/qty (original logic) ***
        UPDATE order_items SET
          product_name       = COALESCE(v_item->>'product_name', product_name),
          price_per_unit     = (v_item->>'price_per_unit')::numeric,
          total_units_needed = (v_item->>'total_units_needed')::numeric,
          quantity_remaining = GREATEST(
            (v_item->>'total_units_needed')::numeric - v_old_item.quantity_delivered, 0
          ),
          total_price = (v_item->>'price_per_unit')::numeric * (v_item->>'total_units_needed')::numeric
        WHERE id = v_old_item.id;

        -- Adjust prebooked if quantity changed
        IF v_qty_diff <> 0 THEN
          UPDATE inventory SET
            quantity_prebooked = GREATEST(quantity_prebooked + v_qty_diff, 0),
            updated_at = now()
          WHERE product_id = v_old_item.product_id AND location = 'Main Warehouse';

          INSERT INTO inventory_transactions (
            product_id, transaction_type, quantity,
            order_id, performed_by, notes
          ) VALUES (
            v_old_item.product_id,
            CASE WHEN v_qty_diff > 0 THEN 'prebooked' ELSE 'released' END,
            ABS(v_qty_diff),
            p_order_id, v_actor,
            'Order edit: adjusted prebooked by ' || v_qty_diff
          );
        END IF;
      END IF;

    ELSE
      -- ========== NEW ITEM: insert into order_items ==========
      v_new_qty   := COALESCE((v_item->>'total_units_needed')::numeric, 0);
      v_new_price := COALESCE((v_item->>'price_per_unit')::numeric, 0);
      v_new_cost  := COALESCE((v_item->>'cost_per_unit')::numeric, 0);

      -- If cost not provided, look up from products table
      IF v_new_cost = 0 AND (v_item->>'product_id') IS NOT NULL THEN
        SELECT current_cost INTO v_new_cost
          FROM products WHERE id = (v_item->>'product_id')::uuid;
        v_new_cost := COALESCE(v_new_cost, 0);
      END IF;

      IF v_new_qty <= 0 THEN
        CONTINUE; -- Skip items with no quantity
      END IF;

      v_new_item_id := gen_random_uuid();

      INSERT INTO order_items (
        id, order_id, product_id, product_name,
        price_per_unit, cost_per_unit, total_units_needed,
        unit_size, section_name,
        total_price, profit, net_margin,
        quantity_delivered, quantity_remaining
      ) VALUES (
        v_new_item_id,
        p_order_id,
        (v_item->>'product_id')::uuid,
        COALESCE(v_item->>'product_name', ''),
        v_new_price,
        v_new_cost,
        v_new_qty,
        v_item->>'unit_size',
        v_item->>'section_name',
        v_new_price * v_new_qty,
        (v_new_price - v_new_cost) * v_new_qty,
        CASE WHEN v_new_price > 0
          THEN ROUND(((v_new_price - v_new_cost) / v_new_price) * 100, 2)
          ELSE 0
        END,
        0,
        v_new_qty
      );

      -- Pre-book inventory for new item
      UPDATE inventory SET
        quantity_prebooked = quantity_prebooked + v_new_qty,
        updated_at = now()
      WHERE product_id = (v_item->>'product_id')::uuid AND location = 'Main Warehouse';

      INSERT INTO inventory_transactions (
        product_id, transaction_type, quantity,
        order_id, performed_by, notes
      ) VALUES (
        (v_item->>'product_id')::uuid,
        'prebooked',
        v_new_qty,
        p_order_id, v_actor,
        'New item added to existing order ' || v_order.order_number
      );

      v_new_items_added := v_new_items_added + 1;
    END IF;
  END LOOP;

  -- Recalculate order total
  SELECT COALESCE(SUM(total_price), 0) INTO v_new_total
    FROM order_items WHERE order_id = p_order_id;

  UPDATE orders SET
    total_price = v_new_total,
    updated_at  = now()
  WHERE id = p_order_id;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'order_edited',
    'Order ' || v_order.order_number || ' items updated'
      || CASE WHEN v_new_items_added > 0
           THEN ' (' || v_new_items_added || ' new item(s) added)'
           ELSE '' END
      || ' — new total $' || ROUND(v_new_total, 2),
    v_actor, 'order', p_order_id, v_order.customer_id
  );

  v_result := jsonb_build_object(
    'status', 'updated',
    'new_items_added', v_new_items_added
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'update_order_items', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_order_items(uuid, jsonb, uuid, text) TO authenticated;


-- ============================================================================
-- Verification: each function has exactly one signature
-- ============================================================================
DO $$
DECLARE c1 int; c2 int; c3 int;
BEGIN
  SELECT count(*) INTO c1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='record_invoice_payment';
  SELECT count(*) INTO c2 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='create_quick_delivery';
  SELECT count(*) INTO c3 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='update_order_items';
  IF c1 != 1 THEN RAISE EXCEPTION 'record_invoice_payment has % overloads (expected 1)', c1; END IF;
  IF c2 != 1 THEN RAISE EXCEPTION 'create_quick_delivery has % overloads (expected 1)', c2; END IF;
  IF c3 != 1 THEN RAISE EXCEPTION 'update_order_items has % overloads (expected 1)', c3; END IF;
END $$;
