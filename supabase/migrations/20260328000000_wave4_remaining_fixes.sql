-- ============================================================================
-- WAVE 4 REMAINING FIXES
-- ============================================================================
-- Fixes the following confirmed bugs from the Wave 4 audit:
--
-- CRITICAL:
--   C4: complete_delivery pre-check uses available + prebooked (wrong)
--       should be available - prebooked (Net Free)
--   C6: create_application_record_from_blend_ticket never deducts inventory
--
-- HIGH:
--   H3: record_invoice_payment sets phantom status 'paid' — CHECK constraint
--       rejects it; invoice status never updates on full payment
--   H10: receive_po_items no over-receive validation — can receive more than ordered
--   H14: create_quick_delivery no credit limit check
-- ============================================================================


-- ============================================================================
-- C4: Fix complete_delivery inventory pre-check
--     Bug: used (quantity_available + quantity_prebooked) — double counts reserved stock
--     Fix: use Net Free = (quantity_available - quantity_prebooked)
--          quantity_prebooked is a sub-count WITHIN quantity_available, not separate
-- ============================================================================
CREATE OR REPLACE FUNCTION public.complete_delivery(
  p_delivery_id     uuid,
  p_signed_by       text,
  p_performed_by    uuid,
  p_quantities      jsonb DEFAULT NULL,
  p_issue_type      text  DEFAULT NULL,
  p_issue_notes     text  DEFAULT NULL,
  p_idempotency_key text  DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_delivery              record;
  v_item                  record;
  v_inv                   record;
  v_all_delivered         boolean;
  v_qty_to_deliver        numeric;
  v_any_partial           boolean := false;
  v_linked_invoice        record;
  v_old_total             bigint;
  v_new_total             bigint;
  v_admin                 record;
  v_deduct_from_prebooked numeric;
  v_deduct_from_available numeric;
  v_net_free              numeric;
BEGIN
  SELECT * INTO v_delivery FROM deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery not found'; END IF;

  IF v_delivery.status = 'completed' THEN
    RETURN jsonb_build_object('status', 'already_completed');
  END IF;
  IF v_delivery.status != 'in_progress' THEN
    RAISE EXCEPTION 'Delivery must be started before completing. Current status: %', v_delivery.status;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = p_performed_by AND is_active = true
      AND (role IN ('admin', 'sales_rep') OR (role = 'driver' AND p_performed_by = v_delivery.assigned_driver))
  ) THEN RAISE EXCEPTION 'Not authorized to complete this delivery'; END IF;

  -- C4 FIX: Pre-check uses Net Free (available - prebooked), not available + prebooked
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

    -- C4 FIX: Net Free = available - prebooked (prebooked is a sub-count inside available)
    v_net_free := COALESCE(v_inv.quantity_available, 0) - COALESCE(v_inv.quantity_prebooked, 0);

    IF NOT FOUND OR v_net_free < v_qty_to_deliver THEN
      RAISE EXCEPTION 'Insufficient inventory for %: need % units, only % net free (% on-hand, % prebooked)',
        v_item.product_name, v_qty_to_deliver,
        GREATEST(v_net_free, 0),
        COALESCE(v_inv.quantity_available, 0),
        COALESCE(v_inv.quantity_prebooked, 0);
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
      v_delivery.order_id, p_delivery_id, p_performed_by,
      'Delivery ' || v_delivery.delivery_number ||
        CASE WHEN v_qty_to_deliver < v_item.quantity
          THEN ' (partial: ' || v_qty_to_deliver || '/' || v_item.quantity || ')'
          ELSE '' END || '. Signed by: ' || p_signed_by
    );

    -- Deduct from prebooked FIRST, then from available for the remainder
    SELECT * INTO v_inv FROM inventory
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

    v_deduct_from_prebooked := LEAST(v_qty_to_deliver, COALESCE(v_inv.quantity_prebooked, 0));
    v_deduct_from_available := v_qty_to_deliver - v_deduct_from_prebooked;

    UPDATE inventory SET
      quantity_available = quantity_available - v_deduct_from_available,
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
      WHERE order_id = v_delivery.order_id AND deleted_at IS NULL AND status IN ('draft', 'posted')
    LOOP
      IF v_linked_invoice.status = 'draft' THEN
        v_old_total := v_linked_invoice.total_amount_cents;
        UPDATE invoice_items ii SET
          quantity = oi.quantity_delivered,
          extended_cents = ii.unit_price_cents * oi.quantity_delivered::bigint
        FROM order_items oi
        WHERE ii.invoice_id = v_linked_invoice.id
          AND ii.order_item_id = oi.id
          AND oi.quantity_delivered < oi.total_units_needed;

        SELECT COALESCE(SUM(extended_cents), 0) INTO v_new_total
        FROM invoice_items WHERE invoice_id = v_linked_invoice.id;

        UPDATE invoices SET
          total_amount_cents = v_new_total,
          total_cost_cents = (SELECT COALESCE(SUM(cost_cents * quantity), 0) FROM invoice_items WHERE invoice_id = v_linked_invoice.id),
          updated_at = now()
        WHERE id = v_linked_invoice.id;
      ELSE
        FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
        LOOP
          INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
          VALUES (v_admin.id, 'Partial Delivery — Posted Invoice Needs Review',
            'Delivery ' || v_delivery.delivery_number || ' completed with partial quantities. Invoice ' ||
              v_linked_invoice.invoice_number || ' may need adjustment.',
            'delivery_partial', 'invoice', v_linked_invoice.id);
        END LOOP;
      END IF;
    END LOOP;
  END IF;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_completed',
    'Delivery ' || v_delivery.delivery_number || ' completed.' ||
      CASE WHEN v_any_partial THEN ' Partial delivery — some items have remainders.' ELSE '' END ||
      ' Signed by: ' || p_signed_by,
    p_performed_by, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  RETURN jsonb_build_object(
    'status', 'completed', 'delivery_id', p_delivery_id,
    'partial', v_any_partial, 'order_fully_delivered', v_all_delivered
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.complete_delivery(uuid, text, uuid, jsonb, text, text, text) TO authenticated;


-- ============================================================================
-- C6: Add inventory deduction to create_application_record_from_blend_ticket
--     After inserting the application record, loop through blend_ticket_products
--     and deduct quantity_available from inventory for each product used.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.create_application_record_from_blend_ticket(
  p_blend_ticket_id uuid,
  p_performed_by    uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket      record;
  v_record_number text;
  v_product_data  jsonb;
  v_record_id     uuid;
  v_season        integer;
  v_bt_product    record;
BEGIN
  -- Fetch the blend ticket
  SELECT bt.*, f.id AS linked_field_id
  INTO v_ticket
  FROM blend_tickets bt
  LEFT JOIN fields f ON f.id = bt.field_id
  WHERE bt.id = p_blend_ticket_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Blend ticket not found: %', p_blend_ticket_id;
  END IF;

  IF v_ticket.review_status != 'approved' THEN
    RAISE EXCEPTION 'Blend ticket must be approved before creating an application record. Current status: %', v_ticket.review_status;
  END IF;

  -- Prevent duplicate application records for the same blend ticket
  IF EXISTS (
    SELECT 1 FROM application_records
    WHERE source_type = 'blend_ticket' AND source_id = p_blend_ticket_id
  ) THEN
    RAISE EXCEPTION 'An application record already exists for this blend ticket';
  END IF;

  v_record_number := next_application_record_number();

  -- Build product_data JSONB from blend_ticket_products
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'product_id',       btp.product_id,
        'product_name',     btp.product_name,
        'quantity',         btp.quantity,
        'unit',             btp.unit,
        'rate_per_acre',    btp.rate_per_acre,
        'rate_unit',        btp.rate_per_acre_unit,
        'epa_registration', p.epa_registration,
        'is_rup',           COALESCE(p.is_rup, false)
      )
      ORDER BY btp.sequence_order
    ),
    '[]'::jsonb
  )
  INTO v_product_data
  FROM blend_ticket_products btp
  LEFT JOIN products p ON p.id = btp.product_id
  WHERE btp.blend_ticket_id = p_blend_ticket_id;

  -- Calculate season from application date (Oct 1 = new season)
  v_season := CASE
    WHEN EXTRACT(MONTH FROM COALESCE(v_ticket.ticket_date, v_ticket.upload_date)::date) >= 10
    THEN EXTRACT(YEAR FROM COALESCE(v_ticket.ticket_date, v_ticket.upload_date)::date) + 1
    ELSE EXTRACT(YEAR FROM COALESCE(v_ticket.ticket_date, v_ticket.upload_date)::date)
  END;

  -- Insert the application record
  INSERT INTO application_records (
    record_number, source_type, source_id,
    customer_id, applicator_id, field_id,
    application_date, application_time,
    product_data, total_acres, total_volume, total_volume_unit,
    weather_conditions, notes, season, created_by
  ) VALUES (
    v_record_number, 'blend_ticket', p_blend_ticket_id,
    v_ticket.customer_id,
    (SELECT id FROM profiles WHERE full_name = v_ticket.applicator_name AND role = 'applicator' LIMIT 1),
    v_ticket.linked_field_id,
    COALESCE(v_ticket.ticket_date, v_ticket.upload_date)::date,
    v_ticket.ticket_time,
    v_product_data,
    v_ticket.total_acres,
    v_ticket.total_volume,
    v_ticket.total_volume_unit,
    NULL,
    v_ticket.notes,
    v_season,
    p_performed_by
  )
  RETURNING id INTO v_record_id;

  -- C6 FIX: Deduct inventory for each product used in the blend
  FOR v_bt_product IN
    SELECT btp.product_id, btp.quantity
    FROM blend_ticket_products btp
    WHERE btp.blend_ticket_id = p_blend_ticket_id
      AND btp.product_id IS NOT NULL
      AND btp.quantity > 0
  LOOP
    UPDATE inventory SET
      quantity_available = quantity_available - v_bt_product.quantity,
      updated_at         = now()
    WHERE product_id = v_bt_product.product_id
      AND location   = 'Main Warehouse';

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity,
      reference_id, performed_by, notes
    ) VALUES (
      v_bt_product.product_id,
      'delivered',
      v_bt_product.quantity,
      v_record_id,
      p_performed_by,
      'Blend ticket application: ' || v_ticket.ticket_number
    );
  END LOOP;

  RETURN v_record_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_application_record_from_blend_ticket(uuid, uuid) TO authenticated;


-- ============================================================================
-- H3: Fix record_invoice_payment phantom 'paid' status
--     Invoice lifecycle is draft -> posted -> void. No 'paid' status exists.
--     When fully paid, the invoice stays 'posted' (balance_cents goes to 0).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.record_invoice_payment(
  p_invoice_id       uuid,
  p_amount_cents     bigint,
  p_payment_method   text,
  p_reference_number text   DEFAULT NULL,
  p_notes            text   DEFAULT NULL,
  p_idempotency_key  text   DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv      record;
  v_pay_id   uuid;
  v_actor_role text;
BEGIN
  -- Role check: admin or sales_rep only
  SELECT role INTO v_actor_role FROM profiles WHERE id = auth.uid();
  IF v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'Not authorized to record invoice payments';
  END IF;

  -- H4: Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    DECLARE v_existing jsonb;
    BEGIN
      v_existing := check_idempotency(p_idempotency_key, 'record_invoice_payment');
      IF (v_existing->>'status') = 'completed' THEN
        RETURN (v_existing->'result'->>'payment_id')::uuid;
      END IF;
    END;
  END IF;

  -- H2: Reject if accounting period is closed
  PERFORM check_period_open(now()::date);

  SELECT * INTO v_inv
  FROM public.invoices
  WHERE id = p_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found: %', p_invoice_id;
  END IF;

  IF v_inv.status != 'posted' THEN
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

  -- H3 FIX: Invoice stays 'posted' when fully paid (no 'paid' status in CHECK constraint)
  --         balance_cents auto-updates (generated column) when paid_amount_cents changes
  UPDATE public.invoices SET
    paid_amount_cents = paid_amount_cents + p_amount_cents,
    status            = status,   -- always keep existing status (posted); balance_cents is computed
    updated_at        = now()
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


-- ============================================================================
-- H10: Add over-receive validation to receive_po_items
--      Prevents receiving more than the ordered quantity for any PO line item.
--      Uses p_allow_over_receive flag to permit explicit override (default false).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.receive_po_items(
  p_purchase_order_id uuid,
  p_items             jsonb,
  p_performed_by      uuid DEFAULT NULL,
  p_idempotency_key   text DEFAULT NULL,
  p_allow_over_receive boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor                uuid;
  v_po                   record;
  v_item                 jsonb;
  v_po_item              record;
  v_product              record;
  v_qty_received         numeric;
  v_qty_already_received numeric;
  v_qty_ordered          numeric;
  v_recv_id              uuid;
  v_receiving_record_ids jsonb    := '[]';
  v_affected_po_ids      uuid[]   := '{}';
  v_unique_po_id         uuid;
  v_result               jsonb;
  v_new_cost             numeric;
  v_current_qty          numeric;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to receive PO items';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    DECLARE v_existing jsonb;
    BEGIN
      v_existing := check_idempotency(p_idempotency_key, 'receive_po_items');
      IF (v_existing->>'status') = 'completed' THEN
        RETURN v_existing->'result';
      END IF;
    END;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT * INTO v_po_item
      FROM purchase_order_items
     WHERE id = (v_item->>'purchase_order_item_id')::uuid
       FOR UPDATE;

    IF NOT FOUND THEN CONTINUE; END IF;

    SELECT * INTO v_po
      FROM purchase_orders WHERE id = v_po_item.purchase_order_id;

    v_qty_received := (v_item->>'quantity_received')::numeric;
    IF v_qty_received IS NULL OR v_qty_received <= 0 THEN CONTINUE; END IF;

    -- H10 FIX: Block over-receiving unless explicitly allowed
    v_qty_ordered          := COALESCE(v_po_item.quantity_ordered, 0);
    v_qty_already_received := COALESCE(v_po_item.quantity_received, 0);

    IF NOT p_allow_over_receive
       AND (v_qty_already_received + v_qty_received) > v_qty_ordered
    THEN
      RAISE EXCEPTION
        'Over-receive blocked for PO line %: ordered %, already received %, attempting to receive % more (total would be %)',
        v_po_item.id,
        v_qty_ordered,
        v_qty_already_received,
        v_qty_received,
        v_qty_already_received + v_qty_received;
    END IF;

    INSERT INTO receiving_records (
      purchase_order_item_id, purchase_order_id,
      product_id, quantity_received, unit_cost,
      condition, lot_number, notes, received_by
    ) VALUES (
      v_po_item.id, v_po_item.purchase_order_id,
      v_po_item.product_id, v_qty_received, v_po_item.unit_cost,
      COALESCE(v_item->>'condition', 'good'),
      v_item->>'lot_number',
      v_item->>'notes',
      v_actor
    ) RETURNING id INTO v_recv_id;

    v_receiving_record_ids := v_receiving_record_ids || to_jsonb(v_recv_id::text);

    UPDATE purchase_order_items SET
      quantity_received = COALESCE(quantity_received, 0) + v_qty_received,
      updated_at        = now()
    WHERE id = v_po_item.id;

    UPDATE inventory SET
      quantity_available = quantity_available + v_qty_received,
      updated_at         = now()
    WHERE product_id = v_po_item.product_id AND location = 'Main Warehouse';

    IF NOT FOUND THEN
      INSERT INTO inventory (product_id, location, quantity_available)
      VALUES (v_po_item.product_id, 'Main Warehouse', v_qty_received);
    END IF;

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity,
      reference_id, performed_by, notes
    ) VALUES (
      v_po_item.product_id, 'received', v_qty_received,
      v_po_item.purchase_order_id, v_actor,
      'Received from PO: ' || COALESCE(v_po.po_number, v_po_item.purchase_order_id::text)
    );

    -- M7: Weighted average cost update
    IF v_po_item.unit_cost IS NOT NULL AND v_po_item.unit_cost > 0 THEN
      SELECT * INTO v_product FROM products WHERE id = v_po_item.product_id;
      IF FOUND THEN
        SELECT COALESCE(quantity_available, 0) - v_qty_received
          INTO v_current_qty
          FROM inventory
         WHERE product_id = v_po_item.product_id AND location = 'Main Warehouse';

        v_current_qty := GREATEST(COALESCE(v_current_qty, 0), 0);

        IF (v_current_qty + v_qty_received) > 0 THEN
          v_new_cost := ROUND(
            (v_current_qty * COALESCE(v_product.current_cost, v_po_item.unit_cost) +
             v_qty_received * v_po_item.unit_cost)
            / (v_current_qty + v_qty_received),
            4
          );
        ELSE
          v_new_cost := v_po_item.unit_cost;
        END IF;

        IF v_new_cost IS DISTINCT FROM v_product.current_cost THEN
          INSERT INTO cost_history (product_id, changed_by, old_cost, new_cost, change_note)
          VALUES (
            v_po_item.product_id, v_actor,
            v_product.current_cost, v_new_cost,
            'Weighted avg cost update from PO receiving'
          );

          UPDATE products SET
            current_cost      = v_new_cost,
            cost_updated_date = now()
          WHERE id = v_po_item.product_id;
        END IF;
      END IF;
    END IF;

    v_affected_po_ids := array_append(v_affected_po_ids, v_po_item.purchase_order_id);
  END LOOP;

  FOREACH v_unique_po_id IN ARRAY (SELECT ARRAY(SELECT DISTINCT unnest(v_affected_po_ids)))
  LOOP
    PERFORM update_po_status(v_unique_po_id);
  END LOOP;

  v_result := jsonb_build_object(
    'status',                'received',
    'receiving_record_ids',  v_receiving_record_ids
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'receive_po_items', v_result);
  END IF;

  RETURN v_result;
END;
$$;

-- Keep 4-param signature available for existing callers (old overload without p_allow_over_receive)
DROP FUNCTION IF EXISTS public.receive_po_items(uuid, jsonb, uuid, text);
GRANT EXECUTE ON FUNCTION public.receive_po_items(uuid, jsonb, uuid, text, boolean) TO authenticated;


-- ============================================================================
-- H14: Add credit limit check to create_quick_delivery
--      Checks customer's current AR balance against credit_limit_cents.
--      If credit_limit_cents = 0, the check is skipped (no limit configured).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.create_quick_delivery(
  p_customer_id      uuid,
  p_items            jsonb,
  p_driver_id        uuid    DEFAULT NULL,
  p_scheduled_date   date    DEFAULT CURRENT_DATE,
  p_delivery_notes   text    DEFAULT NULL,
  p_performed_by     uuid    DEFAULT NULL,
  p_idempotency_key  text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

  -- H14 FIX: Credit limit check (skip if limit is 0 = no limit configured)
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

  -- Step 3: Create Invoice (draft)
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

    -- Create invoice item
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

  -- Update order and invoice totals
  UPDATE orders SET
    total_price  = (v_total_cents      / 100.0)::numeric,
    total_cost   = (v_total_cost_cents / 100.0)::numeric,
    total_profit = ((v_total_cents - v_total_cost_cents) / 100.0)::numeric,
    total_margin_pct = CASE WHEN v_total_cents > 0
      THEN ROUND((v_total_cents - v_total_cost_cents)::numeric / v_total_cents * 100, 2)
      ELSE 0
    END
  WHERE id = v_order_id;

  UPDATE invoices SET
    total_amount_cents = v_total_cents,
    total_cost_cents   = v_total_cost_cents
  WHERE id = v_invoice_id;

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

  RETURN jsonb_build_object(
    'order_id',        v_order_id,
    'delivery_id',     v_delivery_id,
    'invoice_id',      v_invoice_id,
    'order_number',    v_order_number,
    'delivery_number', v_delivery_number,
    'invoice_number',  v_invoice_number,
    'total_cents',     v_total_cents
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_quick_delivery(uuid, jsonb, uuid, date, text, uuid, text) TO authenticated;
