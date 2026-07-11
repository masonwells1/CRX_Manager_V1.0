-- =====================================================================================
-- U2 — partial-delivery billing leak fix (findings #34 + #39)
-- Re-emits public.complete_delivery(uuid,text,uuid,jsonb,text,text,text) — SINGLE overload.
-- Byte-identical to the LIVE definition EXCEPT the two surgical changes below.
--
-- CHANGE 1 (#34 — billing leak): the auto-invoice guard was PER-ORDER —
--     WHERE order_id = v_delivery.order_id AND status NOT IN ('voided','cancelled')
--   so once ANY active invoice existed on the order, a *follow-up* delivery of the
--   shorted product was never billed. It is now PER-DELIVERY-AWARE:
--     WHERE order_id = v_delivery.order_id
--       AND status NOT IN ('voided','cancelled')
--       AND (delivery_id = p_delivery_id OR delivery_id IS NULL)
--   Rationale (double-bill safety): the auto-invoice bills only THIS delivery's
--   delivered items (delivery_items WHERE delivery_id = p_delivery_id). Two deliveries'
--   auto-invoices never overlap, so an invoice tied to a DIFFERENT delivery must not
--   block this one — that is the leak. But an ORDER-LEVEL invoice (delivery_id IS NULL,
--   e.g. create_invoice_from_order / create_split_invoices_from_order / manual save_invoice)
--   bills the whole order and DOES cover this delivery's items, so it must still block
--   (else double-bill). Keeping the delivery_id IS NULL arm preserves the old conservative
--   behaviour for order-level invoices while releasing only the delivery-specific block.
--   A re-run on the same delivery is still blocked by delivery_id = p_delivery_id.
--
-- CHANGE 2 (#39 — remainder never closed): when a follow-up delivery COMPLETES, the
--   delivery_remainders rows it was created to satisfy (create_followup_delivery flipped
--   them 'pending'->'scheduled' and stamped followup_delivery_id) were left 'scheduled'
--   forever. We now flip them to 'fulfilled'. If this follow-up itself shorted some lines,
--   those still-outstanding quantities are already captured as FRESH remainder rows by the
--   existing v_any_partial INSERT (original_delivery_id = this delivery, followup_delivery_id
--   NULL, status 'pending'). Flipping the old 'scheduled' rows therefore never loses
--   quantity; it prevents the same shortfall being double-counted as both a stale
--   'scheduled' row and a new 'pending' row. 'fulfilled' is an existing status CHECK value
--   and matches cancel_delivery's use of 'fulfilled' = "remainder record closed/superseded".
--
-- Preserved verbatim: SECURITY DEFINER, SET search_path, auth.uid()/actor gate,
--   idempotency (check_idempotency/save_idempotency), closed-period warning, inventory
--   math, partial true-up, financial_audit_log provenance.
-- =====================================================================================

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
    IF NOT FOUND OR COALESCE(v_inv.quantity_available, 0) < v_qty_to_deliver THEN
      RAISE EXCEPTION 'Insufficient inventory for %: need % units, only % on-hand',
        v_item.product_name, v_qty_to_deliver, COALESCE(v_inv.quantity_available, 0);
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

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, from_location,
      order_id, delivery_id, performed_by, notes
    ) VALUES (
      v_item.product_id, 'delivered', v_qty_to_deliver, 'Main Warehouse',
      v_delivery.order_id, p_delivery_id, v_actor,
      'Delivery ' || v_delivery.delivery_number ||
        CASE WHEN v_qty_to_deliver < v_item.quantity
          THEN ' (partial: ' || v_qty_to_deliver || '/' || v_item.quantity || ')'
          ELSE '' END || '. Signed by: ' || p_signed_by
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

  v_result := jsonb_build_object(
    'status', CASE WHEN v_any_partial THEN 'partial' ELSE 'completed' END,
    'delivery_id', p_delivery_id,
    'order_fulfilled', v_all_delivered,
    'auto_invoice', CASE
      WHEN v_auto_invoice_id IS NOT NULL THEN
        jsonb_build_object('invoice_id', v_auto_invoice_id, 'invoice_number', v_auto_invoice_number, 'total_cents', v_auto_total_cents)
      ELSE NULL
    END
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'complete_delivery', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- ---------------------------------------------------------------------------
-- CHANGE 3 (Codex U2 P2): create_invoice_for_unbilled_delivery — the Integrity
-- Cleanup backfill button — kept the OLD per-order guard, so the follow-up
-- deliveries the finder now surfaces would error on click ("Order already has
-- an active invoice"). Re-emitted byte-identical to live (read 2026-07-05)
-- except the SAME delivery-aware predicate as complete_delivery's auto-invoice
-- guard, plus the matching error message.
-- ---------------------------------------------------------------------------
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
    AND (delivery_id = p_delivery_id OR delivery_id IS NULL);

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

-- ---------------------------------------------------------------------------
-- CHANGE 4 (Codex U2 P1): delivery REVERSAL paths were still per-ORDER, so with
-- multiple active delivery-specific invoices now possible on one order, cancelling
-- or voiding ONE delivery could cancel or flag a SIBLING delivery's invoice.
-- Re-emitted byte-identical to live (read 2026-07-05) EXCEPT each invoice-touching
-- statement is scoped to THIS delivery's own invoice or an ORDER-LEVEL invoice
-- (delivery_id IS NULL) — mirroring complete_delivery's per-delivery-aware guard.
-- Order-level invoices keep EXACTLY today's behaviour (the delivery_id IS NULL arm);
-- only the sibling-delivery blast radius is removed.
--
-- cancel_delivery: the one invoice loop that cancels this delivery's draft/unposted
--   invoices and notifies admins about posted ones is scoped by the SAME predicate,
--   so a sibling's draft is no longer auto-cancelled and a sibling's posted invoice
--   no longer raises a false "posted invoice needs review" alert.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_delivery(p_delivery_id uuid, p_cancel_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_delivery record; v_actor uuid; v_item record; v_items_restored integer := 0;
  v_prebooked_reincremented integer := 0; v_invoice record; v_draft_cancelled integer := 0;
  v_posted_notified integer := 0; v_admin record; v_order_has_remaining boolean; v_order_status text;
  v_result jsonb;
  v_quick_scheduled_exclusive boolean := false; v_prebooked_released integer := 0;
  v_qd_item record; v_release_qty numeric; v_actor_role text; v_paid_commissions integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF p_performed_by IS NOT NULL AND auth.uid() IS DISTINCT FROM p_performed_by THEN RAISE EXCEPTION 'actor mismatch'; END IF;
  v_actor := COALESCE(p_performed_by, auth.uid());

  IF p_idempotency_key IS NOT NULL THEN
    DECLARE v_cached jsonb;
    BEGIN v_cached := check_idempotency(p_idempotency_key, 'cancel_delivery'); IF v_cached IS NOT NULL THEN RETURN v_cached; END IF; END;
  END IF;

  SELECT * INTO v_delivery FROM deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery not found'; END IF;
  IF v_delivery.status NOT IN ('scheduled', 'in_progress', 'completed') THEN RAISE EXCEPTION 'Cannot cancel a % delivery', v_delivery.status; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN RAISE EXCEPTION 'Not authorized to cancel deliveries'; END IF;

  PERFORM set_config('app.admin_override', 'true', true);

  IF v_delivery.status IN ('completed', 'in_progress') THEN
    FOR v_item IN SELECT di.*, p.product_name FROM delivery_items di JOIN products p ON p.id = di.product_id WHERE di.delivery_id = p_delivery_id
    LOOP
      IF COALESCE(v_item.quantity_delivered, 0) > 0 THEN
        UPDATE inventory SET quantity_available = quantity_available + v_item.quantity_delivered, quantity_prebooked = quantity_prebooked + v_item.quantity_delivered, updated_at = now() WHERE product_id = v_item.product_id AND location = 'Main Warehouse';
        INSERT INTO inventory_transactions (product_id, transaction_type, quantity, to_location, order_id, delivery_id, performed_by, notes)
        VALUES (v_item.product_id, 'cancelled_delivery_reversal', v_item.quantity_delivered, 'Main Warehouse', v_delivery.order_id, p_delivery_id, v_actor, 'Delivery ' || v_delivery.delivery_number || ' cancelled — restored ' || v_item.quantity_delivered || ' units of ' || v_item.product_name);
        UPDATE order_items SET quantity_delivered = GREATEST(quantity_delivered - v_item.quantity_delivered, 0), quantity_remaining = quantity_remaining + v_item.quantity_delivered WHERE id = v_item.order_item_id;
        v_items_restored := v_items_restored + 1;
      END IF;
    END LOOP;
  END IF;

  IF v_delivery.order_id IS NOT NULL THEN
    -- Codex P2 (20260616171449): lock the order row so a concurrent update_order_items
    -- (which holds orders FOR UPDATE) cannot add/increase prebook in the window between
    -- the release loop and the order cancel. cancel_order locks the order the same way.
    SELECT status INTO v_order_status FROM orders WHERE id = v_delivery.order_id FOR UPDATE;

    IF COALESCE(v_delivery.is_quick_delivery, false) AND v_delivery.status IN ('scheduled', 'in_progress') THEN
      SELECT NOT EXISTS (
        SELECT 1 FROM deliveries
        WHERE order_id = v_delivery.order_id AND id <> p_delivery_id
          AND status NOT IN ('cancelled', 'voided')
      ) INTO v_quick_scheduled_exclusive;
    END IF;

    IF v_order_status IS NOT NULL AND v_order_status NOT IN ('cancelled', 'voided') THEN
      IF v_quick_scheduled_exclusive THEN
        -- Commission batch-freeze guard (overnight bug-hunt HIGH, 20260620): this branch
        -- auto-cancels the order and zeroes its pending commissions. A pending commission
        -- already committed to a non-voided commission_payments batch must not be silently
        -- cancelled — post_commission_payment would later resurrect it to 'paid'. Force the
        -- admin to void the payout first.
        IF EXISTS (
          SELECT 1
          FROM commissions cm
          JOIN commission_payment_items cpi ON cpi.commission_id = cm.id
          JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
          WHERE cm.order_id = v_delivery.order_id
            AND cm.status = 'pending'
            AND cp.status <> 'voided'
        ) THEN
          RAISE EXCEPTION 'ORDER_HAS_BATCHED_COMMISSIONS: the order auto-cancelled by this quick delivery has pending commission(s) committed to an active commission payment batch. Void that payment first.';
        END IF;
        -- P2-1: release by ORDER_ITEMS (the booking source of truth) so edited/added quantities prebooked via
        -- update_order_items (which never touches delivery_items) are released too. Mirrors cancel_order.
        FOR v_qd_item IN SELECT product_id, total_units_needed, COALESCE(quantity_delivered, 0) AS quantity_delivered FROM order_items WHERE order_id = v_delivery.order_id
        LOOP
          v_release_qty := GREATEST(v_qd_item.total_units_needed - v_qd_item.quantity_delivered, 0);
          IF v_release_qty <= 0 THEN CONTINUE; END IF;
          UPDATE inventory SET quantity_prebooked = GREATEST(quantity_prebooked - v_release_qty, 0), updated_at = now() WHERE product_id = v_qd_item.product_id AND location = 'Main Warehouse';
          INSERT INTO inventory_transactions (product_id, transaction_type, quantity, to_location, order_id, delivery_id, performed_by, notes)
          VALUES (v_qd_item.product_id, 'released', v_release_qty, 'Main Warehouse', v_delivery.order_id, p_delivery_id, v_actor, 'Released ' || v_release_qty || ' units — quick delivery ' || v_delivery.delivery_number || ' cancelled');
          v_prebooked_released := v_prebooked_released + 1;
        END LOOP;

        UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = v_delivery.order_id;
        UPDATE commissions SET status = 'cancelled', commission_amount = 0 WHERE order_id = v_delivery.order_id AND status = 'pending';

        -- P2-2: a quick order may have already-paid commissions — flag for admin review (mirror cancel_order).
        SELECT COUNT(*) INTO v_paid_commissions FROM commissions WHERE order_id = v_delivery.order_id AND status = 'paid';
        IF v_paid_commissions > 0 THEN
          FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true LOOP
            INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
            VALUES (v_admin.id, 'Cancelled Order Has Paid Commissions',
              'Quick-delivery order auto-cancelled with delivery ' || v_delivery.delivery_number || ' has ' || v_paid_commissions || ' paid commission(s). Manual review required.',
              'cancellation_review', 'order', v_delivery.order_id);
          END LOOP;
        END IF;

        SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor;
        INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, old_values, new_values, total_impact_cents, description)
        VALUES ('order_cancelled', 'order', v_delivery.order_id, COALESCE(v_actor_role, 'sales_rep'),
          jsonb_build_object('status', v_order_status),
          jsonb_build_object('status', 'cancelled', 'reason', 'Quick delivery ' || v_delivery.delivery_number || ' cancelled', 'prebook_lines_released', v_prebooked_released, 'paid_commissions_flagged', v_paid_commissions),
          0,
          'Auto-cancelled quick-delivery order on cancellation of delivery ' || v_delivery.delivery_number);
      ELSE
        SELECT EXISTS (SELECT 1 FROM order_items WHERE order_id = v_delivery.order_id AND quantity_remaining > 0) INTO v_order_has_remaining;
        IF v_order_has_remaining THEN
          IF EXISTS (SELECT 1 FROM order_items WHERE order_id = v_delivery.order_id AND quantity_delivered > 0) THEN
            UPDATE orders SET status = 'partially_fulfilled', updated_at = now() WHERE id = v_delivery.order_id;
          ELSE
            UPDATE orders SET status = 'confirmed', updated_at = now() WHERE id = v_delivery.order_id;
          END IF;
        END IF;
      END IF;
    END IF;
    UPDATE delivery_remainders SET status = 'cancelled', updated_at = now() WHERE original_delivery_id = p_delivery_id AND status = 'pending' AND followup_delivery_id IS NULL;
    UPDATE delivery_remainders SET status = 'fulfilled', updated_at = now() WHERE original_delivery_id = p_delivery_id AND status IN ('pending', 'scheduled') AND followup_delivery_id IS NOT NULL;
  END IF;

  UPDATE deliveries SET status = 'cancelled', cancelled_at = now(), cancelled_by = v_actor, cancel_reason = p_cancel_reason, updated_at = now() WHERE id = p_delivery_id;

  IF v_delivery.order_id IS NOT NULL THEN
    -- U2 (Codex P1): scope the invoice reversal to THIS delivery's own invoice or an
    -- order-level one (delivery_id IS NULL) — NEVER a sibling delivery's invoice. Was
    -- an unscoped per-order loop, which with per-delivery invoices would auto-cancel a
    -- sibling's draft/unposted invoice and raise a false posted-invoice review alert.
    FOR v_invoice IN SELECT * FROM invoices WHERE order_id = v_delivery.order_id AND status IN ('draft', 'posted', 'unposted') AND deleted_at IS NULL AND (delivery_id = p_delivery_id OR delivery_id IS NULL)
    LOOP
      IF v_invoice.status IN ('draft', 'unposted') THEN
        UPDATE invoices SET status = 'cancelled', voided_by = v_actor, void_reason = 'Auto-cancelled: delivery ' || v_delivery.delivery_number || ' cancelled', updated_at = now() WHERE id = v_invoice.id;
        v_draft_cancelled := v_draft_cancelled + 1;
      ELSIF v_invoice.status = 'posted' THEN
        FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true LOOP
          INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id) VALUES (v_admin.id, 'Posted Invoice Needs Review', 'Delivery ' || v_delivery.delivery_number || ' cancelled but invoice ' || v_invoice.invoice_number || ' is posted.', 'invoice_review', 'invoice', v_invoice.id);
        END LOOP;
        v_posted_notified := v_posted_notified + 1;
      END IF;
    END LOOP;
  END IF;

  IF v_delivery.assigned_driver IS NOT NULL THEN
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id) VALUES (v_delivery.assigned_driver, 'Delivery Cancelled', 'Delivery ' || v_delivery.delivery_number || ' cancelled. Reason: ' || p_cancel_reason, 'delivery_update', 'delivery', p_delivery_id);
  END IF;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('delivery_cancelled', 'Delivery ' || v_delivery.delivery_number || ' cancelled. Reason: ' || p_cancel_reason || CASE WHEN v_items_restored > 0 THEN '. Restored ' || v_items_restored || ' items.' ELSE '' END, v_actor, 'delivery', p_delivery_id, v_delivery.customer_id);

  PERFORM set_config('app.admin_override', 'false', true);

  v_result := jsonb_build_object('success', true, 'delivery_id', p_delivery_id, 'items_restored', v_items_restored, 'prebooked_reincremented', v_prebooked_reincremented, 'prebooked_released', v_prebooked_released, 'paid_commissions_flagged', v_paid_commissions, 'draft_invoices_cancelled', v_draft_cancelled, 'posted_invoices_flagged', v_posted_notified);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'cancel_delivery', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- ---------------------------------------------------------------------------
-- CHANGE 5 (Codex U2 P1): void_delivery — same fix. Two invoice-touching
-- statements were per-ORDER; both are now scoped to (delivery_id = p_delivery_id
-- OR delivery_id IS NULL):
--   (a) the UPDATE that auto-cancels draft invoices — was cancelling a SIBLING
--       delivery's draft on void of this delivery.
--   (b) the v_posted_invoices_exist EXISTS flag (returned to the UI as a
--       "posted invoices linked to this order require manual review" warning) —
--       was raising a false alarm on a sibling's posted invoice. It is a
--       read-only informational flag with no guard/blocking behaviour
--       (DeliveryDetail.tsx:583 only shows a toast), so scoping it cannot loosen
--       any safety check; a sibling's posted invoice is genuinely untouched by
--       this void, so flagging it was misleading.
-- Everything else (order-status rollup from order_items, inventory restore,
-- remainder delete, audit log) is left EXACTLY as live.
-- ---------------------------------------------------------------------------
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

  IF (SELECT role FROM profiles WHERE id = v_actor) != 'admin' THEN
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
        ' voided for date ' || v_delivery.scheduled_date::text ||
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
          ' was voided for scheduled date ' || v_delivery.scheduled_date::text ||
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

-- ---------------------------------------------------------------------------
-- Single-overload assertion: all four re-emitted functions must have exactly ONE
-- signature each.
-- ---------------------------------------------------------------------------
DO $assert$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.proname, count(*) AS n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('complete_delivery', 'create_invoice_for_unbilled_delivery', 'cancel_delivery', 'void_delivery')
    GROUP BY p.proname
  LOOP
    IF r.n <> 1 THEN
      RAISE EXCEPTION '% overload check failed: expected 1, found %', r.proname, r.n;
    END IF;
  END LOOP;
END;
$assert$;
