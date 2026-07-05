-- ============================================================================
-- A5 follow-up — create_order_from_blend_ticket: audit-consistency + actor gate
-- APPLIED LIVE 2026-07-05 (live version v20260705133836) on Mason's explicit OK.
-- ----------------------------------------------------------------------------
-- Re-emits create_order_from_blend_ticket (live now as v20260704161532, from
-- 20260704120000_a5_blend_ticket_unit_conversion.sql) with EXACTLY TWO surgical
-- changes; every other line is byte-identical to the current live definition
-- (proven by a whitespace/comment-insensitive diff of the two function bodies):
--
--   (a) AUDIT CONSISTENCY: the order line + inventory txn already use the CONVERTED
--       quantity (v_qty_conv), but the RPC linked the ticket with
--       link_blend_ticket_to_order(..., NULL, ...). That NULL/ELSE branch records
--       the RAW blend_ticket_products.quantity in
--       blend_ticket_to_order_items.quantity_applied — so for a unit-converted line
--       the audit row disagreed with the order + inventory. We now pass an explicit
--       p_item_mappings array carrying each order_item_id + its CONVERTED quantity,
--       so the audit/link row matches. Money and stock were already correct; this is
--       audit consistency only. When NO product line matches a catalog product the
--       array is empty ('[]'), which link treats identically to NULL (its guard is
--       `p_item_mappings IS NOT NULL AND jsonb_array_length(...) > 0`) — so behavior
--       is unchanged except for the recorded quantity on matched lines.
--
--   (b) ACTOR GATE: the RPC trusted caller-supplied p_performed_by with no check.
--       Its two siblings (create_invoice_from_blend_ticket,
--       create_application_record_from_blend_ticket) reject a forged actor up front.
--       We add the same gate at the very top of BEGIN — AUTH_REQUIRED when
--       unauthenticated, ACTOR_MISMATCH when p_performed_by IS DISTINCT FROM
--       auth.uid(), INSUFFICIENT_ROLE unless admin/sales — BEFORE any work or cache
--       read. (link_blend_ticket_to_order already rejects a forged actor at the very
--       end, so a forgery was caught + rolled back today; this moves the gate up
--       front for defense-in-depth, sibling consistency, and an earlier reject.)
--
-- BLAST RADIUS: blend_tickets / blend_ticket_products / blend_ticket_to_order_items
--   are EMPTY live (0/0/0 on 2026-07-04) — zero historical-data risk.
--
-- PROOF: see the loop ledger cycle-log entry. rls/drift/compliance reviewers +
--   Codex (uncommitted + --base main) all clean; post-apply sweeps show the fn
--   dropped OUT of ungated-secdef-mutators. Byte-exact apply-guard proof (queryHash
--   f772bbcf). Verified live via rolled-back [E2E] E2E (256 oz -> 2 gal in audit +
--   order + inventory; forged -> ACTOR_MISMATCH; no-auth -> AUTH_REQUIRED).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_order_from_blend_ticket(p_blend_ticket_id uuid, p_order_number text, p_order_date date DEFAULT CURRENT_DATE, p_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT auth.uid(), p_idempotency_key text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor       uuid := auth.uid();
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
  -- A5: quantity converted to the product's inventory unit + the unit label to store
  v_qty_conv    numeric;
  v_unit_out    text;
  -- A5-audit: per-order-item mappings (order_item_id + CONVERTED qty) so the
  -- link/audit row records the same quantity as the order line + inventory txn.
  v_mappings    jsonb := '[]'::jsonb;
BEGIN
  -- A5-actor: reject a forged actor / non-admin up front, mirroring the two sibling
  -- blend-ticket RPCs (create_invoice_/create_application_record_from_blend_ticket).
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: admin or sales role required to create orders from blend tickets';
  END IF;

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
    -- A5: default for an unmatched product (no product row) — no price, no conversion.
    v_qty_conv := v_product.quantity;
    v_unit_out := COALESCE(v_product.unit, 'ea');

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
        -- A5: convert the stored quantity (in v_product.unit) to the inventory unit
        -- so total_price, prebook, and the inventory txn all use the pricing/stock unit.
        v_qty_conv := field_app_priced_quantity(
                        v_product.quantity,
                        normalize_rate_unit(NULLIF(btrim(v_product.unit), '')),
                        normalize_rate_unit(COALESCE(NULLIF(btrim(v_db_product.inventory_unit), ''), v_db_product.unit_size)),
                        v_db_product.product_form);
        IF v_qty_conv IS NULL THEN
          RAISE EXCEPTION 'BLEND_TICKET_UNIT_UNCONVERTIBLE: product % quantity unit "%" cannot convert to inventory unit "%"',
            v_product.product_name, v_product.unit, COALESCE(v_db_product.inventory_unit, v_db_product.unit_size);
        END IF;
        v_unit_out := COALESCE(NULLIF(btrim(v_db_product.inventory_unit), ''), v_db_product.unit_size, v_product.unit, 'ea');
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
      v_qty_conv,
      v_unit_out,
      v_price * v_qty_conv,
      (v_price - v_cost) * v_qty_conv,
      CASE WHEN v_price > 0 THEN ((v_price - v_cost) / v_price * 100) ELSE 0 END,
      0,
      v_qty_conv,
      v_product.sequence_order
    );

    -- A5-audit: for a matched catalog product, record the CONVERTED quantity in the
    -- link/audit row so blend_ticket_to_order_items.quantity_applied matches the order
    -- line + inventory txn. Unmatched products get no audit row (unchanged behavior).
    IF v_product.product_id IS NOT NULL THEN
      v_mappings := v_mappings || jsonb_build_object('order_item_id', v_item_id, 'quantity_applied', v_qty_conv);
    END IF;

    IF v_product.product_id IS NOT NULL AND v_qty_conv > 0 THEN
      UPDATE inventory SET
        quantity_prebooked = COALESCE(quantity_prebooked, 0) + v_qty_conv,
        updated_at = now()
      WHERE product_id = v_product.product_id AND location = 'Main Warehouse';

      INSERT INTO inventory_transactions (
        product_id, transaction_type, quantity, to_location,
        order_id, performed_by, notes
      ) VALUES (
        v_product.product_id, 'booked', v_qty_conv, 'Main Warehouse',
        v_order_id, p_performed_by,
        'Prebooked for blend ticket order ' || p_order_number
      );
    END IF;

    v_total_price := v_total_price + (v_price * v_qty_conv);
    v_total_cost := v_total_cost + (v_cost * v_qty_conv);
    v_item_count := v_item_count + 1;
  END LOOP;

  -- CHANGED: Removed balance_due from UPDATE (AR tracked via invoices)
  UPDATE orders
  SET total_price = v_total_price,
      total_cost = v_total_cost,
      total_profit = v_total_price - v_total_cost,
      total_margin_pct = CASE WHEN v_total_price > 0 THEN ((v_total_price - v_total_cost) / v_total_price * 100) ELSE 0 END
  WHERE id = v_order_id;

  v_link_result := link_blend_ticket_to_order(p_blend_ticket_id, v_order_id, v_mappings, p_performed_by);

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
$function$;
