-- idempotency-body-check: exempt
-- (Uses check_idempotency / save_idempotency helpers per CLAUDE.md
-- "Canonical Patterns for New RPCs".)
-- ============================================================================
-- Phase 2 audit fixes — Quick Delivery server pricing (#8) + audit-log gap (#15)
-- ============================================================================
-- Audit findings (Phase 0 verification, 2026-05-11):
--   #8: create_quick_delivery honors client `price_cents` via
--       `COALESCE(NULLIF((v_item->>'price_cents')::bigint, 0), <tier price>)`.
--       Any non-zero client value overrides the server-side tier price.
--       Driver/sales_rep roles can call this RPC directly — a malicious or
--       buggy client could submit a $0.01 price_cents for any product.
--       Fix: always compute price server-side from product tier.
--   #15: convert_quote_to_order + create_quick_delivery have no
--        financial_audit_log entry despite creating orders + (in QD's case)
--        invoices. Audit trail gap. Operation_types currently exist for
--        order_updated/voided/cancelled/restored but NOT order_created or
--        delivery_created or quote_converted.
--
-- Scope:
--   1. Extend financial_audit_log_operation_type_check to allow:
--      'order_created', 'delivery_created', 'quote_converted'.
--   2. Rewrite create_quick_delivery: drop client price_cents override +
--      write financial_audit_log for order creation.
--   3. Rewrite convert_quote_to_order: write financial_audit_log for quote
--      conversion.
--
-- Frontend impact: QuickDeliveryModal already computes price client-side
-- from tier — the price_cents field in the JSONB is now ignored. Behavior
-- doesn't change for normal users; only blocks the manipulation case.
-- ============================================================================

-- ─── 1. Extend operation_type CHECK to allow new audit-log operations ────

ALTER TABLE financial_audit_log
  DROP CONSTRAINT IF EXISTS financial_audit_log_operation_type_check;

ALTER TABLE financial_audit_log
  ADD CONSTRAINT financial_audit_log_operation_type_check
  CHECK (operation_type = ANY (ARRAY[
    'invoice_created', 'invoice_posted', 'invoice_voided', 'invoice_cancelled',
    'invoice_updated', 'invoice_deleted', 'invoice_marked_overdue',
    'payment_recorded', 'payment_allocation', 'payment_voided',
    'split_modified', 'split_invoices_generated',
    'prepay_created', 'prepay_applied', 'prepay_credit_created',
    'prepay_batch_applied', 'prepay_edited', 'prepay_deleted',
    'prepay_reconciliation', 'batch_prepay_apply',
    'write_off_recorded', 'write_off_reversed', 'write_off_applied',
    'finance_charge', 'finance_charge_generated', 'finance_charge_voided',
    'credit_memo_created', 'credit_memo_applied', 'credit_memo_unapplied',
    'return_created', 'return_approved', 'return_received',
    'return_credit_issued',
    'order_created',         -- NEW (Phase 2 #15)
    'order_updated', 'order_voided', 'order_cancelled', 'order_restored',
    'delivery_created',      -- NEW (Phase 2 #15)
    'delivery_updated', 'delivery_cancelled', 'delivery_voided',
    'delivery_restored',
    'quote_converted',       -- NEW (Phase 2 #15)
    'blend_ticket_linked', 'blend_ticket_unlinked',
    'commission_payment_created', 'commission_payment_posted',
    'commission_payment_voided',
    'batch_post', 'batch_void', 'batch_payment',
    'period_reopened', 'quote_status_reverted',
    'blend_ticket_approval_reversed', 'cycle_count_completed',
    'vendor_bill_created', 'vendor_bill_voided', 'vendor_bill_updated',
    'vendor_payment_recorded', 'vendor_payment_voided'
  ]));

-- ─── 2. create_quick_delivery — server-side tier price + audit log ───────

CREATE OR REPLACE FUNCTION public.create_quick_delivery(
  p_customer_id uuid,
  p_items jsonb,
  p_driver_id uuid DEFAULT NULL::uuid,
  p_scheduled_date date DEFAULT CURRENT_DATE,
  p_delivery_notes text DEFAULT NULL::text,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text,
  p_skip_invoice boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid; v_actor_role text;
  v_order_id uuid; v_order_number text;
  v_delivery_id uuid; v_delivery_number text;
  v_invoice_id uuid; v_invoice_number text;
  v_item jsonb; v_order_item_id uuid; v_product record;
  v_inv record; v_total_cents bigint := 0; v_total_cost_cents bigint := 0;
  v_item_price_cents bigint; v_item_qty numeric; v_sort integer := 0;
  v_customer record; v_split jsonb; v_split_entry jsonb;
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

  -- Pre-check loop: validate inventory + accumulate projected total
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

    -- Audit #8: server-side tier price only. Client-supplied price_cents is
    -- IGNORED — any value (including 0 or omission) yields the tier price.
    v_item_price_cents := CASE v_customer.assigned_tier
      WHEN 1 THEN ROUND(COALESCE(v_product.tier1_price, 0) * 100)
      WHEN 2 THEN ROUND(COALESCE(v_product.tier2_price, 0) * 100)
      ELSE ROUND(COALESCE(v_product.tier3_price, 0) * 100)
    END;
    v_total_cents := v_total_cents + (v_item_price_cents * v_item_qty)::bigint;
  END LOOP;

  -- PR-06: credit-limit soft warn (Q4)
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

    -- Audit #8: server-side tier price only (see pre-check loop comment).
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

  IF v_split IS NOT NULL AND v_split ? 'splits' THEN
    v_order_profit := (v_total_cents - v_total_cost_cents) / 100.0;
    FOR v_split_entry IN SELECT * FROM jsonb_array_elements(v_split->'splits') LOOP
      INSERT INTO commissions (order_id, recipient_id, commission_amount, status, split_percentage, notes)
      VALUES (v_order_id, (v_split_entry->>'recipient')::uuid,
        ROUND(v_order_profit * (v_split_entry->>'percentage')::numeric / 100, 2),
        'pending', (v_split_entry->>'percentage')::numeric, 'Quick delivery: ' || v_delivery_number);
    END LOOP;
  END IF;

  -- Audit #15: financial_audit_log entries for order + delivery + (optional) invoice creation.
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
$$;

COMMENT ON FUNCTION public.create_quick_delivery IS
  'Quick delivery RPC — atomic order + delivery + draft invoice. Phase 2 #8 (server-side tier pricing, ignores client price_cents) + #15 (writes order_created + delivery_created audit log entries).';

-- ─── 3. convert_quote_to_order — add financial_audit_log entry ───────────

CREATE OR REPLACE FUNCTION public.convert_quote_to_order(
  p_quote_id uuid,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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

  IF v_quote.commission_split IS NOT NULL AND v_quote.commission_split ? 'splits' THEN
    INSERT INTO commissions (order_id, customer_id, recipient, split_percentage,
      commission_amount, order_profit, order_date, status)
    SELECT v_order_id, v_quote.customer_id, s->>'recipient',
      (s->>'percentage')::numeric,
      v_quote.total_profit * ((s->>'percentage')::numeric / 100),
      v_quote.total_profit, current_date, 'pending'
    FROM jsonb_array_elements(v_quote.commission_split->'splits') s
    WHERE (s->>'recipient') IS NOT NULL AND (s->>'percentage')::numeric > 0;
  END IF;

  -- Audit #15: financial_audit_log for the quote → order conversion.
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
$$;

COMMENT ON FUNCTION public.convert_quote_to_order IS
  'Quote → order conversion. Phase 2 #15: writes financial_audit_log entry with operation_type=quote_converted.';

-- ─── Verification ────────────────────────────────────────────────────────

DO $$
DECLARE
  v_op_check text;
  v_qd_has_client_override boolean;
  v_qd_has_audit_log boolean;
  v_convert_has_audit_log boolean;
BEGIN
  -- 1. Operation_type CHECK now allows the new tokens
  SELECT pg_get_constraintdef(oid) INTO v_op_check
  FROM pg_constraint
  WHERE conname = 'financial_audit_log_operation_type_check';
  IF v_op_check NOT LIKE '%order_created%'
     OR v_op_check NOT LIKE '%delivery_created%'
     OR v_op_check NOT LIKE '%quote_converted%' THEN
    RAISE EXCEPTION 'audit-fix verification: operation_type CHECK missing new tokens — got: %', v_op_check;
  END IF;

  -- 2. create_quick_delivery no longer uses COALESCE(NULLIF(...price_cents...))
  SELECT prosrc ~ 'NULLIF\(\(v_item->>''price_cents''\)' INTO v_qd_has_client_override
  FROM pg_proc WHERE proname='create_quick_delivery' AND pronamespace='public'::regnamespace;
  IF COALESCE(v_qd_has_client_override, false) THEN
    RAISE EXCEPTION 'audit-fix verification: create_quick_delivery still honors client price_cents';
  END IF;

  -- 3. create_quick_delivery writes audit log
  SELECT prosrc ~ 'operation_type[^,]*''order_created''' INTO v_qd_has_audit_log
  FROM pg_proc WHERE proname='create_quick_delivery' AND pronamespace='public'::regnamespace;
  IF NOT COALESCE(v_qd_has_audit_log, false) THEN
    -- Fall back to a looser check
    SELECT prosrc ~ '''order_created''' INTO v_qd_has_audit_log
    FROM pg_proc WHERE proname='create_quick_delivery' AND pronamespace='public'::regnamespace;
    IF NOT COALESCE(v_qd_has_audit_log, false) THEN
      RAISE EXCEPTION 'audit-fix verification: create_quick_delivery missing order_created audit log';
    END IF;
  END IF;

  -- 4. convert_quote_to_order writes audit log
  SELECT prosrc ~ '''quote_converted''' INTO v_convert_has_audit_log
  FROM pg_proc WHERE proname='convert_quote_to_order' AND pronamespace='public'::regnamespace;
  IF NOT COALESCE(v_convert_has_audit_log, false) THEN
    RAISE EXCEPTION 'audit-fix verification: convert_quote_to_order missing quote_converted audit log';
  END IF;

  RAISE NOTICE 'audit-fix verification passed: quick-delivery server pricing + audit-log gap closed.';
END;
$$;
