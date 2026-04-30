-- =============================================================================
-- Migration: 20260430220000_field_app_workflow_phase10.sql
-- Phase 10 — Sprint A2 + Sprint B (folded together).
--
-- Sprint A2: auth gates on save_invoice and create_invoice_from_order.
-- Sprint B:  invoice integrity rules on the same two functions.
--
-- Sprint B rule #1 (save_invoice): reject standalone invoices that have
--   neither order_id nor blend_ticket_id (CLAUDE.md hard rule). Previously,
--   save_invoice silently created standalone invoices because it didn't read
--   order_id/blend_ticket_id from the payload at all.
--
-- Sprint B rule #2 (create_invoice_from_order): reject duplicate active
--   invoices for the same order. Previously, the UI's "Create Invoice"
--   button could be clicked twice and create two active invoices for the
--   same order, overbilling the customer.
--
-- Note: save_invoice has NO p_performed_by parameter (it uses auth.uid()
-- directly inline), so the actor-mismatch check is N/A — the only fix it
-- needs is the role check + standalone rejection.
--
-- create_invoice_from_order also has no p_performed_by; uses auth.uid()
-- inline — only role check + duplicate guard needed.
-- =============================================================================


-- =============================================================================
-- 1. save_invoice — role gate + reject standalone invoices
-- =============================================================================

CREATE OR REPLACE FUNCTION save_invoice(
  p_invoice         jsonb,
  p_items           jsonb DEFAULT '[]'::jsonb,
  p_idempotency_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor       uuid := auth.uid();
  v_invoice_id  uuid;
  v_is_new      boolean := false;
  v_item        jsonb;
  v_total_cents bigint := 0;
  v_qty         numeric;
  v_unit_price  bigint;
  v_extended    bigint;
  v_cost_cents  bigint;
  v_product     record;
  v_order_id    uuid;
  v_blend_id    uuid;
BEGIN
  -- ── Phase 10 #1: auth gate (role check) ─────────────────────────────────
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to save invoices';
  END IF;

  v_invoice_id := (p_invoice->>'id')::uuid;
  v_order_id   := (p_invoice->>'order_id')::uuid;
  v_blend_id   := (p_invoice->>'blend_ticket_id')::uuid;

  IF v_invoice_id IS NULL THEN
    -- ── Phase 10 #2 (Sprint B): reject standalone invoices ────────────────
    -- CLAUDE.md hard rule: invoices must link to an order or blend ticket.
    -- save_invoice previously didn't read these IDs from the payload at all,
    -- silently violating the rule.
    IF v_order_id IS NULL AND v_blend_id IS NULL THEN
      RAISE EXCEPTION 'Invoices must link to an order or blend ticket. Provide order_id or blend_ticket_id in p_invoice payload.';
    END IF;

    v_is_new := true;
    INSERT INTO invoices (
      order_id, blend_ticket_id,
      customer_id, invoice_type, status, season, salesman_id,
      invoice_date, due_date, purchase_order_ref, header_notes, footer_notes,
      total_amount_cents, created_by
    ) VALUES (
      v_order_id, v_blend_id,
      (p_invoice->>'customer_id')::uuid,
      COALESCE(p_invoice->>'invoice_type', 'chemical_sale'),
      COALESCE(p_invoice->>'status', 'draft'),
      COALESCE((p_invoice->>'season')::int, (SELECT current_season())),
      (p_invoice->>'salesman_id')::uuid,
      COALESCE((p_invoice->>'invoice_date')::date, CURRENT_DATE),
      (p_invoice->>'due_date')::date,
      p_invoice->>'purchase_order_ref',
      p_invoice->>'header_notes',
      p_invoice->>'footer_notes',
      0,
      v_actor
    )
    RETURNING id INTO v_invoice_id;
  ELSE
    -- Update existing (only if draft/unposted).
    -- Note: we deliberately do NOT enforce the order_id/blend_ticket_id rule
    -- on existing invoices — pre-Phase-10 invoices may already lack the link
    -- and we don't want to retroactively block their edits. The hard rule
    -- only applies to new creation.
    UPDATE invoices SET
      customer_id = COALESCE((p_invoice->>'customer_id')::uuid, customer_id),
      invoice_type = COALESCE(p_invoice->>'invoice_type', invoice_type),
      season = COALESCE((p_invoice->>'season')::int, season),
      salesman_id = (p_invoice->>'salesman_id')::uuid,
      invoice_date = COALESCE((p_invoice->>'invoice_date')::date, invoice_date),
      due_date = (p_invoice->>'due_date')::date,
      purchase_order_ref = p_invoice->>'purchase_order_ref',
      header_notes = p_invoice->>'header_notes',
      footer_notes = p_invoice->>'footer_notes',
      updated_at = now()
    WHERE id = v_invoice_id AND status IN ('draft', 'unposted');
  END IF;

  -- Block item mutation on non-editable invoices
  IF NOT v_is_new THEN
    IF NOT EXISTS (
      SELECT 1 FROM invoices WHERE id = v_invoice_id AND status IN ('draft', 'unposted')
    ) THEN
      RETURN v_invoice_id;
    END IF;
  END IF;

  DELETE FROM invoice_items WHERE invoice_id = v_invoice_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty := COALESCE((v_item->>'quantity')::numeric, 0);
    IF v_qty <= 0 THEN
      RAISE EXCEPTION 'Invoice line item quantity must be greater than zero';
    END IF;

    v_unit_price := COALESCE((v_item->>'unit_price_cents')::bigint, 0);
    v_extended := ROUND(v_qty * v_unit_price)::bigint;

    v_cost_cents := COALESCE((v_item->>'cost_cents')::bigint, 0);
    IF (v_item->>'product_id') IS NOT NULL THEN
      SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid;
      IF FOUND AND v_product.current_cost IS NOT NULL THEN
        v_cost_cents := (v_product.current_cost * 100)::bigint;
      END IF;
    END IF;

    INSERT INTO invoice_items (
      invoice_id, product_id, description, quantity,
      unit_price_cents, extended_cents, cost_cents,
      sort_order, rate_per_acre, acres, unit_size, notes
    ) VALUES (
      v_invoice_id,
      (v_item->>'product_id')::uuid,
      COALESCE(v_item->>'description', ''),
      v_qty,
      v_unit_price,
      v_extended,
      v_cost_cents,
      COALESCE((v_item->>'sort_order')::int, 0),
      (v_item->>'rate_per_acre')::numeric,
      (v_item->>'acres')::numeric,
      v_item->>'unit_size',
      v_item->>'notes'
    );
    v_total_cents := v_total_cents + v_extended;
  END LOOP;

  UPDATE invoices SET total_amount_cents = v_total_cents, updated_at = now()
  WHERE id = v_invoice_id AND status IN ('draft', 'unposted');

  IF v_is_new THEN
    INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
    VALUES ('invoice_created',
      'Invoice ' || (SELECT invoice_number FROM invoices WHERE id = v_invoice_id) || ' created',
      v_actor, 'invoice', v_invoice_id,
      (p_invoice->>'customer_id')::uuid
    );
  END IF;

  RETURN v_invoice_id;
END;
$$;

GRANT EXECUTE ON FUNCTION save_invoice(jsonb, jsonb, text) TO authenticated;


-- =============================================================================
-- 2. create_invoice_from_order — role gate + duplicate-invoice guard
-- =============================================================================

CREATE OR REPLACE FUNCTION create_invoice_from_order(
  p_order_id        uuid,
  p_salesman_id     uuid DEFAULT NULL,
  p_invoice_type    text DEFAULT 'chemical_sale',
  p_idempotency_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor          uuid := auth.uid();
  v_order          record;
  v_invoice_id     uuid;
  v_item           record;
  v_total_cents    bigint := 0;
  v_existing       jsonb;
  v_existing_count int;
BEGIN
  -- ── Phase 10 #1: auth gate (role check) ─────────────────────────────────
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to create invoices from orders';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'create_invoice_from_order');
    IF v_existing IS NOT NULL THEN RETURN (v_existing->>'invoice_id')::uuid; END IF;
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found: %', p_order_id;
  END IF;

  -- ── Phase 10 #2 (Sprint B): reject duplicate active invoices ────────────
  -- Prevents the "click Create Invoice twice" overbilling bug. An existing
  -- invoice in any non-cancelled/non-voided status counts as active.
  SELECT COUNT(*) INTO v_existing_count
    FROM invoices
   WHERE order_id = p_order_id
     AND status NOT IN ('voided', 'cancelled');
  IF v_existing_count > 0 THEN
    RAISE EXCEPTION 'Active invoice already exists for order % (% existing invoice(s)). Void or cancel the existing invoice first if you need to recreate.', v_order.order_number, v_existing_count;
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
$$;

GRANT EXECUTE ON FUNCTION create_invoice_from_order(uuid, uuid, text, text) TO authenticated;


-- =============================================================================
-- 3. Verification
-- =============================================================================

DO $$
DECLARE c1 int; c2 int;
BEGIN
  SELECT count(*) INTO c1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='save_invoice';
  SELECT count(*) INTO c2 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='create_invoice_from_order';
  IF c1 != 1 OR c2 != 1 THEN
    RAISE EXCEPTION 'VERIFICATION FAILED: overload counts save_invoice=%, create_invoice_from_order=%', c1, c2;
  END IF;
  RAISE NOTICE 'Phase 10 verified';
END $$;
