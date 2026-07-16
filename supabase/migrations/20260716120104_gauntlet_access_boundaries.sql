-- Money/inventory gauntlet: make critical writes RPC-only and close inactive-user paths.
-- Built from the live function definitions inspected 2026-07-15. No data changes.

CREATE OR REPLACE FUNCTION public.complete_delivery(p_delivery_id uuid, p_signed_by text, p_performed_by uuid DEFAULT NULL::uuid, p_quantities jsonb DEFAULT NULL::jsonb, p_issue_type text DEFAULT NULL::text, p_issue_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_completed_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
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
  v_effective_completion_date date;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;

  -- U15: optional backdate. Reject future timestamps (small clock-skew allowance);
  -- NULL = legacy behavior (now()/CURRENT_DATE).
  IF p_completed_at IS NOT NULL AND p_completed_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'COMPLETED_AT_IN_FUTURE: completion time cannot be in the future';
  END IF;

  v_effective_completion_date := COALESCE(
    (p_completed_at AT TIME ZONE 'America/Chicago')::date,
    (now() AT TIME ZONE 'America/Chicago')::date
  );

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'complete_delivery');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_delivery FROM deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery not found: %', p_delivery_id; END IF;

  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR NOT (
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
     AND v_effective_completion_date BETWEEN period_start AND period_end
   LIMIT 1;

  IF FOUND THEN
    INSERT INTO activity_feed (
      event_type, description, performed_by,
      related_entity_type, related_entity_id, customer_id
    ) VALUES (
      'backdated_delivery_in_closed_period',
      'WARNING: Delivery ' || v_delivery.delivery_number ||
        ' completed for ' || v_effective_completion_date::text ||
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
          ' was completed for ' || v_effective_completion_date::text ||
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
    status = 'completed', completed_at = COALESCE(p_completed_at, now()), signed_by = p_signed_by,
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

  -- P2 fix (Codex 2026-07-10): serialize concurrent same-day FINAL deliveries on the SAME
  -- order. Two deliveries completing at once each read v_all_delivered under READ COMMITTED
  -- without seeing the other's uncommitted order_items decrement, so both could compute
  -- false and skip the Feature A auto-split (order falls back to manual split-billing — safe,
  -- but the auto-split silently doesn't fire). Take the orders row lock BEFORE the read: the
  -- second completion blocks here until the first commits, then sees the committed decrement.
  -- Lock ORDER is unchanged (deliveries -> inventory -> orders): the UPDATE orders just below
  -- already acquired this same row lock — this only moves the acquisition ahead of the read,
  -- adding no new lock pair (no new deadlock surface).
  IF v_delivery.order_id IS NOT NULL THEN
    PERFORM 1 FROM orders WHERE id = v_delivery.order_id FOR UPDATE;
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
        -- Codex pre-ship HIGH fix: only auto-split when the delivery's EFFECTIVE date is TODAY.
        -- create_split_invoices_from_order stamps invoice_date = CURRENT_DATE and takes no date arg, so
        -- auto-splitting a BACKDATED completion (p_completed_at in a prior/closed period) would silently
        -- date the drafts today and shift AR aging/terms — while the mono-bill path (below) respects the
        -- backdate. A backdated allocated order falls through to flag+notify (the office creates the split
        -- manually, exactly as before Feature A); same-day completions (the common case) auto-split.
        IF v_all_delivered
           AND v_effective_completion_date = (now() AT TIME ZONE 'America/Chicago')::date THEN
          -- the whole order is now delivered TODAY -> auto-create the per-owner split DRAFTS via the proven engine.
          BEGIN
            PERFORM create_split_invoices_from_order(
              v_delivery.order_id, NULL, 'chemical_sale',
              COALESCE(p_idempotency_key, p_delivery_id::text) || ':autosplit'
            );
            -- create_split_invoices_from_order creates draft invoices per owner, clears
            -- needs_split_billing, and writes its own activity_feed + financial_audit_log rows.
            -- Add ONE activity_feed row noting the auto-creation on this delivery completion.
            INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
            VALUES (
              'split_invoices_auto_created',
              'Delivery ' || v_delivery.delivery_number || ' completed the order — per-owner split DRAFT invoices were auto-created (review + post them).',
              v_actor, 'order', v_delivery.order_id, v_delivery.customer_id
            );
          EXCEPTION WHEN OTHERS THEN
            -- Any reason the split cannot run yet (order not priced -> PRICING_INCOMPLETE, an
            -- edge race, a still-open sibling delivery, etc.): fall back to today's flag+notify.
            -- The subtransaction rolls back any partial split work; the delivery completion is UNAFFECTED.
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
        END;
      ELSE
        -- Partial delivery of an allocated order (product still remains): keep today's
        -- skip-and-queue exactly. (Per-delivery split billing for partial orders is a separate redesign.)
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
      END IF;
      ELSE
      v_auto_invoice_number := next_invoice_number('chemical_sale');
      INSERT INTO invoices (
        invoice_number, invoice_type, order_id, customer_id, delivery_id,
        status, invoice_date, total_amount_cents, total_cost_cents, created_by
      ) VALUES (
        v_auto_invoice_number, 'chemical_sale', v_delivery.order_id, v_delivery.customer_id, p_delivery_id,
        'draft', v_effective_completion_date, 0, 0, v_actor
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

REVOKE EXECUTE ON FUNCTION public.complete_delivery(uuid, text, uuid, jsonb, text, text, text, timestamptz)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_delivery(uuid, text, uuid, jsonb, text, text, text, timestamptz)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.void_delivery(p_delivery_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor         uuid;
  v_delivery      record;
  v_item          record;
  v_posted_invoices_exist boolean := false;
  v_order_confirmed boolean;
  v_order_fulfilled boolean;
  v_new_order_status text;
  v_closed_period record;
  v_effective_completion_date date;
  v_admin record;
  -- DELTA-IDEM BEGIN (#11 nightly-debug: canonical idempotency — cache/replay the rich result)
  v_existing jsonb;
  v_result jsonb;
  -- DELTA-IDEM END
BEGIN
  -- Strict actor pattern (codex audit F1)
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admin access required to void a completed delivery';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to void a delivery';
  END IF;

  -- DELTA-IDEM BEGIN (#11: canonical check — replay the cached rich payload, not a bare marker)
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'void_delivery');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;
  -- DELTA-IDEM END

  SELECT * INTO v_delivery
  FROM deliveries
  WHERE id = p_delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found: %', p_delivery_id;
  END IF;

  IF v_delivery.status != 'completed' THEN
    RAISE EXCEPTION 'Only completed deliveries can be voided (current status: %)', v_delivery.status;
  END IF;

  -- A void reverses the completed delivery's accounting event, so period
  -- detection must use the actual Chicago completion business date rather
  -- than the schedule date. Keep the schedule date only as a legacy fallback.
  v_effective_completion_date := COALESCE(
    (v_delivery.completed_at AT TIME ZONE 'America/Chicago')::date,
    v_delivery.scheduled_date
  );

  SELECT id, period_start, period_end
    INTO v_closed_period
    FROM accounting_periods
   WHERE status = 'closed'
     AND v_effective_completion_date BETWEEN period_start AND period_end
   LIMIT 1;

  IF FOUND THEN
    INSERT INTO activity_feed (
      event_type, description, performed_by,
      related_entity_type, related_entity_id, customer_id
    ) VALUES (
      'backdated_delivery_in_closed_period',
      'WARNING: Delivery ' || v_delivery.delivery_number ||
        ' voided for completion date ' || v_effective_completion_date::text ||
        ' which falls in CLOSED accounting period ' ||
        v_closed_period.period_start::text || ' to ' ||
        v_closed_period.period_end::text || '. Reason: ' || p_reason ||
        '. Operation proceeded; verify with finance.',
      v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
    );

    FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
    LOOP
      INSERT INTO notifications (
        user_id, title, message, notification_type,
        related_entity_type, related_entity_id
      ) VALUES (
        v_admin.id,
        'Backdated Delivery Void',
        'Delivery ' || v_delivery.delivery_number ||
          ' was voided for completion date ' || v_effective_completion_date::text ||
          ' — that date is inside a CLOSED accounting period (' ||
          v_closed_period.period_start::text || ' to ' ||
          v_closed_period.period_end::text || '). Inventory was restored and ' ||
          'draft invoices were auto-cancelled. Verify the financial impact.',
        'period_warning', 'delivery', p_delivery_id
      );
    END LOOP;
  END IF;

  PERFORM set_config('app.admin_override', 'true', true);

  FOR v_item IN
    SELECT di.*, p.product_name
    FROM delivery_items di
    JOIN products p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id
      AND di.quantity_delivered > 0
  LOOP
    UPDATE inventory SET
      quantity_available = quantity_available + v_item.quantity_delivered,
      quantity_prebooked = quantity_prebooked + v_item.quantity_delivered,
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, from_location,
      order_id, delivery_id, performed_by, notes
    ) VALUES (
      v_item.product_id, 'void_delivery_reversal', v_item.quantity_delivered, 'Main Warehouse',
      v_delivery.order_id, p_delivery_id, v_actor,
      'Delivery ' || v_delivery.delivery_number || ' voided: ' || p_reason || ' (available + prebooked restored)'
    );

    UPDATE order_items SET
      quantity_delivered = GREATEST(quantity_delivered - v_item.quantity_delivered, 0),
      quantity_remaining = quantity_remaining + v_item.quantity_delivered
    WHERE id = v_item.order_item_id;
  END LOOP;

  DELETE FROM delivery_remainders WHERE original_delivery_id = p_delivery_id;

  SELECT NOT EXISTS (
    SELECT 1 FROM order_items
    WHERE order_id = v_delivery.order_id AND quantity_remaining > 0
  ) INTO v_order_fulfilled;

  SELECT NOT EXISTS (
    SELECT 1 FROM order_items
    WHERE order_id = v_delivery.order_id AND quantity_remaining < total_units_needed
  ) INTO v_order_confirmed;

  v_new_order_status :=
    CASE
      WHEN v_order_fulfilled  THEN 'fulfilled'
      WHEN v_order_confirmed  THEN 'confirmed'
      ELSE 'partially_fulfilled'
    END;

  UPDATE orders SET
    status = v_new_order_status,
    updated_at = now()
  WHERE id = v_delivery.order_id;

  -- U2 (Codex P1): scope the auto-cancel to THIS delivery's own draft invoice or an
  -- order-level one (delivery_id IS NULL) — was per-order, which would cancel a
  -- SIBLING delivery's draft invoice on void of this delivery.
  UPDATE invoices SET
    status      = 'cancelled',
    void_reason = 'Auto-cancelled: delivery ' || v_delivery.delivery_number || ' was voided by admin',
    updated_at  = now()
  WHERE order_id = v_delivery.order_id AND status = 'draft'
    AND (delivery_id = p_delivery_id OR delivery_id IS NULL);

  -- U2 (Codex P1): read-only "posted invoice needs review" flag — scope it the same
  -- way so a SIBLING delivery's posted invoice (untouched by this void) no longer
  -- raises a false manual-review warning. No guard/blocking behaviour hangs off this
  -- flag, so scoping cannot loosen a safety check.
  SELECT EXISTS (
    SELECT 1 FROM invoices
    WHERE order_id = v_delivery.order_id AND status = 'posted'
      AND (delivery_id = p_delivery_id OR delivery_id IS NULL)
  ) INTO v_posted_invoices_exist;

  UPDATE deliveries SET
    status     = 'voided',
    updated_at = now()
  WHERE id = p_delivery_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, actor_role,
    old_values, new_values, description
  ) VALUES (
    'delivery_voided', 'delivery', p_delivery_id, v_actor,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('status', 'completed'),
    jsonb_build_object('status', 'voided', 'order_status', v_new_order_status),
    'Delivery ' || v_delivery.delivery_number || ' voided: ' || p_reason
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_voided',
    'Delivery ' || v_delivery.delivery_number || ' voided: ' || p_reason,
    v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  -- DELTA-IDEM BEGIN (#11: build the rich result first, then cache it via the canonical helper + replay it)
  v_result := jsonb_build_object(
    'success',                true,
    'delivery_id',            p_delivery_id,
    'delivery_number',        v_delivery.delivery_number,
    'new_order_status',       v_new_order_status,
    'posted_invoices_exist',  v_posted_invoices_exist
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'void_delivery', v_result);
  END IF;

  PERFORM set_config('app.admin_override', 'false', true);

  RETURN v_result;
  -- DELTA-IDEM END
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.void_delivery(uuid, text, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_delivery(uuid, text, uuid, text)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.save_purchase_order(p_po_id uuid, p_po_payload jsonb, p_items jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid; v_po_id uuid;
  v_is_new boolean := (p_po_id IS NULL);
  v_item jsonb; v_total_cost numeric := 0;
  v_po_number text; v_existing_status text; v_new_status text;
  v_existing_item_ids uuid[]; v_incoming_item_ids uuid[];
  v_items_to_delete uuid[]; v_existing jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Only admins or sales reps can manage purchase orders';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'save_purchase_order');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  -- Once any quantity has been received, the product, ordered quantity, unit,
  -- and cost are accounting evidence. Corrections must use the receiving
  -- reversal/adjustment workflow instead of rewriting the original PO line.
  IF NOT v_is_new THEN
    PERFORM 1 FROM purchase_orders WHERE id = p_po_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found: %', p_po_id; END IF;

    IF EXISTS (
      SELECT 1
      FROM purchase_order_items existing
      WHERE existing.purchase_order_id = p_po_id
        AND existing.quantity_received > 0
        AND (
          NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(p_items) incoming
            WHERE incoming->>'id' = existing.id::text
          )
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements(p_items) incoming
            WHERE incoming->>'id' = existing.id::text
              AND (
                incoming->>'product_id' IS DISTINCT FROM existing.product_id::text
                OR NULLIF(incoming->>'quantity_ordered', '')::numeric IS DISTINCT FROM existing.quantity_ordered
                OR NULLIF(incoming->>'unit_cost', '')::numeric IS DISTINCT FROM existing.unit_cost
                OR incoming->>'unit_size' IS DISTINCT FROM existing.unit_size
              )
          )
        )
    ) THEN
      RAISE EXCEPTION 'RECEIVED_PO_LINE_IMMUTABLE: reverse the receiving record before changing or removing a received PO line'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_total_cost := v_total_cost +
      COALESCE((v_item->>'quantity_ordered')::numeric, 0) *
      COALESCE((v_item->>'unit_cost')::numeric, 0);
  END LOOP;

  IF v_is_new THEN
    INSERT INTO purchase_orders (po_number, vendor, status, submitted_date,
      expected_delivery_date, notes, total_cost, created_by)
    VALUES (
      p_po_payload->>'po_number', p_po_payload->>'vendor',
      'draft',
      (p_po_payload->>'submitted_date')::date,
      (p_po_payload->>'expected_delivery_date')::date,
      NULLIF(p_po_payload->>'notes', ''),
      v_total_cost, v_actor
    ) RETURNING id, po_number INTO v_po_id, v_po_number;

    INSERT INTO purchase_order_items (purchase_order_id, product_id, product_name, unit_size,
      quantity_ordered, unit_cost, quantity_received, notes)
    SELECT v_po_id, (item->>'product_id')::uuid, item->>'product_name', item->>'unit_size',
      COALESCE((item->>'quantity_ordered')::numeric, 0),
      COALESCE((item->>'unit_cost')::numeric, 0), 0, NULLIF(item->>'notes', '')
    FROM jsonb_array_elements(p_items) AS item
    WHERE (item->>'product_id') IS NOT NULL;

    v_new_status := COALESCE(p_po_payload->>'status', 'draft');
    IF v_new_status <> 'draft' THEN
      UPDATE purchase_orders SET
        status = v_new_status,
        submitted_date = CASE
          WHEN v_new_status = 'submitted' THEN (now() AT TIME ZONE 'America/Chicago')::date
          ELSE submitted_date
        END,
        updated_at = now()
       WHERE id = v_po_id;
    END IF;

  ELSE
    v_po_id := p_po_id;
    SELECT po_number, status INTO v_po_number, v_existing_status FROM purchase_orders WHERE id = v_po_id;
    IF v_po_number IS NULL THEN RAISE EXCEPTION 'Purchase order not found: %', v_po_id; END IF;
    IF v_existing_status IN ('fully_received', 'cancelled') THEN
      RAISE EXCEPTION 'Cannot edit a % purchase order', v_existing_status;
    END IF;

    v_new_status := p_po_payload->>'status';
    IF v_new_status IS NOT NULL AND v_new_status <> v_existing_status THEN
      IF NOT (
        (v_existing_status = 'draft' AND v_new_status IN ('submitted', 'cancelled')) OR
        (v_existing_status = 'submitted' AND v_new_status IN ('partially_received', 'fully_received', 'cancelled')) OR
        (v_existing_status = 'partially_received' AND v_new_status IN ('fully_received', 'cancelled'))
      ) THEN
        RAISE EXCEPTION 'Invalid PO status transition: % -> %', v_existing_status, v_new_status;
      END IF;
    END IF;

    UPDATE purchase_orders SET
      vendor = COALESCE(p_po_payload->>'vendor', vendor),
      status = COALESCE(p_po_payload->>'status', status),
      submitted_date = CASE
        WHEN v_existing_status = 'draft' AND v_new_status = 'submitted'
          THEN (now() AT TIME ZONE 'America/Chicago')::date
        ELSE COALESCE((p_po_payload->>'submitted_date')::date, submitted_date)
      END,
      expected_delivery_date = COALESCE((p_po_payload->>'expected_delivery_date')::date, expected_delivery_date),
      notes = CASE WHEN p_po_payload ? 'notes' THEN NULLIF(p_po_payload->>'notes', '') ELSE notes END,
      total_cost = v_total_cost,
      updated_at = now()
    WHERE id = v_po_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found: %', v_po_id; END IF;

    SELECT ARRAY_AGG(id) INTO v_existing_item_ids
    FROM purchase_order_items WHERE purchase_order_id = v_po_id;

    SELECT ARRAY_AGG((item->>'id')::uuid) INTO v_incoming_item_ids
    FROM jsonb_array_elements(p_items) AS item WHERE item->>'id' IS NOT NULL;

    IF v_existing_item_ids IS NOT NULL THEN
      v_items_to_delete := ARRAY(
        SELECT poi.id FROM purchase_order_items poi
        WHERE poi.purchase_order_id = v_po_id
          AND (v_incoming_item_ids IS NULL OR poi.id != ALL(v_incoming_item_ids))
          AND poi.quantity_received = 0
          AND NOT EXISTS (SELECT 1 FROM receiving_records rr WHERE rr.po_item_id = poi.id)
      );
      IF array_length(v_items_to_delete, 1) > 0 THEN
        DELETE FROM purchase_order_items WHERE id = ANY(v_items_to_delete);
      END IF;
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
      IF v_item->>'id' IS NOT NULL AND (v_item->>'id')::uuid = ANY(COALESCE(v_existing_item_ids, '{}')) THEN
        UPDATE purchase_order_items SET
          product_id = (v_item->>'product_id')::uuid,
          product_name = v_item->>'product_name',
          unit_size = COALESCE(v_item->>'unit_size', unit_size),
          quantity_ordered = COALESCE((v_item->>'quantity_ordered')::numeric, quantity_ordered),
          unit_cost = COALESCE((v_item->>'unit_cost')::numeric, unit_cost),
          notes = CASE WHEN v_item ? 'notes' THEN NULLIF(v_item->>'notes', '') ELSE notes END
        WHERE id = (v_item->>'id')::uuid AND purchase_order_id = v_po_id;
      ELSE
        INSERT INTO purchase_order_items (purchase_order_id, product_id, product_name, unit_size,
          quantity_ordered, unit_cost, quantity_received, notes)
        VALUES (v_po_id, (v_item->>'product_id')::uuid, v_item->>'product_name', v_item->>'unit_size',
          COALESCE((v_item->>'quantity_ordered')::numeric, 0),
          COALESCE((v_item->>'unit_cost')::numeric, 0), 0, NULLIF(v_item->>'notes', ''));
      END IF;
    END LOOP;
  END IF;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES (
    CASE
      WHEN v_is_new THEN 'po_created'
      WHEN v_existing_status = 'draft' AND v_new_status = 'submitted' THEN 'po_submitted'
      ELSE 'po_updated'
    END,
    CASE
      WHEN v_is_new THEN 'PO ' || COALESCE(v_po_number, '') || ' created'
      WHEN v_existing_status = 'draft' AND v_new_status = 'submitted'
        THEN 'PO ' || COALESCE(v_po_number, '') || ' submitted'
      ELSE 'PO ' || COALESCE(v_po_number, '') || ' updated'
    END,
    v_actor, 'purchase_order', v_po_id
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_purchase_order',
      jsonb_build_object('status', 'saved', 'po_id', v_po_id));
  END IF;

  RETURN jsonb_build_object('status', 'saved', 'po_id', v_po_id);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.save_purchase_order(uuid, jsonb, jsonb, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_purchase_order(uuid, jsonb, jsonb, uuid, text)
  TO authenticated, service_role;

-- Submit is deliberately status-only. The detail screen may be stale because
-- another operator edited the draft in a different tab; resending the full draft
-- during submission would silently overwrite those newer values.
CREATE OR REPLACE FUNCTION public.submit_purchase_order(
  p_po_id uuid,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_status text;
  v_po_number text;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'submit_purchase_order');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT status, po_number
    INTO v_status, v_po_number
  FROM purchase_orders
  WHERE id = p_po_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'PURCHASE_ORDER_NOT_FOUND'; END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'PO_SUBMIT_REQUIRES_DRAFT: %', v_status;
  END IF;

  UPDATE purchase_orders
  SET status = 'submitted',
      submitted_date = (now() AT TIME ZONE 'America/Chicago')::date,
      updated_at = now()
  WHERE id = p_po_id;

  INSERT INTO activity_feed (
    event_type, description, performed_by, related_entity_type, related_entity_id
  ) VALUES (
    'po_submitted',
    'PO ' || COALESCE(v_po_number, '') || ' submitted',
    v_actor, 'purchase_order', p_po_id
  );

  v_result := jsonb_build_object('status', 'submitted', 'po_id', p_po_id);
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'submit_purchase_order', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.submit_purchase_order(uuid, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_purchase_order(uuid, uuid, text)
  TO authenticated, service_role;

-- PO management is an office workflow shared by active admins and sales reps.
-- Keep cancellation's existing bill/receiving guards, but align its role gate
-- with create/edit/submit and authorize before an idempotency replay.
CREATE OR REPLACE FUNCTION public.cancel_purchase_order(
  p_po_id uuid,
  p_reason text DEFAULT 'Cancelled'::text,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_po record;
  v_actor uuid;
  v_cached_result jsonb;
  v_result jsonb;
  v_received_qty numeric;
  v_active_bill_count integer;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by <> v_actor THEN
    RAISE EXCEPTION 'Actor mismatch';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: only admins or sales reps can cancel purchase orders';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'cancel_purchase_order');
    IF v_cached_result IS NOT NULL THEN RETURN v_cached_result; END IF;
  END IF;

  SELECT * INTO v_po FROM purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found'; END IF;

  IF v_po.status = 'cancelled' THEN
    v_result := jsonb_build_object('status', 'already_cancelled', 'po_id', p_po_id, 'po_number', v_po.po_number);
    IF p_idempotency_key IS NOT NULL THEN
      PERFORM save_idempotency(p_idempotency_key, 'cancel_purchase_order', v_result);
    END IF;
    RETURN v_result;
  END IF;

  SELECT count(*) INTO v_active_bill_count FROM vendor_bills
  WHERE purchase_order_id = p_po_id AND status NOT IN ('voided') AND deleted_at IS NULL;

  IF v_active_bill_count > 0 THEN
    RAISE EXCEPTION 'PO_HAS_ACTIVE_BILLS: cannot cancel PO % — % active vendor bill(s) reference it. Void the bill(s) first.',
      v_po.po_number, v_active_bill_count;
  END IF;

  SELECT COALESCE(SUM(quantity_received), 0) INTO v_received_qty
  FROM purchase_order_items WHERE purchase_order_id = p_po_id;

  IF v_received_qty > 0 THEN
    RAISE EXCEPTION 'Cannot cancel PO %: % units already received. Use partial receive workflow instead.',
      v_po.po_number, v_received_qty;
  END IF;

  IF v_po.status = 'fully_received' THEN
    RAISE EXCEPTION 'Cannot cancel PO %: already fully received', v_po.po_number;
  END IF;

  UPDATE purchase_orders SET status = 'cancelled', cancelled_at = now(),
    cancelled_by = v_actor,
    cancel_reason = COALESCE(NULLIF(TRIM(p_reason), ''), 'Cancelled'),
    updated_at = now()
  WHERE id = p_po_id;

  INSERT INTO activity_feed (
    event_type, description, performed_by, related_entity_type, related_entity_id
  ) VALUES (
    'po_cancelled',
    'Purchase order ' || v_po.po_number || ' cancelled. Reason: '
      || COALESCE(NULLIF(TRIM(p_reason), ''), 'Cancelled'),
    v_actor, 'purchase_order', p_po_id
  );

  v_result := jsonb_build_object('status', 'cancelled', 'po_id', p_po_id, 'po_number', v_po.po_number);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'cancel_purchase_order', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.cancel_purchase_order(uuid, text, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_purchase_order(uuid, text, uuid, text)
  TO authenticated, service_role;

-- RLS still controls reads. Direct client writes are removed so the invariant-
-- enforcing SECURITY DEFINER RPCs are the only authenticated mutation path.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE
  public.purchase_orders,
  public.purchase_order_items,
  public.receiving_records,
  public.vendor_bills,
  public.vendor_payments,
  public.prepay_credits,
  public.prepay_applications
FROM authenticated, anon;

DO $guard$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'public.purchase_orders', 'public.purchase_order_items', 'public.receiving_records', 'public.vendor_bills', 'public.vendor_payments', 'public.prepay_credits', 'public.prepay_applications'
  ]
  LOOP
    IF has_table_privilege('authenticated', v_table, 'INSERT')
       OR has_table_privilege('authenticated', v_table, 'UPDATE')
       OR has_table_privilege('authenticated', v_table, 'DELETE')
       OR has_table_privilege('authenticated', v_table, 'TRUNCATE') THEN
      RAISE EXCEPTION 'RPC_ONLY_GRANT_GUARD_FAILED: % still permits authenticated writes', v_table;
    END IF;
  END LOOP;
END;
$guard$;
