-- Overnight bug-hunt: invoice-creator provenance + derived totals (non-field paths)
--
-- Two parked findings on the order/delivery invoice creators (the field-app creators +
-- save_invoice/load_recipe are reworked on feat/as-applied-invoices and are NOT touched
-- here to avoid a merge collision):
--
--   MED audit-log:create_invoice_for_unbilled_delivery:missing-invoice_created-row —
--   this backfill creator writes only an activity_feed row, no financial_audit_log
--   'invoice_created' row, unlike create_invoice_from_order. Add the audit row so the
--   append-only ledger has a creation breadcrumb (draft-stage provenance; post_invoice
--   still writes its own 'invoice_posted' later).
--
--   LOW stale-derived-state:create_invoice_from_order:total_cost_cents-zero — it is the
--   lone invoice creator that leaves total_cost_cents at the column default 0 (sets only
--   total_amount_cents). Accumulate cost in the item loop and set total_cost_cents,
--   mirroring create_invoice_for_unbilled_delivery (cost_per_unit is per-unit; the header
--   total is SUM(round(cost_per_unit*qty*100)) — same shape that creator already uses).
--
-- Bodies reproduced verbatim from the live definitions (read 2026-06-20) with ONLY the
-- additions above — verified by a rolled-back line-level diff. Latent on live data.

-- =====================================================================
-- 1. create_invoice_from_order — add total_cost_cents
-- =====================================================================
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
  v_cost_cents     bigint := 0;
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

  -- Codex P1: lock the order row FOR UPDATE before the existence checks below.
  -- create_delivery_with_items locks the order while it inserts a delivery; without
  -- this lock the invoice txn could read zero deliveries while a concurrent
  -- scheduled-delivery insert is still uncommitted, then create the order-level
  -- invoice anyway — recreating the exact double-billing this guard prevents.
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
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
    v_cost_cents := v_cost_cents + round(COALESCE(v_item.cost_per_unit, 0) * v_item.total_units_needed * 100)::bigint;
  END LOOP;

  UPDATE invoices SET total_amount_cents = v_total_cents, total_cost_cents = v_cost_cents WHERE id = v_invoice_id;

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

-- =====================================================================
-- 2. create_invoice_for_unbilled_delivery — add invoice_created audit row
-- =====================================================================
CREATE OR REPLACE FUNCTION public.create_invoice_for_unbilled_delivery(p_delivery_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor             uuid;
  v_existing          jsonb;
  v_delivery          record;
  v_existing_count    integer;
  v_invoice_id        uuid;
  v_invoice_number    text;
  v_total_cents       bigint := 0;
  v_cost_cents        bigint := 0;
  v_item              record;
  v_result            jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admin access required to create an invoice for a delivery';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'create_invoice_for_unbilled_delivery');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_delivery FROM deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found: %', p_delivery_id;
  END IF;
  IF v_delivery.status != 'completed' THEN
    RAISE EXCEPTION 'Delivery is not completed (current status: %). Only completed deliveries can be invoiced retroactively.', v_delivery.status;
  END IF;
  IF v_delivery.order_id IS NULL THEN
    RAISE EXCEPTION 'Delivery has no order_id — cannot auto-invoice an orphan delivery';
  END IF;

  SELECT COUNT(*) INTO v_existing_count
  FROM invoices
  WHERE order_id = v_delivery.order_id
    AND status NOT IN ('voided', 'cancelled');

  IF v_existing_count > 0 THEN
    RAISE EXCEPTION 'Order already has an active invoice — nothing to backfill. Find and review the existing invoice instead.';
  END IF;

  v_invoice_number := next_invoice_number('chemical_sale');
  INSERT INTO invoices (
    invoice_number, invoice_type, order_id, customer_id, delivery_id,
    status, invoice_date, total_amount_cents, total_cost_cents, created_by
  ) VALUES (
    v_invoice_number, 'chemical_sale', v_delivery.order_id, v_delivery.customer_id, p_delivery_id,
    'draft', CURRENT_DATE, 0, 0, v_actor
  ) RETURNING id INTO v_invoice_id;

  FOR v_item IN
    SELECT di.product_id, di.quantity_delivered, di.unit_size, di.order_item_id,
           oi.price_per_unit, oi.cost_per_unit, oi.product_name AS oi_product_name,
           p.product_name AS p_name
      FROM delivery_items di
      JOIN order_items oi ON oi.id = di.order_item_id
      JOIN products p ON p.id = di.product_id
     WHERE di.delivery_id = p_delivery_id
       AND COALESCE(di.quantity_delivered, 0) > 0
  LOOP
    v_total_cents := v_total_cents + ROUND(v_item.quantity_delivered * v_item.price_per_unit * 100)::bigint;
    v_cost_cents  := v_cost_cents  + ROUND(v_item.quantity_delivered * COALESCE(v_item.cost_per_unit, 0) * 100)::bigint;
    INSERT INTO invoice_items (
      invoice_id, order_item_id, product_id, description,
      quantity, unit_price_cents, extended_cents, cost_cents,
      unit_size
    ) VALUES (
      v_invoice_id, v_item.order_item_id, v_item.product_id,
      COALESCE(v_item.oi_product_name, v_item.p_name),
      v_item.quantity_delivered,
      ROUND(v_item.price_per_unit * 100)::bigint,
      ROUND(v_item.quantity_delivered * v_item.price_per_unit * 100)::bigint,
      ROUND(COALESCE(v_item.cost_per_unit, 0) * 100)::bigint,
      v_item.unit_size
    );
  END LOOP;

  UPDATE invoices
     SET total_amount_cents = v_total_cents,
         total_cost_cents   = v_cost_cents
   WHERE id = v_invoice_id;

  -- Provenance breadcrumb (overnight bug-hunt MED, 20260620): write the same
  -- financial_audit_log 'invoice_created' row create_invoice_from_order writes, so the
  -- append-only ledger records this backfill creator too (it previously logged only
  -- activity_feed). Draft-stage provenance; post_invoice still writes 'invoice_posted'.
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'invoice_created', 'invoice', v_invoice_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object(
      'invoice_number', v_invoice_number,
      'delivery_id', p_delivery_id,
      'order_id', v_delivery.order_id,
      'customer_id', v_delivery.customer_id,
      'total_cents', v_total_cents
    ),
    v_total_cents,
    'Invoice ' || v_invoice_number || ' backfilled for completed delivery ' || v_delivery.delivery_number
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'invoice_backfilled_for_delivery',
    'Backfilled draft invoice ' || v_invoice_number ||
    ' for completed delivery ' || v_delivery.delivery_number,
    v_actor, 'invoice', v_invoice_id, v_delivery.customer_id
  );

  v_result := jsonb_build_object(
    'success',         true,
    'delivery_id',     p_delivery_id,
    'invoice_id',      v_invoice_id,
    'invoice_number',  v_invoice_number,
    'total_cents',     v_total_cents
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_invoice_for_unbilled_delivery', v_result);
  END IF;

  RETURN v_result;
END;
$function$;
