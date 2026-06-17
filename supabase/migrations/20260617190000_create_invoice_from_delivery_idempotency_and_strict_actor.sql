-- Gauntlet fixes for create_invoice_from_delivery (SECURITY DEFINER, jsonb) — TWO findings, one migration.
--
-- (A) MED-4 (idempotency not wired): the RPC declared p_idempotency_key but never used the canonical
--     check_idempotency()/save_idempotency() helpers, so a retried call (e.g. a double-submit or a
--     network retry of the same request) would create a SECOND draft invoice for the same delivery
--     instead of replaying the first call's result. Fix: add the canonical early-return
--     check_idempotency(p_idempotency_key,'create_invoice_from_delivery') right after the strict-actor
--     block, and save_idempotency(p_idempotency_key,'create_invoice_from_delivery', v_result) just before
--     the success RETURN. The existing natural duplicate guard ("An invoice already exists for this
--     delivery") is KEPT verbatim but moved to run AFTER auth/authz and the idempotency replay, so a
--     same-key retry replays its prior result instead of erroring; the natural guard still blocks a NEW
--     key (or no-key call) racing in for a delivery that already has an invoice.
--     Final order: strict-actor -> authz -> idempotency replay -> natural duplicate guard -> work -> save.
--
-- (B) fin-audit actor hardening: financial_audit_log.actor_role was derived from
--     (SELECT role FROM profiles WHERE id = p_performed_by) — a forgeable, caller-supplied actor id. An
--     authenticated admin/sales_rep could attribute the invoice-creation audit row (and the activity-feed
--     entry / invoices.created_by) to another employee. Fix: the canonical strict-actor block —
--     v_actor := auth.uid() -> RAISE 'AUTH_REQUIRED' if null -> RAISE 'ACTOR_MISMATCH' if p_performed_by is
--     a non-null mismatch — placed BEFORE the idempotency replay. Every actor/created_by stamp
--     (invoices.created_by, financial_audit_log.actor_role lookup, activity_feed.performed_by) now uses
--     v_actor (the authenticated caller) instead of p_performed_by. The UI already passes the current
--     profile id as p_performed_by, so the legitimate path is unchanged; only a forged actor id is rejected.
--
-- Signature, return shape, SECURITY DEFINER, SET search_path, the idempotency operation string
-- ('create_invoice_from_delivery'), and ALL business logic are otherwise BYTE-IDENTICAL to the current
-- live body. Single overload confirmed: (p_delivery_id uuid, p_performed_by uuid, p_idempotency_key text).
-- Template for the canonical idempotency/strict-actor shape: 20260616201800_void_delivery_canonical_idempotency.sql.

CREATE OR REPLACE FUNCTION public.create_invoice_from_delivery(p_delivery_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_delivery record;
  v_order record;
  v_invoice_id uuid;
  v_invoice_number text;
  v_total_cents bigint := 0;
  v_total_cost_cents bigint := 0;
  v_item record;
  v_order_item record;
  v_qty numeric;
  v_extended bigint;
  v_cost bigint;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  -- Strict actor pattern (gauntlet fin-audit actor hardening): bind the authenticated caller and reject a
  -- forged p_performed_by. Placed BEFORE the idempotency replay.
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  -- Authorization check (added by wave3 audit)
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin','sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized: requires admin,sales_rep role';
  END IF;

  -- Canonical idempotency replay (MED-4): replay this key's prior result verbatim instead of creating a
  -- second invoice on a retried call. Placed after the strict-actor block.
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'create_invoice_from_delivery');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  -- Natural duplicate guard: block a NEW idempotency key (or a no-key call) from creating a second
  -- invoice for a delivery that already has one. Runs AFTER auth/authz and the idempotency replay, so a
  -- same-key retry replays its prior result above instead of erroring here.
  IF EXISTS (SELECT 1 FROM invoices WHERE delivery_id = p_delivery_id AND status != 'cancelled') THEN
    RAISE EXCEPTION 'An invoice already exists for this delivery';
  END IF;

  SELECT * INTO v_delivery FROM deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found: %', p_delivery_id;
  END IF;

  IF v_delivery.order_id IS NULL THEN
    RAISE EXCEPTION 'Delivery has no linked order';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = v_delivery.order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found for delivery';
  END IF;

  INSERT INTO invoices (
    order_id, customer_id, invoice_type, status, season,
    salesman_id, created_by, total_amount_cents, invoice_date
  ) VALUES (
    v_delivery.order_id,
    v_delivery.customer_id,
    'chemical_sale',
    'draft',
    COALESCE(v_order.season, (SELECT current_season())),
    v_order.salesman_id,
    v_actor,
    0,
    CURRENT_DATE
  )
  RETURNING id, invoice_number INTO v_invoice_id, v_invoice_number;

  FOR v_item IN
    SELECT di.*
    FROM delivery_items di
    WHERE di.delivery_id = p_delivery_id
      AND COALESCE(di.quantity_delivered, di.quantity) > 0
  LOOP
    SELECT * INTO v_order_item
    FROM order_items
    WHERE id = v_item.order_item_id;

    IF NOT FOUND THEN CONTINUE; END IF;

    v_qty := COALESCE(v_item.quantity_delivered, v_item.quantity);
    v_extended := round(v_order_item.price_per_unit * v_qty * 100)::bigint;
    v_cost := round(v_order_item.cost_per_unit * 100)::bigint;

    INSERT INTO invoice_items (
      invoice_id, order_item_id, product_id, description,
      quantity, unit_price_cents, extended_cents, cost_cents,
      sort_order, rate_per_acre, acres, unit_size
    ) VALUES (
      v_invoice_id,
      v_item.order_item_id,
      v_item.product_id,
      COALESCE(v_order_item.product_name, ''),
      v_qty,
      round(v_order_item.price_per_unit * 100)::bigint,
      v_extended,
      v_cost,
      COALESCE(v_order_item.sort_order, 0),
      v_order_item.actual_rate,
      v_order_item.acres,
      v_item.unit_size
    );

    v_total_cents := v_total_cents + v_extended;
    v_total_cost_cents := v_total_cost_cents + (v_cost * v_qty::bigint);
  END LOOP;

  UPDATE invoices SET
    total_amount_cents = v_total_cents,
    total_cost_cents = v_total_cost_cents
  WHERE id = v_invoice_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'invoice_created', 'invoice', v_invoice_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object(
      'invoice_number', v_invoice_number,
      'delivery_number', v_delivery.delivery_number,
      'order_number', v_order.order_number,
      'customer_id', v_delivery.customer_id,
      'total_cents', v_total_cents
    ),
    v_total_cents,
    'Draft invoice auto-created from delivery ' || v_delivery.delivery_number
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'invoice_created',
    'Draft invoice ' || v_invoice_number || ' auto-created from delivery ' || v_delivery.delivery_number,
    v_actor, 'invoice', v_invoice_id, v_delivery.customer_id
  );

  v_result := jsonb_build_object(
    'invoice_id', v_invoice_id,
    'invoice_number', v_invoice_number,
    'total_cents', v_total_cents
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_invoice_from_delivery', v_result);
  END IF;

  RETURN v_result;
END;
$function$;
