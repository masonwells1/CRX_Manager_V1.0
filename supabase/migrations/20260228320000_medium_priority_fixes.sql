-- ============================================================================
-- MEDIUM-PRIORITY PRE-LAUNCH FIXES
-- Phase 3 of unified audit remediation plan
-- Addresses: M1 (transaction review uses deprecated payments table),
--            M3 (adjust_inventory negative qty guard),
--            M5 (convert_quote_to_order FOR UPDATE on quote row),
--            M7 (idempotency_keys RLS too permissive)
-- Skipped:   M2 (AR aging units — risk-accepted, changing money format pre-launch),
--            M4 (complete_cycle_count FOR UPDATE — already fixed in 20260315200001),
--            M6 (total_cost_cents in quick delivery — already fixed in Phase 1),
--            M8 (unit conversion telemetry — deferred, not safe to add side effects
--                 to pure math functions pre-launch)
-- ============================================================================


-- ============================================================================
-- M1: Rewrite get_customer_transaction_review() to use allocation_sets
--
-- Problem: The function reads from the deprecated `payments` table which
-- is no longer populated by allocate_payment() since the switch to
-- allocation_sets + invoice_line_allocations.
--
-- Fix: Replace the payments UNION block with a join through
-- allocation_sets → invoice_line_allocations.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_customer_transaction_review(
  p_customer_id uuid,
  p_start_date  date,
  p_end_date    date
)
RETURNS TABLE (
  transaction_date date,
  transaction_type text,
  reference_number text,
  description text,
  debit_cents bigint,
  credit_cents bigint,
  running_balance_cents bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  WITH all_transactions AS (
    -- Invoices (debits — money owed by customer)
    SELECT i.invoice_date AS tx_date,
           'Invoice' AS tx_type,
           i.invoice_number AS ref_num,
           CASE i.invoice_type
             WHEN 'chemical_sale' THEN 'Chemical Sale'
             WHEN 'field_application' THEN 'Field Application'
             WHEN 'misc_charge' THEN 'Misc Charge'
             ELSE COALESCE(i.invoice_type, 'Invoice')
           END AS descr,
           i.total_amount_cents AS debit,
           0::bigint AS credit
      FROM public.invoices i
     WHERE i.customer_id = p_customer_id
       AND i.status IN ('posted', 'paid', 'overdue')
       AND i.deleted_at IS NULL
       AND i.invoice_date BETWEEN p_start_date AND p_end_date

    UNION ALL

    -- Payments (credits — money received from customer)
    -- NEW: reads from allocation_sets + invoice_line_allocations
    -- instead of deprecated payments table
    SELECT als.payment_date AS tx_date,
           'Payment' AS tx_type,
           COALESCE(als.reference_number, als.check_number, 'PMT-' || LEFT(als.id::text, 8)) AS ref_num,
           COALESCE(als.payment_method, 'Payment') ||
             CASE WHEN als.check_number IS NOT NULL THEN ' #' || als.check_number ELSE '' END ||
             COALESCE(' — ' || als.notes, '') AS descr,
           0::bigint AS debit,
           ila.amount_cents AS credit
      FROM public.allocation_sets als
      JOIN public.invoice_line_allocations ila ON ila.allocation_set_id = als.id
     WHERE als.customer_id = p_customer_id
       AND als.payment_date BETWEEN p_start_date AND p_end_date

    UNION ALL

    -- Prepay applications (credits — applied from prepay balance)
    SELECT pa.created_at::date AS tx_date,
           'Prepay Applied' AS tx_type,
           'PP-' || LEFT(pa.id::text, 8) AS ref_num,
           'Prepay credit applied' AS descr,
           0::bigint AS debit,
           pa.amount_cents AS credit
      FROM public.prepay_applications pa
      JOIN public.invoices i ON i.id = pa.invoice_id
     WHERE i.customer_id = p_customer_id
       AND i.deleted_at IS NULL
       AND pa.created_at::date BETWEEN p_start_date AND p_end_date

    UNION ALL

    -- Write-offs (credits — forgiven amounts)
    SELECT w.created_at::date AS tx_date,
           'Write-Off' AS tx_type,
           'WO-' || LEFT(w.id::text, 8) AS ref_num,
           COALESCE(w.reason, 'Write-off') AS descr,
           0::bigint AS debit,
           w.amount_cents AS credit
      FROM public.write_offs w
     WHERE w.customer_id = p_customer_id
       AND w.created_at::date BETWEEN p_start_date AND p_end_date
  )
  SELECT t.tx_date AS transaction_date,
         t.tx_type AS transaction_type,
         t.ref_num AS reference_number,
         t.descr AS description,
         t.debit AS debit_cents,
         t.credit AS credit_cents,
         SUM(t.debit - t.credit) OVER (ORDER BY t.tx_date, t.tx_type, t.ref_num) AS running_balance_cents
    FROM all_transactions t
   ORDER BY t.tx_date, t.tx_type, t.ref_num;
END;
$$;


-- ============================================================================
-- M3: Add negative quantity guard to adjust_inventory()
--
-- Problem: An admin could adjust inventory to a negative quantity which
-- corrupts inventory reports and causes downstream errors.
-- Fix: Check that (current + delta) >= 0 before applying.
-- ============================================================================

CREATE OR REPLACE FUNCTION adjust_inventory(
  p_inventory_id uuid,
  p_delta numeric,
  p_reason text,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv record;
  v_new_qty numeric;
  v_cached_result jsonb;
  v_result jsonb;
BEGIN
  -- Check idempotency key if provided
  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'adjust_inventory');
    IF v_cached_result IS NOT NULL THEN
      RETURN v_cached_result;
    END IF;
  END IF;

  -- Validate delta is not zero
  IF p_delta = 0 THEN
    RAISE EXCEPTION 'Adjustment quantity cannot be zero';
  END IF;

  -- Verify caller is admin
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_performed_by AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only admins can adjust inventory';
  END IF;

  -- Lock and read the inventory row
  SELECT * INTO v_inv FROM inventory WHERE id = p_inventory_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory record not found';
  END IF;

  v_new_qty := v_inv.quantity_available + p_delta;

  -- ═══ M3 FIX: Prevent negative inventory ═══
  IF v_new_qty < 0 THEN
    RAISE EXCEPTION 'Adjustment would result in negative inventory (current: %, delta: %, result: %)',
      v_inv.quantity_available, p_delta, v_new_qty;
  END IF;

  -- Atomic update
  UPDATE inventory SET
    quantity_available = v_new_qty,
    updated_at = now()
  WHERE id = p_inventory_id;

  -- Audit trail (immutable log)
  INSERT INTO inventory_transactions (
    product_id, transaction_type, quantity,
    to_location, performed_by, notes
  ) VALUES (
    v_inv.product_id, 'adjusted', p_delta,
    v_inv.location, p_performed_by,
    COALESCE(NULLIF(TRIM(p_reason), ''), 'Manual adjustment of ' || p_delta || ' units')
  );

  v_result := jsonb_build_object(
    'status', 'adjusted',
    'new_quantity', v_new_qty,
    'product_id', v_inv.product_id
  );

  -- Save idempotency key
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'adjust_inventory', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION adjust_inventory(uuid, numeric, text, uuid, text) TO authenticated;


-- ============================================================================
-- M5: Add FOR UPDATE on quote row in convert_quote_to_order()
--
-- Problem: Two concurrent convert_quote_to_order() calls for the same
-- quote could both pass the "already_converted" check and create
-- duplicate orders. The inventory FOR UPDATE locks prevent double-booking
-- but don't prevent duplicate order creation.
-- Fix: Lock the quote row first with FOR UPDATE.
-- ============================================================================

CREATE OR REPLACE FUNCTION convert_quote_to_order(
  p_quote_id uuid,
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_quote record;
  v_order_number text;
  v_order_id uuid;
  v_section record;
  v_item record;
  v_customer record;
  v_split jsonb;
  v_inv record;
  v_shortfalls text[] := '{}';
BEGIN
  -- ═══ M5 FIX: Lock quote row to prevent concurrent conversion ═══
  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found'; END IF;

  -- Idempotency: already converted?
  IF v_quote.status = 'accepted' THEN
    SELECT id INTO v_order_id FROM orders WHERE quote_id = p_quote_id LIMIT 1;
    IF v_order_id IS NOT NULL THEN
      RETURN jsonb_build_object('status', 'already_converted', 'order_id', v_order_id);
    END IF;
  END IF;

  SELECT * INTO v_customer FROM customers WHERE id = v_quote.customer_id;

  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_performed_by AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- Availability check with inventory locks
  FOR v_item IN
    SELECT qi.product_id, p.product_name,
           SUM(COALESCE(qi.total_units_needed, 0)) AS qty_needed
    FROM quote_items qi
    JOIN products p ON p.id = qi.product_id
    WHERE qi.quote_id = p_quote_id
      AND qi.product_id IS NOT NULL
      AND COALESCE(qi.total_units_needed, 0) > 0
    GROUP BY qi.product_id, p.product_name
  LOOP
    SELECT * INTO v_inv
    FROM inventory
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse'
    FOR UPDATE;

    IF NOT FOUND THEN
      v_shortfalls := array_append(v_shortfalls,
        v_item.product_name || ': need ' || v_item.qty_needed || ', have 0 in stock');
    ELSIF (v_inv.quantity_available - v_inv.quantity_prebooked) < v_item.qty_needed THEN
      v_shortfalls := array_append(v_shortfalls,
        v_item.product_name || ': need ' || v_item.qty_needed ||
        ', only ' || (v_inv.quantity_available - v_inv.quantity_prebooked) || ' free');
    END IF;
  END LOOP;

  IF array_length(v_shortfalls, 1) > 0 THEN
    RAISE EXCEPTION 'Insufficient inventory to convert quote: %', array_to_string(v_shortfalls, '; ');
  END IF;

  -- Set admin override for status transitions
  SET LOCAL app.admin_override = 'true';

  UPDATE quotes SET status = 'accepted', updated_at = now() WHERE id = p_quote_id;

  v_order_number := generate_order_number();

  INSERT INTO orders (
    order_number, quote_id, customer_id, status,
    commission_split, total_price, total_cost, total_profit,
    total_margin_pct, order_date
  ) VALUES (
    v_order_number, p_quote_id, v_quote.customer_id, 'confirmed',
    v_quote.commission_split,
    v_quote.total_price, v_quote.total_cost, v_quote.total_profit,
    v_quote.total_margin_pct, current_date
  ) RETURNING id INTO v_order_id;

  -- Create order items from quote items
  INSERT INTO order_items (
    order_id, product_id, quote_item_id, section_name, product_name,
    price_per_unit, cost_per_unit, actual_rate, rate_unit, acres,
    total_units_needed, unit_size, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining
  )
  SELECT
    v_order_id, qi.product_id, qi.id,
    qs.section_name, p.product_name,
    qi.price_per_unit, qi.current_cost, qi.actual_rate, qi.rate_unit, qi.acres,
    COALESCE(qi.total_units_needed, 0), qi.unit_size,
    qi.total_price, qi.profit, qi.net_margin,
    0, COALESCE(qi.total_units_needed, 0)
  FROM quote_items qi
  JOIN quote_sections qs ON qs.id = qi.section_id
  JOIN products p ON p.id = qi.product_id
  WHERE qi.quote_id = p_quote_id AND qi.product_id IS NOT NULL;

  -- Pre-book inventory
  FOR v_item IN
    SELECT oi.product_id, oi.total_units_needed, oi.unit_size
    FROM order_items oi
    WHERE oi.order_id = v_order_id AND oi.product_id IS NOT NULL AND oi.total_units_needed > 0
  LOOP
    UPDATE inventory SET
      quantity_prebooked = quantity_prebooked + v_item.total_units_needed,
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

    IF NOT FOUND THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order, unit_size)
      VALUES (v_item.product_id, 'Main Warehouse', 0, v_item.total_units_needed, 0, v_item.unit_size);
    END IF;

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      order_id, performed_by, notes
    ) VALUES (
      v_item.product_id, 'booked', v_item.total_units_needed, 'Main Warehouse',
      v_order_id, p_performed_by,
      'Pre-booked for order ' || v_order_number
    );
  END LOOP;

  -- Create commission records
  IF v_quote.commission_split IS NOT NULL AND v_quote.commission_split ? 'splits' THEN
    INSERT INTO commissions (
      order_id, customer_id, recipient, split_percentage,
      commission_amount, order_profit, order_date, status
    )
    SELECT
      v_order_id, v_quote.customer_id,
      s->>'recipient',
      (s->>'percentage')::numeric,
      v_quote.total_profit * ((s->>'percentage')::numeric / 100),
      v_quote.total_profit,
      current_date,
      'pending'
    FROM jsonb_array_elements(v_quote.commission_split->'splits') s
    WHERE (s->>'recipient') IS NOT NULL AND (s->>'percentage')::numeric > 0;
  END IF;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'order_created',
    'Order ' || v_order_number || ' created from quote ' || v_quote.quote_number ||
    ' for ' || COALESCE(v_customer.farm_name, 'customer'),
    p_performed_by, 'order', v_order_id, v_quote.customer_id
  );

  RETURN jsonb_build_object('status', 'created', 'order_id', v_order_id, 'order_number', v_order_number);
END;
$$;


-- ============================================================================
-- M7: Restrict idempotency_keys RLS policy
--
-- Problem: Current policy is USING (true) — any authenticated user can
-- read/modify any other user's idempotency keys. This is a data leak
-- and tampering risk.
--
-- Fix: Since idempotency_keys have no user_id column, and all access
-- goes through SECURITY DEFINER RPCs (which bypass RLS), block all
-- direct client access entirely.
-- ============================================================================

DROP POLICY IF EXISTS "Authenticated users can manage idempotency keys" ON idempotency_keys;
DROP POLICY IF EXISTS "No direct client access to idempotency keys" ON idempotency_keys;

CREATE POLICY "No direct client access to idempotency keys"
  ON idempotency_keys
  FOR ALL
  USING (false)
  WITH CHECK (false);
