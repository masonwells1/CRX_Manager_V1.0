-- 20260707070000_u7_delivery_split_billing.sql
-- U7 SAFE-SCOPE (finding #43) — chemical/delivery half of splits unification.
--
-- Problem: completing a delivery on a field/acre-allocated (landlord/tenant) order
-- auto-created ONE draft invoice billed 100% to the primary customer, ignoring the
-- allocations — the landlord could never be billed/paid, and the proper per-owner
-- split path was gated off once a delivery existed.
--
-- Fix (skip-and-queue): complete_delivery now SKIPS the mono-bill auto-draft for an
-- allocated order, flags orders.needs_split_billing + notifies admins; and
-- create_split_invoices_from_order becomes reachable after delivery (only an OPEN
-- delivery blocks; the order must be fully delivered because it bills the whole order)
-- and clears the flag on success. Non-allocated orders keep the exact prior behavior.
--
-- Both function bodies are byte-identical to the live definitions except the marked
-- inserts (proven via reconstruction md5 in the build). Same 4-/7-arg signatures, so
-- CREATE OR REPLACE preserves existing grants. NO U8 commission function is touched.

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS needs_split_billing boolean;
COMMENT ON COLUMN public.orders.needs_split_billing IS
  'U7 (#43): set true by complete_delivery when a delivered order has field/acre allocations (the mono-bill auto-draft is skipped); cleared to false by create_split_invoices_from_order once billed per-owner. NULL is treated as false.';

CREATE OR REPLACE FUNCTION public.complete_delivery(p_delivery_id uuid, p_signed_by text, p_performed_by uuid DEFAULT NULL::uuid, p_quantities jsonb DEFAULT NULL::jsonb, p_issue_type text DEFAULT NULL::text, p_issue_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_delivery record;
  v_item record;
  v_inv record;
  v_qty_to_deliver numeric;
  v_deduct_from_prebooked numeric;
  v_any_partial boolean := false;
  v_all_delivered boolean;
  v_linked_invoice record;
  v_result jsonb;
  v_existing jsonb;
  v_actor uuid;
  v_actor_role text;
  v_auto_invoice_id uuid;
  v_auto_invoice_number text;
  v_auto_total_cents bigint := 0;
  v_auto_cost_cents bigint := 0;
  v_existing_active_invoice_count int;
  v_closed_period record;
  v_admin record;
  -- U9 stock-policy WARN-NOT-BLOCK
  v_short_count int := 0;
  v_stock_warnings text[] := '{}';
  v_short_product_ids uuid[] := '{}';
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'complete_delivery');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_delivery FROM deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery not found: %', p_delivery_id; END IF;

  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor;
  IF NOT (
    v_actor_role IN ('admin', 'sales_rep')
    OR (v_actor_role = 'driver' AND v_actor = v_delivery.assigned_driver)
  ) THEN
    RAISE EXCEPTION 'Not authorized to complete this delivery';
  END IF;

  IF v_delivery.status != 'in_progress' THEN
    RAISE EXCEPTION 'Delivery must be in_progress to complete (current status: %). Call confirm_delivery() first.', v_delivery.status;
  END IF;

  -- PR-01 fix: column is `scheduled_date`, not `delivery_date`.
  SELECT id, period_start, period_end
    INTO v_closed_period
    FROM accounting_periods
   WHERE status = 'closed'
     AND v_delivery.scheduled_date BETWEEN period_start AND period_end
   LIMIT 1;

  IF FOUND THEN
    INSERT INTO activity_feed (
      event_type, description, performed_by,
      related_entity_type, related_entity_id, customer_id
    ) VALUES (
      'backdated_delivery_in_closed_period',
      'WARNING: Delivery ' || v_delivery.delivery_number ||
        ' completed for ' || v_delivery.scheduled_date::text ||
        ' which falls in CLOSED accounting period ' ||
        v_closed_period.period_start::text || ' to ' ||
        v_closed_period.period_end::text || '. Operation proceeded; verify with finance.',
      v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
    );

    FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
    LOOP
      INSERT INTO notifications (
        user_id, title, message, notification_type,
        related_entity_type, related_entity_id
      ) VALUES (
        v_admin.id,
        'Backdated Delivery Completion',
        'Delivery ' || v_delivery.delivery_number ||
          ' was completed for ' || v_delivery.scheduled_date::text ||
          ' — that date is inside a CLOSED accounting period (' ||
          v_closed_period.period_start::text || ' to ' ||
          v_closed_period.period_end::text || '). Inventory and lifecycle ' ||
          'changes proceeded. Verify the financial impact.',
        'period_warning', 'delivery', p_delivery_id
      );
    END LOOP;
  END IF;

  FOR v_item IN
    SELECT di.*, p.product_name FROM delivery_items di JOIN products p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id
  LOOP
    IF p_quantities IS NOT NULL AND p_quantities ? v_item.id::text THEN
      v_qty_to_deliver := GREATEST(0, LEAST((p_quantities->>v_item.id::text)::numeric, v_item.quantity));
    ELSE
      v_qty_to_deliver := v_item.quantity;
    END IF;
    IF v_qty_to_deliver < v_item.quantity THEN v_any_partial := true; END IF;
    IF v_qty_to_deliver = 0 THEN CONTINUE; END IF;
    SELECT * INTO v_inv FROM inventory WHERE product_id = v_item.product_id AND location = 'Main Warehouse' FOR UPDATE;
    -- U9: WARN-NOT-BLOCK (was: RAISE EXCEPTION 'Insufficient inventory ...').
    -- Same on-hand math; completion proceeds and stock is allowed to go negative.
    IF NOT FOUND OR COALESCE(v_inv.quantity_available, 0) < v_qty_to_deliver THEN
      v_short_count := v_short_count + 1;
      v_short_product_ids := array_append(v_short_product_ids, v_item.product_id);
      v_stock_warnings := array_append(v_stock_warnings,
        v_item.product_name || ': need ' || v_qty_to_deliver || ', only ' ||
        COALESCE(v_inv.quantity_available, 0) || ' on-hand');
      -- U9 (Codex R2 P2): seed a zero row when missing so the deduction UPDATE
      -- below lands and the on-hand aggregate goes visibly negative.
      IF NOT FOUND THEN
        INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, manufactured_at_delivery)
        VALUES (v_item.product_id, 'Main Warehouse', 0, 0, true)  -- surfaces on /integrity-cleanup (P4-7 phantom-row flag)
        ON CONFLICT DO NOTHING;
      END IF;
    END IF;
  END LOOP;

  -- P2-D: authorize the post-completion delivery_items + lifecycle writes below.
  -- The enforce_delivery_items_parent_lock trigger blocks writes to a
  -- non-scheduled delivery's items; complete_delivery legitimately records
  -- quantity_delivered after flipping status to 'completed', so it sets the
  -- canonical admin_override escape hatch (transaction-local).
  SET LOCAL app.admin_override = 'true';

  UPDATE deliveries SET
    status = 'completed', completed_at = now(), signed_by = p_signed_by,
    issue_type = COALESCE(p_issue_type, issue_type),
    issue_notes = CASE WHEN p_issue_notes IS NOT NULL THEN p_issue_notes ELSE issue_notes END
  WHERE id = p_delivery_id;

  FOR v_item IN
    SELECT di.*, p.product_name FROM delivery_items di JOIN products p ON p.id = di.product_id
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

    -- U9: flag the delivered ledger row for review when the product was short.
    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, from_location,
      order_id, delivery_id, performed_by, notes, requires_review
    ) VALUES (
      v_item.product_id, 'delivered', v_qty_to_deliver, 'Main Warehouse',
      v_delivery.order_id, p_delivery_id, v_actor,
      'Delivery ' || v_delivery.delivery_number ||
        CASE WHEN v_qty_to_deliver < v_item.quantity
          THEN ' (partial: ' || v_qty_to_deliver || '/' || v_item.quantity || ')'
          ELSE '' END ||
        CASE WHEN v_item.product_id = ANY(v_short_product_ids)
          THEN ' [SHORT STOCK — review required]' ELSE '' END ||
        '. Signed by: ' || p_signed_by,
      v_item.product_id = ANY(v_short_product_ids)
    );

    SELECT * INTO v_inv FROM inventory WHERE product_id = v_item.product_id AND location = 'Main Warehouse';
    v_deduct_from_prebooked := LEAST(v_qty_to_deliver, COALESCE(v_inv.quantity_prebooked, 0));

    UPDATE inventory SET
      quantity_available = quantity_available - v_qty_to_deliver,
      quantity_prebooked = quantity_prebooked - v_deduct_from_prebooked,
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';
  END LOOP;

  -- U2 (Codex P2): with per-delivery invoices now possible on one order, the
  -- tote copy must NOT stamp a SIBLING delivery's invoice — scope it to this
  -- delivery's own invoice or an order-level one (delivery_id IS NULL), the
  -- same shape as the auto-invoice guard below.
  UPDATE invoice_items ii
  SET tote_number = di.tote_number
  FROM delivery_items di
  JOIN invoices inv ON inv.order_id = v_delivery.order_id AND inv.deleted_at IS NULL
    AND (inv.delivery_id = p_delivery_id OR inv.delivery_id IS NULL)
  WHERE di.delivery_id = p_delivery_id
    AND ii.invoice_id = inv.id
    AND di.order_item_id = ii.order_item_id
    AND di.tote_number IS NOT NULL;

  IF v_any_partial THEN
    FOR v_item IN
      SELECT di.*, p.product_name FROM delivery_items di JOIN products p ON p.id = di.product_id
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

  -- U2 #39: close out the remainder rows THIS follow-up delivery was created to satisfy.
  -- create_followup_delivery flips the parent's remainders 'pending'->'scheduled' and stamps
  -- followup_delivery_id = this delivery. Now that this delivery has completed, mark them
  -- 'fulfilled'. Any lines this follow-up ITSELF shorted are already captured as fresh
  -- 'pending' remainder rows by the v_any_partial INSERT above (original_delivery_id = this
  -- delivery), so this flip never loses outstanding quantity — it prevents the same shortfall
  -- being double-counted as both a stale 'scheduled' row and a new 'pending' row. Idempotent
  -- (guarded by status = 'scheduled'); targets rows disjoint from the ones just inserted.
  UPDATE delivery_remainders
     SET status = 'fulfilled', updated_at = now()
   WHERE followup_delivery_id = p_delivery_id
     AND status = 'scheduled';

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
      WHERE order_id = v_delivery.order_id AND status = 'draft' AND delivery_id = p_delivery_id
    LOOP
      UPDATE invoice_items ii SET
        quantity = di.quantity_delivered,
        extended_cents = ROUND(di.quantity_delivered * ii.unit_price_cents)
      FROM delivery_items di
      WHERE di.delivery_id = p_delivery_id AND ii.invoice_id = v_linked_invoice.id AND ii.order_item_id = di.order_item_id;
      -- Overnight bug-hunt LOW (20260620): also recompute the stored header cost so
      -- a partial completion doesn't leave total_cost_cents sized to the full qty.
      -- cost_cents is PER-UNIT cents; line cost = cost_cents * quantity (no *100).
      UPDATE invoices SET
        total_amount_cents = (SELECT COALESCE(SUM(extended_cents), 0) FROM invoice_items WHERE invoice_id = v_linked_invoice.id),
        total_cost_cents = (SELECT COALESCE(SUM(cost_cents * quantity), 0) FROM invoice_items WHERE invoice_id = v_linked_invoice.id),
        updated_at = now()
      WHERE id = v_linked_invoice.id;
    END LOOP;
  END IF;

  IF v_delivery.order_id IS NOT NULL THEN
    -- U2 #34: per-DELIVERY-aware guard (was per-ORDER). Block only if THIS delivery already
    -- has an active invoice, or an ORDER-LEVEL invoice (delivery_id IS NULL) already covers
    -- the whole order. An active invoice tied to a DIFFERENT delivery must NOT block this
    -- delivery — otherwise a follow-up delivery of shorted product is never billed.
    SELECT COUNT(*) INTO v_existing_active_invoice_count
    FROM invoices
    WHERE order_id = v_delivery.order_id
      AND status NOT IN ('voided', 'cancelled')
      AND (delivery_id = p_delivery_id OR delivery_id IS NULL);

    IF v_existing_active_invoice_count = 0 THEN
      -- U7 SAFE-SCOPE (#43): a field/acre-allocated order must NOT be mono-billed
      -- 100% to the primary customer (that dead-ends the landlord's payment). Skip the
      -- auto-draft, flag the order for a manual per-owner split-billing pass, and notify
      -- the office. Non-allocated orders keep the EXACT auto-draft in the ELSE below.
      IF EXISTS (
        SELECT 1 FROM order_item_field_allocations oifa
        JOIN order_items oi ON oi.id = oifa.order_item_id
        WHERE oi.order_id = v_delivery.order_id
      ) THEN
        UPDATE orders SET needs_split_billing = true, updated_at = now()
          WHERE id = v_delivery.order_id;
        INSERT INTO activity_feed (
          event_type, description, performed_by,
          related_entity_type, related_entity_id, customer_id
        ) VALUES (
          'order_needs_split_billing',
          'Delivery ' || v_delivery.delivery_number || ' completed on a multi-owner (field/acre) order — auto-invoice skipped; create split invoices from the order to bill each owner.',
          v_actor, 'order', v_delivery.order_id, v_delivery.customer_id
        );
        FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
        LOOP
          INSERT INTO notifications (
            user_id, title, message, notification_type,
            related_entity_type, related_entity_id
          ) VALUES (
            v_admin.id,
            'Order needs split billing',
            'Delivery ' || v_delivery.delivery_number || ' completed on a field/acre-allocated order. The mono-bill auto-invoice was skipped — open the order and use "Create Split Invoices" to bill each owner their own payable invoice.',
            'split_billing', 'order', v_delivery.order_id
          );
        END LOOP;
      ELSE
      v_auto_invoice_number := next_invoice_number('chemical_sale');
      INSERT INTO invoices (
        invoice_number, invoice_type, order_id, customer_id, delivery_id,
        status, invoice_date, total_amount_cents, total_cost_cents, created_by
      ) VALUES (
        v_auto_invoice_number, 'chemical_sale', v_delivery.order_id, v_delivery.customer_id, p_delivery_id,
        'draft', CURRENT_DATE, 0, 0, v_actor
      ) RETURNING id INTO v_auto_invoice_id;

      v_auto_total_cents := 0;
      v_auto_cost_cents := 0;
      FOR v_item IN
        SELECT di.id AS di_id, di.product_id, di.quantity_delivered, di.unit_size, di.order_item_id, di.tote_number,
               oi.price_per_unit, oi.cost_per_unit, oi.product_name AS oi_product_name,
               p.product_name AS p_name
          FROM delivery_items di
          JOIN order_items oi ON oi.id = di.order_item_id
          JOIN products p ON p.id = di.product_id
         WHERE di.delivery_id = p_delivery_id
           AND COALESCE(di.quantity_delivered, 0) > 0
      LOOP
        v_auto_total_cents := v_auto_total_cents + ROUND(v_item.quantity_delivered * v_item.price_per_unit * 100)::bigint;
        v_auto_cost_cents  := v_auto_cost_cents  + ROUND(v_item.quantity_delivered * COALESCE(v_item.cost_per_unit, 0) * 100)::bigint;
        INSERT INTO invoice_items (
          invoice_id, order_item_id, product_id, description,
          quantity, unit_price_cents, extended_cents, cost_cents,
          unit_size, tote_number
        ) VALUES (
          v_auto_invoice_id, v_item.order_item_id, v_item.product_id,
          COALESCE(v_item.oi_product_name, v_item.p_name),
          v_item.quantity_delivered,
          ROUND(v_item.price_per_unit * 100)::bigint,
          ROUND(v_item.quantity_delivered * v_item.price_per_unit * 100)::bigint,
          ROUND(COALESCE(v_item.cost_per_unit, 0) * 100)::bigint,
          v_item.unit_size,
          v_item.tote_number
        );
      END LOOP;

      UPDATE invoices
         SET total_amount_cents = v_auto_total_cents,
             total_cost_cents   = v_auto_cost_cents
       WHERE id = v_auto_invoice_id;

      -- Overnight bug-hunt MED (20260620): provenance breadcrumb. Write the same
      -- financial_audit_log 'invoice_created' row create_invoice_from_order /
      -- create_invoice_for_unbilled_delivery write, so the append-only ledger
      -- records this auto-creator too (it previously logged only activity_feed).
      -- Draft-stage provenance; post_invoice still writes 'invoice_posted' later.
      INSERT INTO financial_audit_log (
        operation_type, entity_type, entity_id, actor_role,
        new_values, total_impact_cents, description
      ) VALUES (
        'invoice_created', 'invoice', v_auto_invoice_id,
        (SELECT role FROM profiles WHERE id = v_actor),
        jsonb_build_object(
          'invoice_number', v_auto_invoice_number,
          'delivery_id', p_delivery_id,
          'order_id', v_delivery.order_id,
          'customer_id', v_delivery.customer_id,
          'total_cents', v_auto_total_cents
        ),
        v_auto_total_cents,
        'Invoice ' || v_auto_invoice_number || ' auto-created on completion of delivery ' || v_delivery.delivery_number
      );
      END IF;
    END IF;
  END IF;

  -- U9: short-stock WARN emit (mirrors the backdated-period warn+notify pattern above).
  IF v_short_count > 0 THEN
    INSERT INTO activity_feed (
      event_type, description, performed_by,
      related_entity_type, related_entity_id, customer_id
    ) VALUES (
      'delivery_short_stock',
      'WARNING: Delivery ' || v_delivery.delivery_number || ' completed with ' || v_short_count ||
        ' product(s) short on stock: ' || array_to_string(v_stock_warnings, ' | ') ||
        '. Completion proceeded; on-hand inventory went negative — review with the warehouse.',
      v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
    );
    FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
    LOOP
      INSERT INTO notifications (
        user_id, title, message, notification_type,
        related_entity_type, related_entity_id
      ) VALUES (
        v_admin.id,
        'Short Stock — Delivery ' || v_delivery.delivery_number,
        'Delivery ' || v_delivery.delivery_number || ' was completed but ' || v_short_count ||
          ' product(s) did not have enough on-hand stock: ' || array_to_string(v_stock_warnings, ' | ') ||
          '. The completion proceeded and inventory went negative; please review.',
        'stock_warning', 'delivery', p_delivery_id
      );
    END LOOP;
  END IF;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_completed',
    'Delivery ' || v_delivery.delivery_number || ' completed. Signed by: ' || p_signed_by ||
      CASE WHEN v_any_partial THEN ' (partial delivery — remainders created)' ELSE '' END ||
      CASE WHEN v_auto_invoice_id IS NOT NULL THEN ' [draft invoice ' || v_auto_invoice_number || ' auto-created]' ELSE '' END,
    v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  -- U9: additive result fields — warnings[] + short_stock_count.
  v_result := jsonb_build_object(
    'status', CASE WHEN v_any_partial THEN 'partial' ELSE 'completed' END,
    'delivery_id', p_delivery_id,
    'order_fulfilled', v_all_delivered,
    'auto_invoice', CASE
      WHEN v_auto_invoice_id IS NOT NULL THEN
        jsonb_build_object('invoice_id', v_auto_invoice_id, 'invoice_number', v_auto_invoice_number, 'total_cents', v_auto_total_cents)
      ELSE NULL
    END,
    'stock_warning', (v_short_count > 0),
    'short_stock_count', v_short_count,
    'warnings', to_jsonb(v_stock_warnings)
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'complete_delivery', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_split_invoices_from_order(p_order_id uuid, p_salesman_id uuid DEFAULT NULL::uuid, p_invoice_type text DEFAULT 'chemical_sale'::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing text;
  v_order record;
  v_has_alloc boolean := false;
  v_existing_count int;
  v_delivery_count int;
  v_group_id uuid;
  v_invoice_id uuid;
  v_invoice_ids uuid[] := '{}';
  v_item record;
  v_alloc record;
  v_cust record;
  v_line_cents bigint;
  v_total_acres numeric;
  v_acre_pcts numeric[];
  v_field_cents bigint[];
  v_field_idx int;
  v_owner_ids uuid[];
  v_owner_pcts numeric[];
  v_owner_cents bigint[];
  v_owner_acres numeric;
  v_sum_pct numeric;
  v_oidx int;
  v_total_cents bigint;
  -- per-(customer, line) contribution accumulator; aggregated in pass 2.
  v_rows jsonb := '[]'::jsonb;
BEGIN
  -- Authorization (mirror create_invoice_from_order): creating invoices is admin/sales_rep only.
  -- The old split path was unreachable (quote_sections.field_id was never persisted), so it had
  -- no gate; making it reachable means it MUST gate here or any authenticated user (driver/applicator)
  -- could mint invoices via this SECURITY DEFINER RPC (Codex P1).
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to create invoices from orders';
  END IF;

  -- Lock the order FIRST (mirror create_invoice_from_order's Codex-P1 lock): serializes against a
  -- concurrent delivery/invoice insert AND against a same-key retry, so the idempotency replay below
  -- runs only after any in-flight first call on this order has committed.
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found: %', p_order_id; END IF;

  -- Canonical operation-scoped idempotency replay, AFTER the order lock (draw_down_quote 2026-06-10
  -- pattern): a racing same-key retry blocks on the lock above, then resumes here and returns the
  -- cached invoice ids — instead of missing the still-uncommitted row pre-lock and then falsely
  -- erroring on the active-invoice guard below (Codex round-3 P2). result is a jsonb string; #>>'{}'
  -- extracts the bare "id1,id2" text so string_to_array sees no surrounding quotes.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result #>> '{}' INTO v_existing FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND operation = 'create_split_invoices_from_order';
    IF v_existing IS NOT NULL THEN RETURN string_to_array(v_existing, ',')::uuid[]; END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM order_item_field_allocations oifa
    JOIN order_items oi ON oi.id = oifa.order_item_id
    WHERE oi.order_id = p_order_id
  ) INTO v_has_alloc;

  -- No per-line field allocations anywhere on this order -> single invoice (unchanged).
  IF NOT v_has_alloc THEN
    v_invoice_id := create_invoice_from_order(p_order_id, p_salesman_id, p_invoice_type, p_idempotency_key);
    RETURN ARRAY[v_invoice_id];
  END IF;

  -- The split path inserts invoices DIRECTLY (the single-invoice path above delegates to
  -- create_invoice_from_order, which carries these guards). Replicate them so an allocated order
  -- that already has an active invoice or an active delivery cannot be double-billed (Codex P1).
  SELECT COUNT(*) INTO v_existing_count FROM invoices
    WHERE order_id = p_order_id AND status NOT IN ('voided', 'cancelled');
  IF v_existing_count > 0 THEN
    RAISE EXCEPTION 'Active invoice already exists for order % (% existing invoice(s)). Void or cancel the existing invoice first if you need to recreate.', v_order.order_number, v_existing_count;
  END IF;
  SELECT COUNT(*) INTO v_delivery_count FROM deliveries
    -- U7 SAFE-SCOPE (#43): only an OPEN (scheduled/in_progress) delivery blocks now;
    -- a COMPLETED delivery on a field/acre-allocated order left NO auto-draft to
    -- double against (complete_delivery skipped the mono-bill), so the split can run.
    WHERE order_id = p_order_id AND status IN ('scheduled', 'in_progress');
  IF v_delivery_count > 0 THEN
    RAISE EXCEPTION 'Cannot create an order-level invoice for order % — it has % active delivery(ies); invoices are created per delivery on completion. Cancel/void those deliveries first to bill the whole order manually.', v_order.order_number, v_delivery_count;
  END IF;

  -- U7 SAFE-SCOPE (#43): this engine bills the WHOLE order (off order_items.total_price),
  -- so it may only run once nothing remains to deliver — otherwise it bills undelivered
  -- product. (Per-delivery split billing would be a larger redesign; out of scope.)
  IF EXISTS (SELECT 1 FROM order_items WHERE order_id = p_order_id AND COALESCE(quantity_remaining, 0) > 0) THEN
    RAISE EXCEPTION 'Order % is not fully delivered; split invoicing bills the whole order and would over-bill undelivered product. Complete all deliveries first.', v_order.order_number;
  END IF;

  -- Split-by-acre needs real line prices: a price-pending order would allocate $0 across fields
  -- (meaningless) and price_order cannot re-split a multi-customer invoice, so the single-invoice
  -- path's "create $0 drafts, sweep later" does not transfer here. Reject EXPLICITLY rather than
  -- silently produce no invoice (Codex round-2 P2). Price the order first, then split.
  IF EXISTS (SELECT 1 FROM order_items WHERE order_id = p_order_id AND pricing_pending) THEN
    RAISE EXCEPTION 'PRICING_INCOMPLETE: price the order before generating split invoices';
  END IF;

  -- PASS 1: compute every (customer, line) cents + prorated qty into v_rows.
  FOR v_item IN
    SELECT * FROM order_items WHERE order_id = p_order_id ORDER BY sort_order NULLS LAST, id
  LOOP
    v_line_cents := round(v_item.total_price * 100)::bigint;

    IF NOT EXISTS (SELECT 1 FROM order_item_field_allocations WHERE order_item_id = v_item.id) THEN
      -- Unallocated line: bill the whole line (incl. its full acres) to the order's own customer.
      v_rows := v_rows || jsonb_build_object(
        'c', v_order.customer_id, 'oi', v_item.id,
        'cents', v_line_cents, 'qty', COALESCE(v_item.total_units_needed, 0),
        'acres', COALESCE(v_item.acres, 0));
      CONTINUE;
    END IF;

    -- Split the line across its fields BY ACRES (stable order = field_id).
    SELECT sum(acres) INTO v_total_acres
      FROM order_item_field_allocations WHERE order_item_id = v_item.id;
    SELECT array_agg(acres / v_total_acres * 100 ORDER BY field_id) INTO v_acre_pcts
      FROM order_item_field_allocations WHERE order_item_id = v_item.id;
    v_field_cents := calculate_billing_splits(v_line_cents, v_acre_pcts);

    v_field_idx := 0;
    FOR v_alloc IN
      SELECT field_id, acres FROM order_item_field_allocations
      WHERE order_item_id = v_item.id ORDER BY field_id
    LOOP
      v_field_idx := v_field_idx + 1;

      -- Owners of this field, or fall back to the field's own customer at 100%.
      IF EXISTS (SELECT 1 FROM field_billing_defaults WHERE field_id = v_alloc.field_id) THEN
        SELECT array_agg(customer_id ORDER BY customer_id),
               array_agg(split_pct ORDER BY customer_id),
               sum(split_pct)
          INTO v_owner_ids, v_owner_pcts, v_sum_pct
          FROM field_billing_defaults WHERE field_id = v_alloc.field_id;
        IF v_sum_pct < 99.99 OR v_sum_pct > 100.01 THEN
          RAISE EXCEPTION 'FIELD_SPLIT_NOT_100: field % billing splits total % (must equal 100)',
            v_alloc.field_id, v_sum_pct;
        END IF;
        -- Normalize to sum EXACTLY 100 (order-preserving) so calculate_billing_splits — which assumes
        -- the percentages total 100 — cannot over-allocate within the tolerance band, e.g. 50.01+50.00
        -- would otherwise floor to MORE than the field's cents (Codex P2). v_owner_ids stays aligned.
        SELECT array_agg(p / v_sum_pct * 100 ORDER BY ord)
          INTO v_owner_pcts FROM unnest(v_owner_pcts) WITH ORDINALITY AS u(p, ord);
      ELSE
        SELECT ARRAY[customer_id] INTO v_owner_ids FROM fields WHERE id = v_alloc.field_id;
        v_owner_pcts := ARRAY[100::numeric];
      END IF;

      -- Split this field's portion among its owners BY split_pct (penny-exact).
      v_owner_cents := calculate_billing_splits(v_field_cents[v_field_idx], v_owner_pcts);

      FOR v_oidx IN 1..array_length(v_owner_ids, 1) LOOP
        -- This owner's slice of THIS field = field acres * their normalized pct. Bill that many
        -- acres to them (so split invoice items carry PRORATED acres, not the line's full acres —
        -- otherwise year-end/RUP acre reports double-count; Codex round-5 P2). qty is prorated by the
        -- same acre-share: well-defined even for a $0 line (v_total_acres > 0 for any allocated line)
        -- and it sums back to the line's total qty across owners.
        v_owner_acres := v_alloc.acres * v_owner_pcts[v_oidx] / 100;
        v_rows := v_rows || jsonb_build_object(
          'c', v_owner_ids[v_oidx], 'oi', v_item.id,
          'cents', v_owner_cents[v_oidx],
          'acres', round(v_owner_acres, 4),
          'qty', round(COALESCE(v_item.total_units_needed, 0) * v_owner_acres / v_total_acres, 4));
      END LOOP;
    END LOOP;
  END LOOP;

  -- A customer whose allocated subtotal is NEGATIVE (a discount line allocated to them exceeds their
  -- charges) cannot become a non-negative invoice; silently skipping them (the outer HAVING > 0 below)
  -- would make the OTHER customers' invoices over-sum the order total — breaking the penny-exact
  -- reconciliation guarantee. Fail loudly instead of mis-billing (Codex round-6 P2). A net-ZERO customer
  -- is safe to skip (contributes 0, reconciliation still holds); only a strictly-negative net is rejected.
  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(v_rows) AS x(c uuid, oi uuid, cents bigint, qty numeric, acres numeric)
    GROUP BY x.c HAVING sum(x.cents) < 0
  ) THEN
    RAISE EXCEPTION 'SPLIT_NET_NEGATIVE: a customer''s allocated subtotal is negative — cannot create split invoices (adjust the discount/allocation or issue a credit memo)';
  END IF;

  -- PASS 2: one invoice per customer, from the accumulated contributions.
  v_group_id := gen_random_uuid();

  FOR v_cust IN
    SELECT x.c AS customer_id, sum(x.cents) AS cust_total
    FROM jsonb_to_recordset(v_rows) AS x(c uuid, oi uuid, cents bigint, qty numeric)
    GROUP BY x.c
    HAVING sum(x.cents) > 0
    ORDER BY x.c
  LOOP
    INSERT INTO invoices (order_id, customer_id, invoice_type, status, season, salesman_id,
      created_by, total_amount_cents, invoice_date, invoice_group_id, header_notes)
    VALUES (p_order_id, v_cust.customer_id, p_invoice_type, 'draft',
      COALESCE(v_order.season, current_season()),
      COALESCE(p_salesman_id, v_order.salesman_id), auth.uid(), 0, CURRENT_DATE, v_group_id,
      'Split invoice (by field/acre) from order ' || v_order.order_number)
    RETURNING id INTO v_invoice_id;

    v_total_cents := 0;
    FOR v_item IN
      SELECT oi.*, agg.cents AS cust_cents, agg.qty AS cust_qty, agg.acres AS cust_acres
      FROM (
        SELECT x.oi AS order_item_id, sum(x.cents)::bigint AS cents, sum(x.qty) AS qty, sum(x.acres) AS acres
        FROM jsonb_to_recordset(v_rows) AS x(c uuid, oi uuid, cents bigint, qty numeric, acres numeric)
        WHERE x.c = v_cust.customer_id
        GROUP BY x.oi
        -- Keep a line on the invoice if the customer has ANY contribution to it: non-zero cents
        -- (incl. a negative discount line, so the total reconciles to their net — Codex round-4 P2),
        -- OR non-zero qty/acres (so a legitimate $0 / no-charge product line still carries its product,
        -- quantity and acres for the PDF and year-end usage reports, matching create_invoice_from_order
        -- — Codex round-5 P2). The per-customer (outer) HAVING > 0 still gates which customers get a
        -- (CHECK-non-negative) invoice; a customer whose net is <= 0 is skipped (v1 — a net credit /
        -- a $0-only allocation would need a credit_memo / explicit $0 invoice, out of scope).
        HAVING sum(x.cents) <> 0 OR sum(x.qty) <> 0 OR sum(x.acres) <> 0
      ) agg
      JOIN order_items oi ON oi.id = agg.order_item_id
      ORDER BY oi.sort_order NULLS LAST, oi.id
    LOOP
      INSERT INTO invoice_items (invoice_id, order_item_id, product_id, description, quantity,
        unit_price_cents, extended_cents, cost_cents, sort_order, rate_per_acre, acres, unit_size)
      VALUES (v_invoice_id, v_item.id, v_item.product_id, COALESCE(v_item.product_name, ''),
        v_item.cust_qty, round(v_item.price_per_unit * 100)::bigint, v_item.cust_cents,
        round(v_item.cost_per_unit * 100)::bigint, COALESCE(v_item.sort_order, 0),
        v_item.actual_rate, v_item.cust_acres, v_item.unit_size);
      v_total_cents := v_total_cents + v_item.cust_cents;
    END LOOP;

    UPDATE invoices SET total_amount_cents = v_total_cents WHERE id = v_invoice_id;

    INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role,
      new_values, total_impact_cents, description)
    VALUES ('invoice_created', 'invoice', v_invoice_id,
      COALESCE((SELECT role FROM profiles WHERE id = auth.uid()), 'admin'),
      jsonb_build_object('order_number', v_order.order_number, 'group_id', v_group_id,
        'split_basis', 'field_acre'),
      v_total_cents, 'Split invoice (by field/acre) from order ' || v_order.order_number);

    v_invoice_ids := v_invoice_ids || v_invoice_id;
  END LOOP;

  INSERT INTO activity_feed (event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id)
  VALUES ('split_invoices_created',
    COALESCE(array_length(v_invoice_ids, 1), 0) || ' split invoices from order ' || v_order.order_number,
    auth.uid(), 'order', p_order_id, v_order.customer_id);

  -- U7 SAFE-SCOPE (#43): the order is now split-billed per-owner — clear the
  -- "needs split billing" queue flag complete_delivery set when it skipped the mono-bill.
  UPDATE orders SET needs_split_billing = false, updated_at = now() WHERE id = p_order_id;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'create_split_invoices_from_order',
      to_jsonb(array_to_string(v_invoice_ids, ',')));
  END IF;

  RETURN v_invoice_ids;
END;
$function$;
