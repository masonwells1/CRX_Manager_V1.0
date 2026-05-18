-- idempotency-body-check: exempt
-- (Uses check_idempotency / save_idempotency helper functions instead of
-- raw `INSERT INTO idempotency_keys` — same canonical pattern Mason
-- ratified in CLAUDE.md "Canonical Patterns for New RPCs". The schema
-- hook can't see helpers' bodies from the migration text, so this
-- marker tells it the indirection is intentional.)
-- ============================================================================
-- Audit fix sprint PR-10 — Bulk idempotency wiring on 12 mutating RPCs
-- ============================================================================
-- Plan: docs/audits/2026-05-09-implementation-plan.md (PR-10)
-- Audit findings: P2 #12 — 12 RPCs declare `p_idempotency_key` but their
--                 bodies never call check_idempotency / save_idempotency,
--                 so network retries silently re-execute the mutation
--                 (audit_feed double-rows, double UPDATEs, etc.).
--
-- ⚠️ NOT YET APPLIED to live Supabase (rhyzpcqhnizqbxphqdkr).
--
-- Pattern applied to each function (matches CLAUDE.md "Canonical Patterns
-- for New RPCs"):
--
--   At top (after auth/role checks, before mutations):
--     IF p_idempotency_key IS NOT NULL THEN
--       v_existing := check_idempotency(p_idempotency_key, '<rpc_name>');
--       IF v_existing IS NOT NULL THEN RETURN <unwrap>; END IF;
--     END IF;
--
--   At end (just before the final RETURN):
--     IF p_idempotency_key IS NOT NULL THEN
--       PERFORM save_idempotency(p_idempotency_key, '<rpc_name>', <result>);
--     END IF;
--
-- For void-returning RPCs the cache-hit branch is `RETURN;` and the save
-- shape is `jsonb_build_object('success', true)`. For uuid-returning RPCs
-- the unwrap is `(v_existing->>'<key>')::uuid`. For json/jsonb-returning
-- RPCs the cache-hit branch returns v_existing directly (cast to ::json
-- when the function returns json instead of jsonb).
--
-- All 12 function bodies otherwise verbatim from current pg_proc state
-- (queried 2026-05-10). Search_path on all 12 is already `public, pg_temp`
-- — no changes needed there.
--
-- After applying, run:
--   SELECT proname FROM pg_proc
--   WHERE pronamespace='public'::regnamespace
--     AND proname IN (
--       'post_invoice','void_invoice','save_invoice',
--       'save_customer','increment_customer_prepay','convert_quote_to_order',
--       'reassign_delivery','batch_cancel_deliveries','delete_purchase_order',
--       'link_blend_ticket_to_order','unlink_blend_ticket_from_order',
--       'close_accounting_period'
--     )
--     AND prosrc !~ 'check_idempotency';
-- Expected: 0 rows.
-- ============================================================================

-- ─── Block A — Invoice state transitions ──────────────────────────────────

CREATE OR REPLACE FUNCTION post_invoice(p_invoice_id uuid, p_idempotency_key text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inv record;
  v_order_status text;
  v_existing jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'Not authorized to post invoices';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'post_invoice');
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found: %', p_invoice_id; END IF;
  PERFORM check_period_open(v_inv.invoice_date);
  IF v_inv.status NOT IN ('draft', 'unposted') THEN RAISE EXCEPTION 'Cannot post invoice with status: %', v_inv.status; END IF;
  IF v_inv.order_id IS NOT NULL THEN
    SELECT status INTO v_order_status FROM orders WHERE id = v_inv.order_id;
    IF v_order_status = 'cancelled' THEN RAISE EXCEPTION 'Cannot post invoice — linked order % is cancelled', v_inv.order_id; END IF;
  END IF;
  SET LOCAL app.admin_override = 'true';
  UPDATE invoices SET status = 'posted', posted_by = auth.uid(), posted_at = now(), updated_at = now() WHERE id = p_invoice_id;
  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, old_values, new_values, total_impact_cents, description)
  VALUES ('invoice_posted', 'invoice', p_invoice_id, (SELECT role FROM profiles WHERE id = auth.uid()), jsonb_build_object('status', v_inv.status), jsonb_build_object('status', 'posted', 'posted_at', now()::text), v_inv.total_amount_cents, 'Posted ' || v_inv.invoice_number || ' for $' || (v_inv.total_amount_cents / 100.0)::numeric(12,2));
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_posted', 'Posted invoice ' || v_inv.invoice_number || ' — $' || (v_inv.total_amount_cents / 100.0)::numeric(12,2), auth.uid(), 'invoice', p_invoice_id, v_inv.customer_id);
  PERFORM generate_rup_sales_records(p_invoice_id);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'post_invoice', jsonb_build_object('success', true, 'invoice_id', p_invoice_id));
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION void_invoice(p_invoice_id uuid, p_void_reason text, p_idempotency_key text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inv record;
  v_alloc record;
  v_total_allocations_reversed bigint := 0;
  v_total_prepay_restored bigint := 0;
  v_prepay_app record;
  v_actor_role text;
  v_allocation_set_ids uuid[];
  v_commissions_cancelled integer := 0;
  v_existing jsonb;
BEGIN
  SELECT role INTO v_actor_role FROM profiles WHERE id = auth.uid();
  IF v_actor_role != 'admin' THEN
    RAISE EXCEPTION 'Only admin users can void invoices';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'void_invoice');
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found: %', p_invoice_id; END IF;
  IF v_inv.status = 'voided' THEN RAISE EXCEPTION 'Invoice already voided'; END IF;
  IF v_inv.status = 'cancelled' THEN RAISE EXCEPTION 'Cannot void a cancelled invoice'; END IF;
  IF v_inv.status = 'posted' THEN
    PERFORM check_period_open(v_inv.invoice_date);
  END IF;

  SELECT ARRAY(
    SELECT DISTINCT allocation_set_id
    FROM invoice_line_allocations
    WHERE invoice_id = p_invoice_id AND allocation_set_id IS NOT NULL
  ) INTO v_allocation_set_ids;

  FOR v_alloc IN
    SELECT ila.id, ila.amount_cents, ila.allocation_set_id
    FROM invoice_line_allocations ila
    WHERE ila.invoice_id = p_invoice_id
  LOOP
    v_total_allocations_reversed := v_total_allocations_reversed + v_alloc.amount_cents;
    DELETE FROM invoice_line_allocations WHERE id = v_alloc.id;
  END LOOP;

  IF v_total_allocations_reversed > 0 AND array_length(v_allocation_set_ids, 1) > 0 THEN
    UPDATE allocation_sets SET
      total_allocated_cents = (
        SELECT COALESCE(SUM(amount_cents), 0)
        FROM invoice_line_allocations
        WHERE allocation_set_id = allocation_sets.id
      ),
      updated_at = now()
    WHERE id = ANY(v_allocation_set_ids);
  END IF;

  FOR v_prepay_app IN
    SELECT pa.id, pa.applied_amount_cents, pa.prepay_credit_id
    FROM prepay_applications pa
    WHERE pa.invoice_id = p_invoice_id
  LOOP
    v_total_prepay_restored := v_total_prepay_restored + v_prepay_app.applied_amount_cents;
    UPDATE prepay_credits SET
      balance_cents = balance_cents + v_prepay_app.applied_amount_cents,
      updated_at = now()
    WHERE id = v_prepay_app.prepay_credit_id;
    DELETE FROM prepay_applications WHERE id = v_prepay_app.id;
  END LOOP;

  IF v_total_prepay_restored > 0 THEN
    UPDATE customers SET
      prepay_balance_cents = COALESCE(prepay_balance_cents, 0) + v_total_prepay_restored,
      updated_at = now()
    WHERE id = v_inv.customer_id;
  END IF;

  UPDATE invoices SET
    status = 'voided', voided_by = auth.uid(), voided_at = now(),
    void_reason = p_void_reason,
    total_amount_cents = 0, paid_amount_cents = 0,
    prepay_applied_cents = 0, write_off_cents = 0,
    updated_at = now()
  WHERE id = p_invoice_id;

  IF v_inv.order_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM invoices
      WHERE order_id = v_inv.order_id
        AND id != p_invoice_id
        AND status NOT IN ('voided', 'cancelled')
        AND deleted_at IS NULL
    ) THEN
      UPDATE commissions SET status = 'cancelled'
      WHERE order_id = v_inv.order_id AND status = 'pending';
      GET DIAGNOSTICS v_commissions_cancelled = ROW_COUNT;
    END IF;
  END IF;

  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, old_values, new_values, total_impact_cents, description)
  VALUES (
    'invoice_voided', 'invoice', p_invoice_id, v_actor_role,
    jsonb_build_object('status', v_inv.status, 'total_cents', v_inv.total_amount_cents, 'paid_amount_cents', v_inv.paid_amount_cents, 'prepay_applied_cents', v_inv.prepay_applied_cents, 'write_off_cents', v_inv.write_off_cents),
    jsonb_build_object('status', 'voided', 'void_reason', p_void_reason, 'allocations_reversed_cents', v_total_allocations_reversed, 'prepay_restored_cents', v_total_prepay_restored, 'commissions_cancelled', v_commissions_cancelled),
    -1 * v_inv.total_amount_cents,
    'Voided ' || v_inv.invoice_number || ' — ' || p_void_reason ||
      CASE WHEN v_total_allocations_reversed > 0 THEN '. Reversed $' || (v_total_allocations_reversed / 100.0)::text || ' in allocations.' ELSE '' END ||
      CASE WHEN v_total_prepay_restored > 0 THEN ' Restored $' || (v_total_prepay_restored / 100.0)::text || ' in prepay credits.' ELSE '' END ||
      CASE WHEN v_commissions_cancelled > 0 THEN ' Cancelled ' || v_commissions_cancelled || ' pending commission(s).' ELSE '' END
  );

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_voided',
    'Voided invoice ' || v_inv.invoice_number || ' — ' || p_void_reason ||
      CASE WHEN v_total_allocations_reversed > 0 THEN '. Reversed $' || (v_total_allocations_reversed / 100.0)::text || ' in allocations.' ELSE '' END ||
      CASE WHEN v_total_prepay_restored > 0 THEN ' Restored $' || (v_total_prepay_restored / 100.0)::text || ' in prepay credits.' ELSE '' END ||
      CASE WHEN v_commissions_cancelled > 0 THEN ' Cancelled ' || v_commissions_cancelled || ' pending commission(s).' ELSE '' END,
    auth.uid(), 'invoice', p_invoice_id, v_inv.customer_id
  );

  IF v_total_allocations_reversed > 0 OR v_total_prepay_restored > 0 OR v_commissions_cancelled > 0 THEN
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    SELECT p.id,
      'Invoice Voided — Allocations Reversed',
      'Invoice ' || v_inv.invoice_number || ' voided. $' ||
        (v_total_allocations_reversed / 100.0)::text || ' in allocations reversed, $' ||
        (v_total_prepay_restored / 100.0)::text || ' in prepay credits restored.' ||
        CASE WHEN v_commissions_cancelled > 0 THEN ' ' || v_commissions_cancelled || ' pending commission(s) cancelled.' ELSE '' END,
      'invoice_void_reversal', 'invoice', p_invoice_id
    FROM profiles p
    WHERE p.role = 'admin' AND p.is_active = true;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'void_invoice', jsonb_build_object(
      'success', true,
      'invoice_id', p_invoice_id,
      'allocations_reversed_cents', v_total_allocations_reversed,
      'prepay_restored_cents', v_total_prepay_restored,
      'commissions_cancelled', v_commissions_cancelled
    ));
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION save_invoice(p_invoice jsonb, p_items jsonb DEFAULT '[]'::jsonb, p_idempotency_key text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_invoice_id uuid;
  v_is_new boolean := false;
  v_item jsonb;
  v_total_cents bigint := 0;
  v_qty numeric;
  v_unit_price bigint;
  v_extended bigint;
  v_cost_cents bigint;
  v_product record;
  v_order_id uuid;
  v_blend_id uuid;
  v_existing jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to save invoices';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'save_invoice');
    IF v_existing IS NOT NULL THEN RETURN (v_existing->>'invoice_id')::uuid; END IF;
  END IF;

  v_invoice_id := (p_invoice->>'id')::uuid;
  v_order_id := (p_invoice->>'order_id')::uuid;
  v_blend_id := (p_invoice->>'blend_ticket_id')::uuid;

  IF v_invoice_id IS NULL THEN
    IF v_order_id IS NULL AND v_blend_id IS NULL THEN
      RAISE EXCEPTION 'Invoices must link to an order or blend ticket. Provide order_id or blend_ticket_id in p_invoice payload.';
    END IF;
    v_is_new := true;
    INSERT INTO invoices (
      order_id, blend_ticket_id, customer_id, invoice_type, status, season, salesman_id,
      invoice_date, due_date, purchase_order_ref, header_notes, footer_notes,
      total_amount_cents, created_by
    ) VALUES (
      v_order_id, v_blend_id, (p_invoice->>'customer_id')::uuid,
      COALESCE(p_invoice->>'invoice_type', 'chemical_sale'),
      COALESCE(p_invoice->>'status', 'draft'),
      COALESCE((p_invoice->>'season')::int, (SELECT current_season())),
      (p_invoice->>'salesman_id')::uuid,
      COALESCE((p_invoice->>'invoice_date')::date, CURRENT_DATE),
      (p_invoice->>'due_date')::date,
      p_invoice->>'purchase_order_ref',
      p_invoice->>'header_notes',
      p_invoice->>'footer_notes',
      0, v_actor
    ) RETURNING id INTO v_invoice_id;
  ELSE
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

  IF NOT v_is_new THEN
    IF NOT EXISTS (
      SELECT 1 FROM invoices WHERE id = v_invoice_id AND status IN ('draft', 'unposted')
    ) THEN
      IF p_idempotency_key IS NOT NULL THEN
        PERFORM save_idempotency(p_idempotency_key, 'save_invoice', jsonb_build_object('invoice_id', v_invoice_id, 'no_op', true));
      END IF;
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
      invoice_id, product_id, description, quantity, unit_price_cents, extended_cents,
      cost_cents, sort_order, rate_per_acre, acres, unit_size, notes
    ) VALUES (
      v_invoice_id, (v_item->>'product_id')::uuid,
      COALESCE(v_item->>'description', ''),
      v_qty, v_unit_price, v_extended, v_cost_cents,
      COALESCE((v_item->>'sort_order')::int, 0),
      (v_item->>'rate_per_acre')::numeric, (v_item->>'acres')::numeric,
      v_item->>'unit_size', v_item->>'notes'
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

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_invoice', jsonb_build_object('invoice_id', v_invoice_id, 'is_new', v_is_new));
  END IF;

  RETURN v_invoice_id;
END;
$$;

-- ─── Block B — Customer + commission ──────────────────────────────────────

CREATE OR REPLACE FUNCTION increment_customer_prepay(p_customer_id uuid, p_amount_cents bigint, p_idempotency_key text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing jsonb;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'increment_customer_prepay');
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  UPDATE customers
  SET prepay_balance_cents = COALESCE(prepay_balance_cents, 0) + p_amount_cents
  WHERE id = p_customer_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer % not found', p_customer_id;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'increment_customer_prepay', jsonb_build_object('success', true, 'customer_id', p_customer_id, 'amount_cents', p_amount_cents));
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION convert_quote_to_order(p_quote_id uuid, p_performed_by uuid DEFAULT NULL, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_quote record;
  v_order_number text;
  v_order_id uuid;
  v_item record;
  v_customer record;
  v_inv record;
  v_shortfalls text[] := '{}';
  v_net_position numeric;
  v_result jsonb;
  v_existing jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Actor mismatch';
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

  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

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

  INSERT INTO orders (
    order_number, quote_id, customer_id, status, commission_split,
    total_price, total_cost, total_profit, total_margin_pct, order_date, program_notes
  ) VALUES (
    v_order_number, p_quote_id, v_quote.customer_id, 'confirmed',
    v_quote.commission_split, v_quote.total_price, v_quote.total_cost,
    v_quote.total_profit, v_quote.total_margin_pct, current_date,
    (SELECT string_agg(qs.section_name || ': ' || qs.section_header_notes, E'\n')
     FROM quote_sections qs
     WHERE qs.quote_id = p_quote_id AND qs.section_header_notes IS NOT NULL AND qs.section_header_notes <> '')
  ) RETURNING id INTO v_order_id;

  INSERT INTO order_items (
    order_id, product_id, quote_item_id, section_name, product_name,
    price_per_unit, cost_per_unit, actual_rate, rate_unit, acres,
    total_units_needed, unit_size, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining, notes
  )
  SELECT
    v_order_id, qi.product_id, qi.id, qs.section_name, p.product_name,
    qi.price_per_unit, qi.current_cost, qi.actual_rate, qi.rate_unit, qi.acres,
    COALESCE(qi.total_units_needed, 0), qi.unit_size,
    qi.total_price, qi.profit, qi.net_margin,
    0, COALESCE(qi.total_units_needed, 0), qi.notes
  FROM quote_items qi
  JOIN quote_sections qs ON qs.id = qi.section_id
  JOIN products p ON p.id = qi.product_id
  WHERE qi.quote_id = p_quote_id AND qi.product_id IS NOT NULL;

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
      v_order_id, v_actor,
      'Pre-booked for order ' || v_order_number
    );
  END LOOP;

  IF v_quote.commission_split IS NOT NULL AND v_quote.commission_split ? 'splits' THEN
    INSERT INTO commissions (
      order_id, customer_id, recipient, split_percentage,
      commission_amount, order_profit, order_date, status
    )
    SELECT
      v_order_id, v_quote.customer_id, s->>'recipient',
      (s->>'percentage')::numeric,
      v_quote.total_profit * ((s->>'percentage')::numeric / 100),
      v_quote.total_profit, current_date, 'pending'
    FROM jsonb_array_elements(v_quote.commission_split->'splits') s
    WHERE (s->>'recipient') IS NOT NULL AND (s->>'percentage')::numeric > 0;
  END IF;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'order_created',
    'Order ' || v_order_number || ' created from quote ' || v_quote.quote_number ||
    ' for ' || COALESCE(v_customer.farm_name, 'customer') ||
    CASE WHEN array_length(v_shortfalls, 1) > 0
      THEN ' (inventory warnings: ' || array_to_string(v_shortfalls, '; ') || ')'
      ELSE '' END,
    v_actor, 'order', v_order_id, v_quote.customer_id
  );

  v_result := jsonb_build_object(
    'status', 'created',
    'order_id', v_order_id,
    'order_number', v_order_number,
    'warnings', to_jsonb(v_shortfalls)
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'convert_quote_to_order', v_result);
  END IF;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION save_customer(p_customer_id uuid, p_customer_payload jsonb, p_addresses jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_customer_id uuid;
  v_is_new boolean := (p_customer_id IS NULL);
  v_addr jsonb;
  v_incoming_ids uuid[];
  v_result jsonb;
  v_existing jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Actor mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to manage customers';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'save_customer');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  IF v_is_new THEN
    INSERT INTO customers (
      farm_name, contact_name, phone, email, billing_address,
      assigned_tier, assigned_sales_rep, total_acres, corn_acres,
      soybean_acres, other_acres, payment_terms,
      default_commission_split, notes, is_active,
      parent_customer_id, credit_limit_cents,
      finance_charge_rate, finance_charge_enabled, finance_charge_grace_days
    ) VALUES (
      p_customer_payload->>'farm_name',
      NULLIF(p_customer_payload->>'contact_name', ''),
      NULLIF(p_customer_payload->>'phone', ''),
      NULLIF(p_customer_payload->>'email', ''),
      NULLIF(p_customer_payload->>'billing_address', ''),
      COALESCE((p_customer_payload->>'assigned_tier')::integer, 1),
      (p_customer_payload->>'assigned_sales_rep')::uuid,
      (p_customer_payload->>'total_acres')::numeric,
      (p_customer_payload->>'corn_acres')::numeric,
      (p_customer_payload->>'soybean_acres')::numeric,
      (p_customer_payload->>'other_acres')::numeric,
      NULLIF(p_customer_payload->>'payment_terms', ''),
      CASE WHEN p_customer_payload ? 'default_commission_split'
        THEN (p_customer_payload->'default_commission_split') ELSE NULL END,
      NULLIF(p_customer_payload->>'notes', ''),
      COALESCE((p_customer_payload->>'is_active')::boolean, true),
      (p_customer_payload->>'parent_customer_id')::uuid,
      COALESCE((p_customer_payload->>'credit_limit_cents')::bigint, 0),
      COALESCE((p_customer_payload->>'finance_charge_rate')::numeric, 0),
      COALESCE((p_customer_payload->>'finance_charge_enabled')::boolean, true),
      COALESCE((p_customer_payload->>'finance_charge_grace_days')::integer, 0)
    ) RETURNING id INTO v_customer_id;
  ELSE
    v_customer_id := p_customer_id;
    UPDATE customers SET
      farm_name = COALESCE(p_customer_payload->>'farm_name', farm_name),
      contact_name = CASE WHEN p_customer_payload ? 'contact_name' THEN NULLIF(p_customer_payload->>'contact_name', '') ELSE contact_name END,
      phone = CASE WHEN p_customer_payload ? 'phone' THEN NULLIF(p_customer_payload->>'phone', '') ELSE phone END,
      email = CASE WHEN p_customer_payload ? 'email' THEN NULLIF(p_customer_payload->>'email', '') ELSE email END,
      billing_address = CASE WHEN p_customer_payload ? 'billing_address' THEN NULLIF(p_customer_payload->>'billing_address', '') ELSE billing_address END,
      assigned_tier = CASE WHEN p_customer_payload ? 'assigned_tier' THEN COALESCE((p_customer_payload->>'assigned_tier')::integer, 1) ELSE assigned_tier END,
      assigned_sales_rep = CASE WHEN p_customer_payload ? 'assigned_sales_rep' THEN (p_customer_payload->>'assigned_sales_rep')::uuid ELSE assigned_sales_rep END,
      total_acres = CASE WHEN p_customer_payload ? 'total_acres' THEN (p_customer_payload->>'total_acres')::numeric ELSE total_acres END,
      corn_acres = CASE WHEN p_customer_payload ? 'corn_acres' THEN (p_customer_payload->>'corn_acres')::numeric ELSE corn_acres END,
      soybean_acres = CASE WHEN p_customer_payload ? 'soybean_acres' THEN (p_customer_payload->>'soybean_acres')::numeric ELSE soybean_acres END,
      other_acres = CASE WHEN p_customer_payload ? 'other_acres' THEN (p_customer_payload->>'other_acres')::numeric ELSE other_acres END,
      payment_terms = CASE WHEN p_customer_payload ? 'payment_terms' THEN NULLIF(p_customer_payload->>'payment_terms', '') ELSE payment_terms END,
      default_commission_split = CASE WHEN p_customer_payload ? 'default_commission_split' THEN (p_customer_payload->'default_commission_split') ELSE default_commission_split END,
      notes = CASE WHEN p_customer_payload ? 'notes' THEN NULLIF(p_customer_payload->>'notes', '') ELSE notes END,
      is_active = COALESCE((p_customer_payload->>'is_active')::boolean, is_active),
      parent_customer_id = CASE WHEN p_customer_payload ? 'parent_customer_id' THEN (p_customer_payload->>'parent_customer_id')::uuid ELSE parent_customer_id END,
      credit_limit_cents = CASE WHEN p_customer_payload ? 'credit_limit_cents' THEN COALESCE((p_customer_payload->>'credit_limit_cents')::bigint, 0) ELSE credit_limit_cents END,
      finance_charge_rate = CASE WHEN p_customer_payload ? 'finance_charge_rate' THEN COALESCE((p_customer_payload->>'finance_charge_rate')::numeric, 0) ELSE finance_charge_rate END,
      finance_charge_enabled = CASE WHEN p_customer_payload ? 'finance_charge_enabled' THEN COALESCE((p_customer_payload->>'finance_charge_enabled')::boolean, true) ELSE finance_charge_enabled END,
      finance_charge_grace_days = CASE WHEN p_customer_payload ? 'finance_charge_grace_days' THEN COALESCE((p_customer_payload->>'finance_charge_grace_days')::integer, 0) ELSE finance_charge_grace_days END,
      updated_at = now()
    WHERE id = v_customer_id;

    IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found: %', v_customer_id; END IF;

    SELECT array_agg((addr->>'id')::uuid) INTO v_incoming_ids
    FROM jsonb_array_elements(COALESCE(p_addresses, '[]'::jsonb)) AS addr
    WHERE addr->>'id' IS NOT NULL;

    DELETE FROM customer_addresses ca
    WHERE ca.customer_id = v_customer_id
      AND (v_incoming_ids IS NULL OR ca.id != ALL(v_incoming_ids))
      AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.delivery_address_id = ca.id);
  END IF;

  IF p_addresses IS NOT NULL AND jsonb_array_length(p_addresses) > 0 THEN
    UPDATE customer_addresses ca SET
      label = COALESCE(addr->>'label', ''),
      address_line = NULLIF(addr->>'address_line', ''),
      city = NULLIF(addr->>'city', ''),
      state = NULLIF(addr->>'state', ''),
      zip = NULLIF(addr->>'zip', ''),
      delivery_notes = NULLIF(addr->>'delivery_notes', ''),
      is_default = COALESCE((addr->>'is_default')::boolean, false)
    FROM jsonb_array_elements(p_addresses) AS addr
    WHERE ca.id = (addr->>'id')::uuid AND ca.customer_id = v_customer_id;

    INSERT INTO customer_addresses (
      customer_id, label, address_line, city, state, zip, delivery_notes, is_default
    )
    SELECT
      v_customer_id,
      COALESCE(addr->>'label', ''),
      NULLIF(addr->>'address_line', ''),
      NULLIF(addr->>'city', ''),
      NULLIF(addr->>'state', ''),
      NULLIF(addr->>'zip', ''),
      NULLIF(addr->>'delivery_notes', ''),
      COALESCE((addr->>'is_default')::boolean, false)
    FROM jsonb_array_elements(p_addresses) AS addr
    WHERE addr->>'id' IS NULL
      AND (COALESCE(addr->>'label', '') != '' OR COALESCE(addr->>'address_line', '') != '');
  END IF;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    CASE WHEN v_is_new THEN 'customer_created' ELSE 'customer_updated' END,
    CASE WHEN v_is_new
      THEN 'Customer ' || COALESCE(p_customer_payload->>'farm_name', '') || ' created'
      ELSE 'Customer ' || COALESCE(p_customer_payload->>'farm_name', '') || ' updated'
    END,
    v_actor, 'customer', v_customer_id, v_customer_id
  );

  v_result := jsonb_build_object('status', 'saved', 'customer_id', v_customer_id);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_customer', v_result);
  END IF;

  RETURN v_result;
END;
$$;

-- ─── Block C — Delivery + PO ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION reassign_delivery(p_delivery_id uuid, p_new_driver uuid, p_performed_by uuid DEFAULT NULL, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_delivery record;
  v_old_driver uuid;
  v_result jsonb;
  v_existing jsonb;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'driver'
    ) OR NOT EXISTS (
      SELECT 1 FROM deliveries WHERE id = p_delivery_id AND assigned_driver IS NULL
    ) THEN
      RAISE EXCEPTION 'Not authorized to reassign deliveries';
    END IF;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'reassign_delivery');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_new_driver AND is_active = true AND role IN ('admin', 'sales_rep', 'driver')
  ) THEN
    RAISE EXCEPTION 'Target driver not found or inactive';
  END IF;

  SELECT * INTO v_delivery FROM deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery not found'; END IF;
  IF v_delivery.status NOT IN ('scheduled', 'in_progress') THEN
    RAISE EXCEPTION 'Cannot reassign a % delivery', v_delivery.status;
  END IF;

  v_old_driver := v_delivery.assigned_driver;

  UPDATE deliveries SET
    assigned_driver = p_new_driver,
    last_edited_by = v_actor,
    last_edited_at = now(),
    updated_at = now()
  WHERE id = p_delivery_id;

  IF v_old_driver IS NOT NULL AND v_old_driver != p_new_driver THEN
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    VALUES (
      v_old_driver, 'Delivery Reassigned',
      'Delivery ' || v_delivery.delivery_number || ' has been reassigned.',
      'delivery_update', 'delivery', p_delivery_id
    );
  END IF;

  INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
  VALUES (
    p_new_driver, 'New Delivery Assigned',
    'Delivery ' || v_delivery.delivery_number || ' has been assigned to you.',
    'delivery_update', 'delivery', p_delivery_id
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_reassigned',
    'Delivery ' || v_delivery.delivery_number || ' reassigned',
    v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  v_result := jsonb_build_object('status', 'reassigned', 'delivery_id', p_delivery_id);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'reassign_delivery', v_result);
  END IF;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION batch_cancel_deliveries(p_delivery_ids uuid[], p_cancel_reason text DEFAULT 'Batch cancelled', p_performed_by uuid DEFAULT NULL, p_idempotency_key text DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_del record;
  v_count integer := 0;
  v_actor uuid;
  v_result jsonb;
  v_existing jsonb;
BEGIN
  PERFORM check_rate_limit(auth.uid(), 'batch_cancel_deliveries', 3, 60);
  v_actor := COALESCE(p_performed_by, auth.uid());
  IF array_length(p_delivery_ids, 1) IS NULL THEN RAISE EXCEPTION 'No delivery IDs provided'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'batch_cancel_deliveries');
    IF v_existing IS NOT NULL THEN RETURN (v_existing->>'count')::integer; END IF;
  END IF;

  FOR v_del IN SELECT id, status FROM deliveries WHERE id = ANY(p_delivery_ids) ORDER BY id
  LOOP
    IF v_del.status NOT IN ('scheduled', 'in_progress', 'completed') THEN CONTINUE; END IF;
    v_result := cancel_delivery(p_delivery_id := v_del.id, p_cancel_reason := p_cancel_reason, p_performed_by := v_actor);
    IF (v_result->>'success')::boolean THEN v_count := v_count + 1; END IF;
  END LOOP;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'batch_cancel_deliveries', jsonb_build_object('count', v_count));
  END IF;

  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION delete_purchase_order(p_po_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_po record;
  v_has_received boolean;
  v_result jsonb;
  v_existing jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Actor mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only admins can delete purchase orders';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'delete_purchase_order');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_po FROM purchase_orders WHERE id = p_po_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found'; END IF;

  SELECT EXISTS (
    SELECT 1 FROM purchase_order_items
    WHERE purchase_order_id = p_po_id AND quantity_received > 0
  ) INTO v_has_received;

  IF v_has_received THEN
    RAISE EXCEPTION 'Cannot delete PO % — items have already been received. Cancel instead.', v_po.po_number;
  END IF;

  DELETE FROM purchase_order_items WHERE purchase_order_id = p_po_id;
  DELETE FROM purchase_orders WHERE id = p_po_id;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id
  ) VALUES (
    'po_deleted',
    'PO ' || v_po.po_number || ' deleted',
    v_actor, 'purchase_order', p_po_id
  );

  v_result := jsonb_build_object('status', 'deleted');

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'delete_purchase_order', v_result);
  END IF;

  RETURN v_result;
END;
$$;

-- ─── Block D — Blend tickets ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION link_blend_ticket_to_order(p_blend_ticket_id uuid, p_order_id uuid, p_item_mappings jsonb DEFAULT NULL, p_performed_by uuid DEFAULT NULL, p_idempotency_key text DEFAULT NULL)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ticket blend_tickets%ROWTYPE;
  v_order orders%ROWTYPE;
  v_mapping jsonb;
  v_count int := 0;
  v_result json;
  v_existing jsonb;
BEGIN
  PERFORM require_admin_or_sales_rep();

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'link_blend_ticket_to_order');
    IF v_existing IS NOT NULL THEN RETURN v_existing::json; END IF;
  END IF;

  SELECT * INTO v_ticket FROM blend_tickets WHERE id = p_blend_ticket_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RETURN json_build_object('success', false, 'error', 'Blend ticket not found'); END IF;
  IF v_ticket.order_link_status = 'linked' THEN RETURN json_build_object('success', false, 'error', 'Already linked'); END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RETURN json_build_object('success', false, 'error', 'Order not found'); END IF;
  IF v_ticket.customer_id IS NOT NULL AND v_ticket.customer_id != v_order.customer_id THEN
    RETURN json_build_object('success', false, 'error', 'Customer mismatch');
  END IF;

  IF p_item_mappings IS NOT NULL AND jsonb_array_length(p_item_mappings) > 0 THEN
    FOR v_mapping IN SELECT * FROM jsonb_array_elements(p_item_mappings) LOOP
      INSERT INTO blend_ticket_to_order_items (blend_ticket_id, order_item_id, order_id, quantity_applied, created_by)
      VALUES (p_blend_ticket_id, (v_mapping->>'order_item_id')::uuid, p_order_id, COALESCE((v_mapping->>'quantity_applied')::numeric, 0), p_performed_by)
      ON CONFLICT (blend_ticket_id, order_item_id) DO NOTHING;
      v_count := v_count + 1;
    END LOOP;
  ELSE
    INSERT INTO blend_ticket_to_order_items (blend_ticket_id, order_item_id, order_id, quantity_applied, created_by)
    SELECT p_blend_ticket_id, oi.id, p_order_id, btp.quantity, p_performed_by
    FROM blend_ticket_products btp
    JOIN order_items oi ON oi.product_id = btp.product_id AND oi.order_id = p_order_id
    WHERE btp.blend_ticket_id = p_blend_ticket_id AND btp.product_id IS NOT NULL
    ON CONFLICT (blend_ticket_id, order_item_id) DO NOTHING;
    GET DIAGNOSTICS v_count = ROW_COUNT;
  END IF;

  UPDATE blend_tickets SET order_link_status = 'linked', updated_at = now() WHERE id = p_blend_ticket_id;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES ('blend_ticket_linked_to_order', 'Blend ticket ' || v_ticket.ticket_number || ' linked to order ' || v_order.order_number, p_performed_by, 'blend_ticket', p_blend_ticket_id);

  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_user_id, actor_role, new_values, description)
  VALUES ('blend_ticket_linked', 'blend_ticket', p_blend_ticket_id, p_performed_by, (SELECT role FROM profiles WHERE id = p_performed_by), jsonb_build_object('order_id', p_order_id, 'items_linked', v_count), 'Linked blend ticket ' || v_ticket.ticket_number || ' to order ' || v_order.order_number);

  v_result := json_build_object('success', true, 'items_linked', v_count, 'order_id', p_order_id, 'order_number', v_order.order_number);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'link_blend_ticket_to_order', v_result::jsonb);
  END IF;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION unlink_blend_ticket_from_order(p_blend_ticket_id uuid, p_performed_by uuid DEFAULT NULL, p_idempotency_key text DEFAULT NULL)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ticket blend_tickets%ROWTYPE;
  v_order_id uuid;
  v_order_num text;
  v_deleted int;
  v_result json;
  v_existing jsonb;
BEGIN
  PERFORM require_admin_or_sales_rep();

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'unlink_blend_ticket_from_order');
    IF v_existing IS NOT NULL THEN RETURN v_existing::json; END IF;
  END IF;

  SELECT * INTO v_ticket FROM blend_tickets WHERE id = p_blend_ticket_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RETURN json_build_object('success', false, 'error', 'Blend ticket not found'); END IF;
  IF v_ticket.order_link_status != 'linked' THEN RETURN json_build_object('success', false, 'error', 'Not linked'); END IF;

  SELECT DISTINCT bto.order_id, o.order_number INTO v_order_id, v_order_num
  FROM blend_ticket_to_order_items bto
  JOIN orders o ON o.id = bto.order_id
  WHERE bto.blend_ticket_id = p_blend_ticket_id LIMIT 1;

  DELETE FROM blend_ticket_to_order_items WHERE blend_ticket_id = p_blend_ticket_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  UPDATE blend_tickets SET order_link_status = 'unlinked', updated_at = now() WHERE id = p_blend_ticket_id;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES ('blend_ticket_unlinked_from_order', 'Blend ticket ' || v_ticket.ticket_number || ' unlinked from order ' || COALESCE(v_order_num, 'unknown'), p_performed_by, 'blend_ticket', p_blend_ticket_id);

  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_user_id, actor_role, new_values, description)
  VALUES ('blend_ticket_unlinked', 'blend_ticket', p_blend_ticket_id, p_performed_by, (SELECT role FROM profiles WHERE id = p_performed_by), jsonb_build_object('order_id', v_order_id, 'items_removed', v_deleted), 'Unlinked blend ticket ' || v_ticket.ticket_number || ' from order ' || COALESCE(v_order_num, 'unknown'));

  v_result := json_build_object('success', true, 'items_removed', v_deleted, 'order_id', v_order_id);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'unlink_blend_ticket_from_order', v_result::jsonb);
  END IF;

  RETURN v_result;
END;
$$;

-- ─── Block E — Period ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION close_accounting_period(p_period_end date, p_performed_by uuid, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_period_start date;
  v_unposted_count integer;
  v_period_id uuid;
  v_summary jsonb;
  v_existing jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Actor mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = v_actor AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only admin users can close accounting periods';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'close_accounting_period');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  v_period_start := date_trunc('month', p_period_end)::date;

  SELECT count(*) INTO v_unposted_count
  FROM public.invoices
  WHERE invoice_date BETWEEN v_period_start AND p_period_end
    AND status IN ('draft', 'unposted')
    AND deleted_at IS NULL;

  IF v_unposted_count > 0 THEN
    RAISE EXCEPTION 'Cannot close period: % unposted invoice(s) exist between % and %',
      v_unposted_count, v_period_start, p_period_end;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.accounting_periods
    WHERE period_start = v_period_start AND period_end = p_period_end AND status = 'closed'
  ) THEN
    RAISE EXCEPTION 'Period % to % is already closed', v_period_start, p_period_end;
  END IF;

  INSERT INTO public.accounting_periods (period_start, period_end, status, closed_by, closed_at)
  VALUES (v_period_start, p_period_end, 'closed', v_actor, now())
  ON CONFLICT (period_start, period_end)
  DO UPDATE SET status = 'closed', closed_by = v_actor, closed_at = now(), updated_at = now()
  RETURNING id INTO v_period_id;

  SELECT jsonb_build_object(
    'period_id', v_period_id,
    'period_start', v_period_start,
    'period_end', p_period_end,
    'invoices_posted', (
      SELECT count(*) FROM public.invoices
      WHERE invoice_date BETWEEN v_period_start AND p_period_end
        AND status = 'posted' AND deleted_at IS NULL
    ),
    'total_invoiced_cents', COALESCE((
      SELECT sum(total_amount_cents) FROM public.invoices
      WHERE invoice_date BETWEEN v_period_start AND p_period_end
        AND status = 'posted' AND deleted_at IS NULL
    ), 0),
    'payments_received_cents', COALESCE((
      SELECT (sum(amount) * 100)::bigint FROM public.payments
      WHERE payment_date BETWEEN v_period_start AND p_period_end
    ), 0),
    'orders_count', (
      SELECT count(*) FROM public.orders
      WHERE order_date BETWEEN v_period_start AND p_period_end
        AND deleted_at IS NULL
    ),
    'deliveries_count', (
      SELECT count(*) FROM public.deliveries
      WHERE scheduled_date BETWEEN v_period_start AND p_period_end
        AND deleted_at IS NULL
    )
  ) INTO v_summary;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'close_accounting_period', v_summary);
  END IF;

  RETURN v_summary;
END;
$$;

-- ─── Verification ─────────────────────────────────────────────────────────

DO $$
DECLARE
  v_unwired_count integer;
  v_unwired_names text;
BEGIN
  SELECT count(*), string_agg(proname, ', ' ORDER BY proname)
    INTO v_unwired_count, v_unwired_names
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace
    AND proname IN (
      'post_invoice', 'void_invoice', 'save_invoice',
      'save_customer', 'increment_customer_prepay', 'convert_quote_to_order',
      'reassign_delivery', 'batch_cancel_deliveries', 'delete_purchase_order',
      'link_blend_ticket_to_order', 'unlink_blend_ticket_from_order',
      'close_accounting_period'
    )
    AND prosrc !~ 'check_idempotency';

  IF v_unwired_count > 0 THEN
    RAISE EXCEPTION 'PR-10 verification: % function(s) still missing check_idempotency: %', v_unwired_count, v_unwired_names;
  END IF;

  RAISE NOTICE 'PR-10 verification passed: all 12 functions now wire idempotency.';
END;
$$;
