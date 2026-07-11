-- Money+Inventory night hunt 2026-07-10, cycle 4 (finding #9a), Codex-gated.
-- create_invoice_for_unbilled_delivery: the re-invoice existence guard counted a
-- SOFT-DELETED draft invoice as active coverage. delete_invoices soft-deletes a
-- draft/unposted invoice (sets deleted_at) but LEAVES status='draft'/'unposted', so
-- the COUNT(*) with `status NOT IN ('voided','cancelled')` still matched it and the
-- RPC raised "This delivery already has an active invoice … nothing to backfill" —
-- permanently blocking re-billing a delivery after its draft invoice was soft-deleted
-- (a normal billing correction). The chemical-sale delivery path resets no order/
-- delivery state, so the revenue was stranded with no path to bill it.
--
-- Fix: add `AND deleted_at IS NULL` to the coverage COUNT. Body is otherwise
-- byte-identical to the live function (proven by md5 of the corrected body ==
-- ea23ba239d73c275ba2ec361c5186d28). Sibling guards in complete_delivery and
-- get_dashboard_action_items share the same omission and are tracked separately
-- (parked — see REPORT-money-inventory-2026-07-10.md).

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

  -- OVERNIGHT FIX (Run 2 cycle 3, finding #9): serialize per-order invoice creation on the
  -- order row BEFORE the existence COUNT, so this backfill cannot race complete_delivery's
  -- auto-invoice (which holds this same order lock via its earlier `UPDATE orders`) or another
  -- concurrent backfill into TWO active draft invoices for one order (double-billing). Mirrors
  -- create_invoice_from_order's order FOR UPDATE. (No unique index on invoices(order_id):
  -- field-billing split invoices intentionally create multiple same-order active drafts.)
  PERFORM 1 FROM orders WHERE id = v_delivery.order_id FOR UPDATE;

  -- U2 (Codex P2): per-DELIVERY awareness, mirroring complete_delivery's
  -- auto-invoice guard — an invoice tied to a DIFFERENT delivery must not block
  -- backfilling THIS delivery; this delivery's own invoice or an order-level
  -- invoice (delivery_id IS NULL) still blocks.
  SELECT COUNT(*) INTO v_existing_count
  FROM invoices
  WHERE order_id = v_delivery.order_id
    AND status NOT IN ('voided', 'cancelled')
    AND (delivery_id = p_delivery_id OR delivery_id IS NULL)
    AND deleted_at IS NULL;

  IF v_existing_count > 0 THEN
    RAISE EXCEPTION 'This delivery already has an active invoice (or an order-level invoice covers the whole order) — nothing to backfill. Find and review the existing invoice instead.';
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
