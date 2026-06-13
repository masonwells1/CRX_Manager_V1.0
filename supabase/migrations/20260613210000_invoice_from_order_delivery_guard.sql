-- Roadmap #4 (sell-side) — order billing cockpit — W5: invoice/delivery double-rep guard
-- ============================================================================
-- FILE-ONLY (NOT applied — apply at G5). create_invoice_from_order today blocks
-- only on an existing ACTIVE INVOICE for the order — it has NO delivery check.
-- So creating a manual order-level invoice while a delivery is merely SCHEDULED
-- or IN_PROGRESS (no invoice produced yet) double-represents the order: the
-- manual invoice now + the delivery's own invoice on completion = double billing.
--
-- W5: also block when the order has ANY non-cancelled/non-voided delivery
-- (scheduled / in_progress / completed). Completed deliveries already produced an
-- invoice (caught by the existing-invoice check); this closes the scheduled/
-- in_progress gap. To bill the whole order manually, cancel/void its deliveries.
--
-- Body is BYTE-VERBATIM from the live definition (md5-style fidelity) except:
--   (1) DECLARE += `v_delivery_count int;`
--   (2) a new delivery-count guard immediately after the existing-invoice guard.
-- SECURITY DEFINER + search_path + auth/role gate + idempotency all unchanged;
-- single overload (uuid,uuid,text,text); CREATE OR REPLACE preserves the ACL
-- (no GRANT/REVOKE here). Reviewed: rls + drift (codex=PENDING → pre-G5 batch).
-- Rolled-back smoke (post-apply): docs/roadmap/smoke/04a-invoice-delivery-guard.sql.
--
-- UI follow-up (lands in #4 slice c, the billing panel): OrderDetail "Create
-- Invoice" should hide/disable when non-cancelled deliveries exist, so the UI
-- never offers an order-level invoice this guard would now reject.

CREATE OR REPLACE FUNCTION public.create_invoice_from_order(p_order_id uuid, p_salesman_id uuid DEFAULT NULL::uuid, p_invoice_type text DEFAULT 'chemical_sale'::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor          uuid := auth.uid();
  v_order          record;
  v_invoice_id     uuid;
  v_item           record;
  v_total_cents    bigint := 0;
  v_existing       jsonb;
  v_existing_count int;
  v_delivery_count int;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to create invoices from orders';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'create_invoice_from_order');
    IF v_existing IS NOT NULL THEN RETURN (v_existing->>'invoice_id')::uuid; END IF;
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found: %', p_order_id; END IF;

  SELECT COUNT(*) INTO v_existing_count
    FROM invoices
   WHERE order_id = p_order_id
     AND status NOT IN ('voided', 'cancelled');
  IF v_existing_count > 0 THEN
    RAISE EXCEPTION 'Active invoice already exists for order % (% existing invoice(s)). Void or cancel the existing invoice first if you need to recreate.', v_order.order_number, v_existing_count;
  END IF;

  -- W5 (sell-side #4): the order is being fulfilled via deliveries, which each
  -- produce their own invoice on completion — a manual order-level invoice here
  -- would double-represent the order. The check above only catches deliveries
  -- that ALREADY produced an invoice; a still scheduled/in_progress delivery has
  -- none yet, so this closes that gap.
  SELECT COUNT(*) INTO v_delivery_count
    FROM deliveries
   WHERE order_id = p_order_id
     AND status NOT IN ('cancelled', 'voided');
  IF v_delivery_count > 0 THEN
    RAISE EXCEPTION 'Cannot create an order-level invoice for order % — it has % active delivery(ies); invoices are created per delivery on completion. Cancel/void those deliveries first to bill the whole order manually.', v_order.order_number, v_delivery_count;
  END IF;

  INSERT INTO invoices (
    order_id, customer_id, invoice_type, status, season,
    salesman_id, created_by, total_amount_cents, invoice_date
  ) VALUES (
    p_order_id, v_order.customer_id, p_invoice_type, 'draft',
    COALESCE(v_order.season, (SELECT current_season())),
    COALESCE(p_salesman_id, v_order.salesman_id),
    v_actor, 0, CURRENT_DATE
  )
  RETURNING id INTO v_invoice_id;

  FOR v_item IN
    SELECT * FROM order_items WHERE order_id = p_order_id ORDER BY sort_order NULLS LAST, id
  LOOP
    INSERT INTO invoice_items (
      invoice_id, order_item_id, product_id, description,
      quantity, unit_price_cents, extended_cents, cost_cents,
      sort_order, rate_per_acre, acres, unit_size
    ) VALUES (
      v_invoice_id, v_item.id, v_item.product_id,
      COALESCE(v_item.product_name, ''),
      v_item.total_units_needed,
      round(v_item.price_per_unit * 100)::bigint,
      round(v_item.total_price * 100)::bigint,
      round(v_item.cost_per_unit * 100)::bigint,
      COALESCE(v_item.sort_order, 0),
      v_item.actual_rate,
      v_item.acres,
      v_item.unit_size
    );
    v_total_cents := v_total_cents + round(v_item.total_price * 100)::bigint;
  END LOOP;

  UPDATE invoices SET total_amount_cents = v_total_cents WHERE id = v_invoice_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'invoice_created', 'invoice', v_invoice_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object(
      'invoice_number', (SELECT invoice_number FROM invoices WHERE id = v_invoice_id),
      'order_number', v_order.order_number,
      'customer_id', v_order.customer_id,
      'total_cents', v_total_cents
    ),
    v_total_cents,
    'Invoice created from order ' || v_order.order_number
  );

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_created',
    'Invoice created from order ' || v_order.order_number,
    v_actor, 'invoice', v_invoice_id, v_order.customer_id
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_invoice_from_order', jsonb_build_object('invoice_id', v_invoice_id));
  END IF;

  RETURN v_invoice_id;
END;
$function$;
