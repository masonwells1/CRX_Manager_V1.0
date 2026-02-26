-- =============================================================================
-- Migration: Invoice as Single Source of Truth for AR
-- =============================================================================
-- WHAT: Removes the dual AR tracking system (orders.total_paid/balance_due)
--       and makes invoices.balance_cents the only source of truth for AR.
--
-- WHY: The dual system caused a double-counting bug (see migration 20260222200000)
--       where orders.total_paid was inflated to $171,116 when actual payments were
--       $85,558. The invoice system (GENERATED ALWAYS column) is mathematically
--       impossible to drift — it should be the only AR source.
--
-- CHANGES:
--   1A. DROP trg_payment_update_order trigger + function
--   1B. REWRITE trg_recalc_order_totals() — remove balance_due line
--   1C. REWRITE dashboard_summary() — AR from invoices
--   1D. REWRITE get_ar_aging() — remove uninvoiced-order fallback
--   1E. REWRITE void_invoice() — remove order AR update
--   1F. REWRITE record_invoice_payment() — remove order AR update + payments INSERT
--   1G. No change needed to allocate_payment() — already clean (no payments INSERT)
--   1H. REWRITE convert_quote_to_order() — remove total_paid/balance_due from INSERT
--   1I. REWRITE create_order_from_blend_ticket() — remove total_paid/balance_due writes
--   1J. REWRITE update_order_items() — remove balance_due recalculation
--   1K. DROP record_payment() — replaced by allocate_payment()
--   1L. COMMENT on deprecated columns
-- =============================================================================

-- =============================================================================
-- 1A. DROP the order-level payment trigger
-- This trigger fires after INSERT on payments and blindly increments
-- orders.total_paid — the root cause of the double-counting bug.
-- =============================================================================
DROP TRIGGER IF EXISTS after_payment_insert ON payments;
DROP FUNCTION IF EXISTS trg_payment_update_order();


-- =============================================================================
-- 1B. REWRITE trg_recalc_order_totals() — remove balance_due assignment
-- Keeps total_price, total_cost, total_profit, total_margin_pct recalculation.
-- Removes: balance_due = total_price - total_paid (no longer order-level)
-- =============================================================================
CREATE OR REPLACE FUNCTION trg_recalc_order_totals()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order_id uuid;
  v_total_price numeric;
  v_total_cost numeric;
  v_total_profit numeric;
  v_margin_pct numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_order_id := OLD.order_id;
  ELSE
    v_order_id := NEW.order_id;
  END IF;

  SELECT
    COALESCE(SUM(total_price), 0),
    COALESCE(SUM(COALESCE(cost_per_unit, 0) * total_units_needed), 0)
  INTO v_total_price, v_total_cost
  FROM order_items
  WHERE order_id = v_order_id;

  v_total_profit := v_total_price - v_total_cost;
  v_margin_pct := CASE WHEN v_total_price > 0
    THEN ROUND((v_total_profit / v_total_price) * 100, 2)
    ELSE 0
  END;

  UPDATE orders SET
    total_price = ROUND(v_total_price, 2),
    total_cost = ROUND(v_total_cost, 2),
    total_profit = ROUND(v_total_profit, 2),
    total_margin_pct = v_margin_pct,
    -- REMOVED: balance_due = ... (AR tracked via invoices.balance_cents)
    updated_at = now()
  WHERE id = v_order_id;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;


-- =============================================================================
-- 1C. REWRITE dashboard_summary() — AR from invoices instead of orders
-- Changes: ar CTE uses invoices.balance_cents, over_credit CTE uses invoices
-- =============================================================================
CREATE OR REPLACE FUNCTION public.dashboard_summary()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
BEGIN
  WITH
  order_agg AS (
    SELECT
      COALESCE(SUM(total_price), 0)  AS total_revenue,
      COALESCE(SUM(total_profit), 0) AS total_profit
    FROM orders
  ),

  quote_agg AS (
    SELECT
      COUNT(*) FILTER (WHERE status = 'draft')    AS draft_count,
      COUNT(*) FILTER (WHERE status = 'sent')     AS sent_count,
      COUNT(*) FILTER (WHERE status = 'accepted') AS accepted_count,
      COALESCE(SUM(total_price) FILTER (WHERE status IN ('draft', 'sent')), 0) AS pipeline_value
    FROM quotes
  ),

  inv_agg AS (
    SELECT
      COALESCE(SUM(quantity_available), 0)  AS total_available,
      COALESCE(SUM(quantity_prebooked), 0)  AS total_prebooked
    FROM inventory
  ),

  low_stock AS (
    SELECT COUNT(*) AS cnt
    FROM inventory
    WHERE reorder_point > 0
      AND quantity_available <= reorder_point
  ),

  -- CHANGED: AR from invoices instead of orders
  ar AS (
    SELECT COALESCE(SUM(GREATEST(balance_cents, 0)), 0) AS balance_cents
    FROM invoices
    WHERE status = 'posted'
  ),

  monthly AS (
    SELECT jsonb_agg(row_to_json(m)::jsonb ORDER BY m.month) AS arr
    FROM (
      SELECT
        TO_CHAR(COALESCE(order_date, created_at::date), 'YYYY-MM') AS month,
        COALESCE(SUM(total_price), 0)  AS revenue,
        COALESCE(SUM(total_profit), 0) AS profit
      FROM orders
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT 12
    ) m
  ),

  top_cust AS (
    SELECT jsonb_agg(row_to_json(tc)::jsonb ORDER BY tc.total DESC) AS arr
    FROM (
      SELECT
        c.farm_name,
        COALESCE(SUM(o.total_price), 0) AS total
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      GROUP BY c.id, c.farm_name
      ORDER BY total DESC
      LIMIT 5
    ) tc
  ),

  upcoming AS (
    SELECT jsonb_agg(row_to_json(ud)::jsonb ORDER BY ud.scheduled_date ASC) AS arr
    FROM (
      SELECT
        d.id,
        d.delivery_number,
        d.scheduled_date,
        d.status,
        jsonb_build_object('farm_name', cust.farm_name) AS customer,
        jsonb_build_object('full_name', drv.full_name)  AS driver
      FROM deliveries d
      LEFT JOIN customers cust ON cust.id = d.customer_id
      LEFT JOIN profiles  drv  ON drv.id  = d.assigned_driver
      WHERE d.status IN ('scheduled', 'in_progress')
      ORDER BY d.scheduled_date ASC
      LIMIT 5
    ) ud
  ),

  activity AS (
    SELECT jsonb_agg(row_to_json(af)::jsonb ORDER BY af.created_at DESC) AS arr
    FROM (
      SELECT
        id,
        event_type,
        description,
        created_at
      FROM activity_feed
      ORDER BY created_at DESC
      LIMIT 10
    ) af
  ),

  driver_issues AS (
    SELECT COUNT(*) AS cnt
    FROM deliveries
    WHERE issue_type IS NOT NULL
      AND status = 'completed'
  ),

  -- CHANGED: over_credit now uses invoices instead of orders
  over_credit AS (
    SELECT COUNT(*) AS cnt
    FROM customers c
    WHERE c.credit_limit_cents IS NOT NULL
      AND c.credit_limit_cents > 0
      AND (
        SELECT COALESCE(SUM(GREATEST(i.balance_cents, 0)), 0)
        FROM invoices i
        WHERE i.customer_id = c.id
          AND i.status = 'posted'
      ) > c.credit_limit_cents
  ),

  expired_holds AS (
    SELECT COUNT(DISTINCT q.id) AS cnt
    FROM quotes q
    JOIN inventory_holds ih ON ih.source_id = q.id AND ih.is_active = true
    WHERE q.status IN ('expired', 'declined')
  ),

  cancelled_posted AS (
    SELECT COUNT(DISTINCT d.id) AS cnt
    FROM deliveries d
    JOIN orders o ON o.id = d.order_id
    JOIN invoices i ON i.order_id = o.id
    WHERE d.status = 'cancelled'
      AND i.status = 'posted'
  )

  SELECT jsonb_build_object(
    'total_revenue',        oa.total_revenue,
    'total_profit',         oa.total_profit,
    'overall_margin',       CASE WHEN oa.total_revenue > 0
                              THEN ROUND((oa.total_profit / oa.total_revenue) * 100, 1)
                              ELSE 0
                            END,
    'quote_counts',         jsonb_build_object(
                              'draft',    qa.draft_count,
                              'sent',     qa.sent_count,
                              'accepted', qa.accepted_count
                            ),
    'quote_pipeline_value', qa.pipeline_value,
    'inventory_available',  ia.total_available,
    'inventory_prebooked',  ia.total_prebooked,
    'low_stock_count',      ls.cnt,
    -- CHANGED: Convert cents to dollars for frontend compatibility
    'open_ar_balance',      ROUND(ar.balance_cents / 100.0, 2),
    'monthly_revenue',      COALESCE(mr.arr, '[]'::jsonb),
    'top_customers',        COALESCE(tc.arr, '[]'::jsonb),
    'upcoming_deliveries',  COALESCE(ud.arr, '[]'::jsonb),
    'recent_activity',      COALESCE(ra.arr, '[]'::jsonb),
    'driver_issues_count',          di.cnt,
    'customers_over_credit_count',  oc.cnt,
    'expired_holds_count',          eh.cnt,
    'cancelled_posted_count',       cp.cnt
  ) INTO result
  FROM order_agg  oa
  CROSS JOIN quote_agg   qa
  CROSS JOIN inv_agg     ia
  CROSS JOIN low_stock   ls
  CROSS JOIN ar
  CROSS JOIN monthly     mr
  CROSS JOIN top_cust    tc
  CROSS JOIN upcoming    ud
  CROSS JOIN activity    ra
  CROSS JOIN driver_issues   di
  CROSS JOIN over_credit     oc
  CROSS JOIN expired_holds   eh
  CROSS JOIN cancelled_posted cp;

  RETURN result;
END;
$$;


-- =============================================================================
-- 1D. REWRITE get_ar_aging() — invoice-only, remove uninvoiced-order fallback
-- =============================================================================
CREATE OR REPLACE FUNCTION get_ar_aging(
  p_as_of_date date DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  customer_id      uuid,
  farm_name        text,
  current_amount   numeric,
  days_30          numeric,
  days_60          numeric,
  days_90          numeric,
  over_90          numeric,
  total_outstanding numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id AS customer_id,
    c.farm_name,
    COALESCE(SUM(CASE WHEN age_days BETWEEN 0 AND 29 THEN balance END), 0) AS current_amount,
    COALESCE(SUM(CASE WHEN age_days BETWEEN 30 AND 59 THEN balance END), 0) AS days_30,
    COALESCE(SUM(CASE WHEN age_days BETWEEN 60 AND 89 THEN balance END), 0) AS days_60,
    COALESCE(SUM(CASE WHEN age_days BETWEEN 90 AND 119 THEN balance END), 0) AS days_90,
    COALESCE(SUM(CASE WHEN age_days >= 120 THEN balance END), 0) AS over_90,
    COALESCE(SUM(balance), 0) AS total_outstanding
  FROM customers c
  INNER JOIN (
    -- Invoice-only AR (single source of truth)
    SELECT
      i.customer_id,
      (i.balance_cents::numeric / 100) AS balance,
      (p_as_of_date - i.invoice_date::date) AS age_days
    FROM invoices i
    WHERE i.status = 'posted'
      AND i.balance_cents > 0
      AND i.deleted_at IS NULL
    -- REMOVED: UNION ALL block for uninvoiced orders
  ) ar ON ar.customer_id = c.id
  GROUP BY c.id, c.farm_name
  HAVING SUM(balance) > 0
  ORDER BY SUM(balance) DESC;
END;
$$;


-- =============================================================================
-- 1E. REWRITE void_invoice() — remove order AR update
-- Everything else stays: allocation reversal, prepay restore, audit log, etc.
-- Only the UPDATE orders SET total_paid/balance_due block is removed.
-- =============================================================================
CREATE OR REPLACE FUNCTION void_invoice(
  p_invoice_id uuid,
  p_void_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv record;
  v_alloc record;
  v_total_allocations_reversed bigint := 0;
  v_total_prepay_restored bigint := 0;
  v_prepay_app record;
BEGIN
  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found: %', p_invoice_id;
  END IF;

  IF v_inv.status = 'voided' THEN
    RAISE EXCEPTION 'Invoice already voided';
  END IF;

  IF v_inv.status = 'cancelled' THEN
    RAISE EXCEPTION 'Cannot void a cancelled invoice';
  END IF;

  -- Reverse payment allocations
  FOR v_alloc IN
    SELECT ila.id, ila.allocated_cents, ila.allocation_set_id
    FROM invoice_line_allocations ila
    WHERE ila.invoice_id = p_invoice_id
  LOOP
    v_total_allocations_reversed := v_total_allocations_reversed + v_alloc.allocated_cents;
    DELETE FROM invoice_line_allocations WHERE id = v_alloc.id;
  END LOOP;

  -- Update allocation_sets: recalculate total_allocated_cents
  IF v_total_allocations_reversed > 0 THEN
    UPDATE allocation_sets SET
      total_allocated_cents = (
        SELECT COALESCE(SUM(allocated_cents), 0)
        FROM invoice_line_allocations
        WHERE allocation_set_id = allocation_sets.id
      ),
      updated_at = now()
    WHERE id IN (
      SELECT DISTINCT allocation_set_id FROM invoice_line_allocations
      WHERE invoice_id = p_invoice_id
    );

    UPDATE invoices SET
      paid_amount_cents = GREATEST(paid_amount_cents - v_total_allocations_reversed, 0),
      updated_at = now()
    WHERE id = p_invoice_id;
  END IF;

  -- Restore prepay credits
  FOR v_prepay_app IN
    SELECT pa.id, pa.amount_cents, pa.prepay_credit_id
    FROM prepay_applications pa
    WHERE pa.invoice_id = p_invoice_id
  LOOP
    v_total_prepay_restored := v_total_prepay_restored + v_prepay_app.amount_cents;

    UPDATE prepay_credits SET
      balance_cents = balance_cents + v_prepay_app.amount_cents,
      updated_at = now()
    WHERE id = v_prepay_app.prepay_credit_id;

    DELETE FROM prepay_applications WHERE id = v_prepay_app.id;
  END LOOP;

  IF v_total_prepay_restored > 0 THEN
    UPDATE customers SET
      prepay_balance_cents = COALESCE(prepay_balance_cents, 0) + v_total_prepay_restored,
      updated_at = now()
    WHERE id = v_inv.customer_id;

    UPDATE invoices SET
      prepay_applied_cents = GREATEST(prepay_applied_cents - v_total_prepay_restored, 0)
    WHERE id = p_invoice_id;
  END IF;

  -- Reverse any write-offs
  IF v_inv.write_off_cents > 0 THEN
    UPDATE invoices SET write_off_cents = 0 WHERE id = p_invoice_id;
  END IF;

  -- Void the invoice (balance_cents is GENERATED — no need to set it)
  UPDATE invoices SET
    status = 'voided',
    voided_by = auth.uid(),
    voided_at = now(),
    void_reason = p_void_reason,
    total_amount_cents = 0,
    updated_at = now()
  WHERE id = p_invoice_id;

  -- REMOVED: UPDATE orders SET total_paid/balance_due (AR tracked via invoices only)

  -- Audit log
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'invoice_voided', 'invoice', p_invoice_id,
    (SELECT role FROM profiles WHERE id = auth.uid()),
    jsonb_build_object(
      'status', v_inv.status,
      'total_cents', v_inv.total_amount_cents,
      'paid_amount_cents', v_inv.paid_amount_cents,
      'prepay_applied_cents', v_inv.prepay_applied_cents,
      'write_off_cents', v_inv.write_off_cents
    ),
    jsonb_build_object(
      'status', 'voided',
      'void_reason', p_void_reason,
      'allocations_reversed_cents', v_total_allocations_reversed,
      'prepay_restored_cents', v_total_prepay_restored
    ),
    -1 * v_inv.total_amount_cents,
    'Voided ' || v_inv.invoice_number || ' — ' || p_void_reason ||
      CASE WHEN v_total_allocations_reversed > 0
        THEN '. Reversed $' || (v_total_allocations_reversed / 100.0)::text || ' in allocations.'
        ELSE '' END ||
      CASE WHEN v_total_prepay_restored > 0
        THEN ' Restored $' || (v_total_prepay_restored / 100.0)::text || ' in prepay credits.'
        ELSE '' END
  );

  -- Activity log
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_voided',
    'Voided invoice ' || v_inv.invoice_number || ' — ' || p_void_reason ||
      CASE WHEN v_total_allocations_reversed > 0
        THEN '. Reversed $' || (v_total_allocations_reversed / 100.0)::text || ' in allocations.'
        ELSE '' END ||
      CASE WHEN v_total_prepay_restored > 0
        THEN ' Restored $' || (v_total_prepay_restored / 100.0)::text || ' in prepay credits.'
        ELSE '' END,
    auth.uid(), 'invoice', p_invoice_id, v_inv.customer_id
  );

  -- Notify admin about reversals
  IF v_total_allocations_reversed > 0 OR v_total_prepay_restored > 0 THEN
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    SELECT p.id,
      'Invoice Voided — Allocations Reversed',
      'Invoice ' || v_inv.invoice_number || ' voided. $' ||
        (v_total_allocations_reversed / 100.0)::text || ' in allocations reversed, $' ||
        (v_total_prepay_restored / 100.0)::text || ' in prepay credits restored.',
      'invoice_void_reversal', 'invoice', p_invoice_id
    FROM profiles p
    WHERE p.role = 'admin' AND p.is_active = true;
  END IF;
END;
$$;


-- =============================================================================
-- 1F. REWRITE record_invoice_payment() — remove order AR update + payments INSERT
-- Now only updates invoice.paid_amount_cents and creates an audit log entry.
-- =============================================================================
CREATE OR REPLACE FUNCTION record_invoice_payment(
  p_invoice_id      uuid,
  p_amount_cents    bigint,
  p_payment_method  text,
  p_reference_number text DEFAULT NULL,
  p_notes           text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_inv         record;
  v_alloc_set_id uuid;
BEGIN
  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found: %', p_invoice_id;
  END IF;

  IF v_inv.status != 'posted' THEN
    RAISE EXCEPTION 'Can only record payments on posted invoices (current status: %)', v_inv.status;
  END IF;

  IF p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be positive';
  END IF;

  IF p_amount_cents > v_inv.balance_cents THEN
    RAISE EXCEPTION 'Payment ($%) exceeds invoice balance ($%)',
      (p_amount_cents / 100.0)::numeric(12,2),
      (v_inv.balance_cents / 100.0)::numeric(12,2);
  END IF;

  -- REMOVED: INSERT INTO payments (legacy table, no longer written to)
  -- REMOVED: UPDATE orders SET total_paid/balance_due (AR via invoices only)

  -- Create allocation set for audit trail
  INSERT INTO allocation_sets (
    customer_id, total_payment_cents, payment_method,
    reference_number, payment_date, notes, total_allocated_cents, created_by
  ) VALUES (
    v_inv.customer_id, p_amount_cents, p_payment_method,
    p_reference_number, CURRENT_DATE, p_notes, p_amount_cents, auth.uid()
  ) RETURNING id INTO v_alloc_set_id;

  -- Create line allocation
  INSERT INTO invoice_line_allocations (
    allocation_set_id, invoice_id, allocated_cents
  ) VALUES (
    v_alloc_set_id, p_invoice_id, p_amount_cents
  );

  -- Update invoice paid amount
  UPDATE invoices SET
    paid_amount_cents = paid_amount_cents + p_amount_cents,
    status = CASE
      WHEN (total_amount_cents - (paid_amount_cents + p_amount_cents) - prepay_applied_cents - write_off_cents) <= 0
      THEN 'paid'
      ELSE status
    END,
    updated_at = now()
  WHERE id = p_invoice_id;

  -- Audit
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'payment_recorded', 'allocation_set', v_alloc_set_id,
    (SELECT role FROM profiles WHERE id = auth.uid()),
    jsonb_build_object(
      'invoice_id', p_invoice_id,
      'invoice_number', v_inv.invoice_number,
      'amount_cents', p_amount_cents,
      'method', p_payment_method,
      'reference', p_reference_number
    ),
    p_amount_cents,
    'Payment of $' || (p_amount_cents / 100.0)::numeric(12,2) || ' on ' || v_inv.invoice_number
  );

  RETURN v_alloc_set_id;
END;
$$;


-- =============================================================================
-- 1G. allocate_payment() — NO CHANGES NEEDED
-- The latest version (20260307) already does NOT insert into payments table
-- and does NOT update orders.total_paid/balance_due. It's already clean.
-- =============================================================================


-- =============================================================================
-- 1H. REWRITE convert_quote_to_order() — remove total_paid/balance_due from INSERT
-- =============================================================================
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
  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found'; END IF;
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

  -- Availability check
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

  UPDATE quotes SET status = 'accepted', updated_at = now() WHERE id = p_quote_id;

  v_order_number := generate_order_number();

  -- CHANGED: Removed total_paid and balance_due from INSERT (AR tracked via invoices)
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


-- =============================================================================
-- 1I. REWRITE create_order_from_blend_ticket() — remove total_paid/balance_due
-- =============================================================================
CREATE OR REPLACE FUNCTION create_order_from_blend_ticket(
  p_blend_ticket_id uuid,
  p_order_number text,
  p_order_date date DEFAULT CURRENT_DATE,
  p_notes text DEFAULT NULL,
  p_performed_by uuid DEFAULT auth.uid(),
  p_idempotency_key text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket      blend_tickets%ROWTYPE;
  v_order_id    uuid;
  v_customer    customers%ROWTYPE;
  v_product     blend_ticket_products%ROWTYPE;
  v_db_product  products%ROWTYPE;
  v_item_id     uuid;
  v_tier        int;
  v_price       numeric;
  v_cost        numeric;
  v_total_price numeric := 0;
  v_total_cost  numeric := 0;
  v_item_count  int := 0;
  v_link_result json;
  v_cached      jsonb;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    v_cached := check_idempotency(p_idempotency_key, 'create_order_from_blend_ticket');
    IF v_cached IS NOT NULL THEN
      RETURN v_cached::json;
    END IF;
  END IF;

  SELECT * INTO v_ticket FROM blend_tickets WHERE id = p_blend_ticket_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket not found');
  END IF;
  IF v_ticket.order_link_status = 'linked' THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket is already linked to an order');
  END IF;
  IF v_ticket.customer_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket has no customer assigned');
  END IF;

  SELECT * INTO v_customer FROM customers WHERE id = v_ticket.customer_id;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Customer not found');
  END IF;
  v_tier := COALESCE(v_customer.assigned_tier, 1);

  -- CHANGED: Removed total_paid and balance_due from INSERT (AR tracked via invoices)
  v_order_id := gen_random_uuid();
  INSERT INTO orders (id, order_number, customer_id, status, order_date, notes, season, salesman_id, total_price, total_cost, total_profit, total_margin_pct)
  VALUES (
    v_order_id,
    p_order_number,
    v_ticket.customer_id,
    'confirmed',
    p_order_date,
    COALESCE(p_notes, 'Created from blend ticket ' || v_ticket.ticket_number),
    v_ticket.season,
    v_ticket.salesman_id,
    0, 0, 0, 0
  );

  FOR v_product IN
    SELECT * FROM blend_ticket_products
    WHERE blend_ticket_id = p_blend_ticket_id
    ORDER BY sequence_order
  LOOP
    v_price := 0;
    v_cost := 0;

    IF v_product.product_id IS NOT NULL THEN
      SELECT * INTO v_db_product FROM products WHERE id = v_product.product_id;
      IF FOUND THEN
        v_price := CASE v_tier
          WHEN 1 THEN COALESCE(v_db_product.tier1_price, 0)
          WHEN 2 THEN COALESCE(v_db_product.tier2_price, 0)
          WHEN 3 THEN COALESCE(v_db_product.tier3_price, 0)
          ELSE COALESCE(v_db_product.tier1_price, 0)
        END;
        v_cost := COALESCE(v_db_product.current_cost, 0);
      END IF;
    END IF;

    v_item_id := gen_random_uuid();
    INSERT INTO order_items (
      id, order_id, product_id, product_name, price_per_unit, cost_per_unit,
      actual_rate, rate_unit, acres, total_units_needed, unit_size,
      total_price, profit, net_margin, quantity_delivered, quantity_remaining, sort_order
    )
    VALUES (
      v_item_id,
      v_order_id,
      COALESCE(v_product.product_id, gen_random_uuid()),
      v_product.product_name,
      v_price,
      v_cost,
      v_product.rate_per_acre,
      v_product.rate_per_acre_unit,
      v_ticket.total_acres,
      v_product.quantity,
      COALESCE(v_product.unit, 'ea'),
      v_price * v_product.quantity,
      (v_price - v_cost) * v_product.quantity,
      CASE WHEN v_price > 0 THEN ((v_price - v_cost) / v_price * 100) ELSE 0 END,
      0,
      v_product.quantity,
      v_product.sequence_order
    );

    IF v_product.product_id IS NOT NULL AND v_product.quantity > 0 THEN
      UPDATE inventory SET
        quantity_prebooked = COALESCE(quantity_prebooked, 0) + v_product.quantity,
        updated_at = now()
      WHERE product_id = v_product.product_id AND location = 'Main Warehouse';

      INSERT INTO inventory_transactions (
        product_id, transaction_type, quantity, to_location,
        order_id, performed_by, notes
      ) VALUES (
        v_product.product_id, 'booked', v_product.quantity, 'Main Warehouse',
        v_order_id, p_performed_by,
        'Prebooked for blend ticket order ' || p_order_number
      );
    END IF;

    v_total_price := v_total_price + (v_price * v_product.quantity);
    v_total_cost := v_total_cost + (v_cost * v_product.quantity);
    v_item_count := v_item_count + 1;
  END LOOP;

  -- CHANGED: Removed balance_due from UPDATE (AR tracked via invoices)
  UPDATE orders
  SET total_price = v_total_price,
      total_cost = v_total_cost,
      total_profit = v_total_price - v_total_cost,
      total_margin_pct = CASE WHEN v_total_price > 0 THEN ((v_total_price - v_total_cost) / v_total_price * 100) ELSE 0 END
  WHERE id = v_order_id;

  v_link_result := link_blend_ticket_to_order(p_blend_ticket_id, v_order_id, NULL, p_performed_by);

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES (
    'order_created_from_blend_ticket',
    'Order ' || p_order_number || ' created from blend ticket ' || v_ticket.ticket_number,
    p_performed_by,
    'order',
    v_order_id
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_order_from_blend_ticket',
      jsonb_build_object('success', true, 'order_id', v_order_id));
  END IF;

  RETURN json_build_object(
    'success', true,
    'order_id', v_order_id,
    'order_number', p_order_number,
    'items_created', v_item_count,
    'total_price', v_total_price
  );
END;
$$;


-- =============================================================================
-- 1J. REWRITE update_order_items() — remove balance_due recalculation
-- =============================================================================
CREATE OR REPLACE FUNCTION update_order_items(
  p_order_id uuid,
  p_items jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order record;
  v_item jsonb;
  v_old_item record;
  v_qty_diff numeric;
  v_new_total numeric := 0;
  v_cached_result jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'update_order_items');
    IF v_cached_result IS NOT NULL THEN
      RETURN v_cached_result;
    END IF;
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;

  IF v_order.status NOT IN ('pending', 'confirmed') THEN
    RAISE EXCEPTION 'Cannot edit items on a % order', v_order.status;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_performed_by AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to update order items';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT * INTO v_old_item FROM order_items WHERE id = (v_item->>'id')::uuid;
    IF NOT FOUND THEN CONTINUE; END IF;

    v_qty_diff := (v_item->>'total_units_needed')::numeric - v_old_item.total_units_needed;

    UPDATE order_items SET
      price_per_unit = (v_item->>'price_per_unit')::numeric,
      total_units_needed = (v_item->>'total_units_needed')::numeric,
      quantity_remaining = GREATEST(
        (v_item->>'total_units_needed')::numeric - v_old_item.quantity_delivered, 0
      ),
      total_price = (v_item->>'price_per_unit')::numeric * (v_item->>'total_units_needed')::numeric
    WHERE id = v_old_item.id;

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
        p_order_id, p_performed_by,
        'Order edit: adjusted prebooked by ' || v_qty_diff
      );
    END IF;
  END LOOP;

  SELECT COALESCE(SUM(total_price), 0) INTO v_new_total
  FROM order_items WHERE order_id = p_order_id;

  -- CHANGED: Removed balance_due recalculation (AR tracked via invoices)
  UPDATE orders SET
    total_price = v_new_total,
    updated_at = now()
  WHERE id = p_order_id;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'order_edited',
    'Order ' || v_order.order_number || ' items updated — new total $' || ROUND(v_new_total, 2),
    p_performed_by, 'order', p_order_id, v_order.customer_id
  );

  v_result := jsonb_build_object('status', 'updated');

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'update_order_items', v_result);
  END IF;

  RETURN v_result;
END;
$$;


-- =============================================================================
-- 1K. DROP record_payment() — replaced by allocate_payment()
-- Drop old 6-param overload first, then replace the 7-param version with error-raiser.
-- =============================================================================
DROP FUNCTION IF EXISTS record_payment(uuid, numeric, text, text, text, uuid);
CREATE OR REPLACE FUNCTION record_payment(
  p_order_id uuid,
  p_amount numeric,
  p_payment_method text,
  p_reference_number text,
  p_notes text,
  p_recorded_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'record_payment() is deprecated. Use allocate_payment() instead. '
    'Payments must go through the invoice allocation system.';
END;
$$;


-- =============================================================================
-- 1L. Deprecation comments on orders columns
-- Columns are NOT dropped — just marked as deprecated for documentation.
-- =============================================================================
COMMENT ON COLUMN orders.total_paid IS 'DEPRECATED — do not use. AR tracked via invoices.balance_cents';
COMMENT ON COLUMN orders.balance_due IS 'DEPRECATED — do not use. AR tracked via invoices.balance_cents';
