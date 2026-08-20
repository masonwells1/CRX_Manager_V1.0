-- 20260817120000_carry_allocated_line_cents_through_lifecycle.sql
--
-- CRX-MONEY-LIFECYCLE-001 (High). Carry the order line's ALLOCATED cents
-- through delivery invoicing and remainder cancellation.
--
-- WHY THIS EXISTS
-- Once draw-down splits a booking across price tiers, an order line's
-- total_price is deliberately NOT equal to ROUND(price_per_unit * quantity, 2).
-- It is the tier-telescoped allocation: whatever is needed so the sum of the
-- lines equals the authoritative booking, to the cent. Three lifecycle sites
-- ignored that stored total and independently re-extended price x quantity,
-- so the order said one thing and the invoice said another:
--
--   Book 0.50 units at $0.50. Draw 0.25 -> line stores $0.13. Draw the
--   remaining 0.25 -> line stores $0.12. Order total $0.25, correct.
--   Deliver both: invoicing re-extended each at $0.13 and billed $0.26.
--   Or cancel the remainder on the second: it rewrote $0.12 back to $0.13
--   and propagated the extra cent into the order header and pending
--   commissions.
--
-- The gap is not capped at a cent. A line compensating for accumulated
-- historical fractional-draw rounding can differ by more.
--
-- WHAT CHANGES
--   public._allocated_cumulative_cents  (new)  cumulative allocation for a qty
--   public._allocated_delivery_cents    (new)  telescoping per-delivery slice
--   public._complete_delivery_authorized_impl        (auto-invoice + partial rewrite)
--   public._create_invoice_for_unbilled_delivery_impl_20260718  (backfill invoice)
--   public._close_undelivered_order_remainder_20260718          (Cancel Remaining)
--
-- Both helpers are STABLE, read-only, not SECURITY DEFINER, and revoked from
-- every browser role. They are called only from the SECURITY DEFINER functions
-- above and inherit that context; they add no new reachable surface.
--
-- KNOWN, DELIBERATE NON-CHANGE
-- _enforce_below_cost_line still re-extends total_price for the four explicit
-- repricing operations (create_direct_order, bulk_import_order,
-- update_order_items, price_order). Those are a fresh pricing decision by an
-- admin editing the order, not a lifecycle step replaying an existing one, so
-- recomputing there is correct. Line cost keeps its ordinary per-line residual
-- for the same reason it does everywhere else in the app.

-- ---------------------------------------------------------------------------
-- Preconditions. Refuse to apply if any target body has drifted from the
-- source this migration was generated against.
-- ---------------------------------------------------------------------------
DO $precheck$
BEGIN
  IF md5((SELECT prosrc FROM pg_proc
           WHERE oid = 'public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamptz)'::regprocedure))
     <> 'e58470546605ad93a1fff722315d6d09' THEN
    RAISE EXCEPTION 'PRECONDITION_DRIFT: _complete_delivery_authorized_impl body is not the version this migration was generated against';
  END IF;

  IF md5((SELECT prosrc FROM pg_proc
           WHERE oid = 'public._create_invoice_for_unbilled_delivery_impl_20260718(uuid,uuid,text)'::regprocedure))
     <> '2fc0102fe8702f6c2d63c326a99c15dd' THEN
    RAISE EXCEPTION 'PRECONDITION_DRIFT: _create_invoice_for_unbilled_delivery_impl_20260718 body is not the version this migration was generated against';
  END IF;

  IF md5((SELECT prosrc FROM pg_proc
           WHERE oid = 'public._close_undelivered_order_remainder_20260718(uuid,uuid)'::regprocedure))
     <> 'e2d4b46c47be7561a8829191c30dc0a7' THEN
    RAISE EXCEPTION 'PRECONDITION_DRIFT: _close_undelivered_order_remainder_20260718 body is not the version this migration was generated against';
  END IF;
END
$precheck$;

-- ---------------------------------------------------------------------------
-- Allocation helpers.
-- ---------------------------------------------------------------------------

-- Cumulative cents allocated to the first p_cumulative_quantity units of an
-- order line, derived from the line's STORED total_price. Clamped to the
-- planned quantity so an over-delivery cannot inflate the allocation. Falls
-- back to the ordinary extension when there is no planned quantity to
-- apportion against.
CREATE OR REPLACE FUNCTION public._allocated_cumulative_cents(
  p_order_item_id uuid,
  p_cumulative_quantity numeric
)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_planned numeric;
  v_total_price numeric;
  v_price_per_unit numeric;
  v_qty numeric;
BEGIN
  SELECT oi.total_units_needed, oi.total_price, oi.price_per_unit
    INTO v_planned, v_total_price, v_price_per_unit
    FROM public.order_items oi
   WHERE oi.id = p_order_item_id;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  v_qty := GREATEST(COALESCE(p_cumulative_quantity, 0), 0);

  IF COALESCE(v_planned, 0) <= 0 THEN
    RETURN ROUND(v_qty * COALESCE(v_price_per_unit, 0) * 100)::bigint;
  END IF;

  IF v_qty > v_planned THEN
    v_qty := v_planned;
  END IF;

  RETURN ROUND(ROUND(COALESCE(v_total_price, 0) * 100) * v_qty / v_planned)::bigint;
END;
$function$;

-- Cents this delivery may bill for an order line: the cumulative allocation
-- through this delivery MINUS the cents already billed on that line's other
-- live invoices. Telescoping on cents actually billed (not on recomputed
-- units) is what makes repeated partial deliveries sum to the line total
-- exactly and stay path-independent through a void. GREATEST(...,0) refuses to
-- emit a negative line; a credit belongs in a credit memo.
CREATE OR REPLACE FUNCTION public._allocated_delivery_cents(
  p_order_item_id uuid,
  p_quantity numeric,
  p_exclude_invoice_id uuid DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_prior_qty numeric := 0;
  v_prior_cents bigint := 0;
BEGIN
  IF p_order_item_id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT COALESCE(SUM(ii.quantity), 0), COALESCE(SUM(ii.extended_cents), 0)
    INTO v_prior_qty, v_prior_cents
    FROM public.invoice_items ii
    JOIN public.invoices inv ON inv.id = ii.invoice_id
   WHERE ii.order_item_id = p_order_item_id
     AND inv.deleted_at IS NULL
     AND inv.status NOT IN ('voided', 'cancelled')
     AND (p_exclude_invoice_id IS NULL OR inv.id <> p_exclude_invoice_id);

  RETURN GREATEST(
    public._allocated_cumulative_cents(
      p_order_item_id,
      v_prior_qty + GREATEST(COALESCE(p_quantity, 0), 0)
    ) - v_prior_cents,
    0);
END;
$function$;

COMMENT ON FUNCTION public._allocated_cumulative_cents(uuid, numeric) IS
  'CRX-MONEY-LIFECYCLE-001: cumulative cents allocated to the first N units of an order line, from its stored total_price.';
COMMENT ON FUNCTION public._allocated_delivery_cents(uuid, numeric, uuid) IS
  'CRX-MONEY-LIFECYCLE-001: cents this delivery may bill, telescoped against cents already billed on the same order line.';

REVOKE ALL ON FUNCTION public._allocated_cumulative_cents(uuid, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._allocated_cumulative_cents(uuid, numeric) FROM anon;
REVOKE ALL ON FUNCTION public._allocated_cumulative_cents(uuid, numeric) FROM authenticated;
REVOKE ALL ON FUNCTION public._allocated_delivery_cents(uuid, numeric, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._allocated_delivery_cents(uuid, numeric, uuid) FROM anon;
REVOKE ALL ON FUNCTION public._allocated_delivery_cents(uuid, numeric, uuid) FROM authenticated;

-- ---------------------------------------------------------------------------
-- 1/3  Delivery completion: auto-invoice lines and the partial-completion
--      rewrite both consume the order line's allocation.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._complete_delivery_authorized_impl(p_delivery_id uuid, p_signed_by text, p_performed_by uuid DEFAULT NULL::uuid, p_quantities jsonb DEFAULT NULL::jsonb, p_issue_type text DEFAULT NULL::text, p_issue_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_completed_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
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
  -- CRX-MONEY-LIFECYCLE-001: cents allocated to THIS delivery from the order
  -- line's stored total, rather than re-extended from price x quantity.
  v_line_alloc_cents bigint := 0;
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
        extended_cents = public._allocated_delivery_cents(
                           ii.order_item_id, di.quantity_delivered, ii.invoice_id)
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
        v_line_alloc_cents := public._allocated_delivery_cents(
                                v_item.order_item_id, v_item.quantity_delivered, NULL);
        v_auto_total_cents := v_auto_total_cents + v_line_alloc_cents;
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
          v_line_alloc_cents,
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

-- ---------------------------------------------------------------------------
-- 2/3  Backfilled invoice for an already-completed delivery.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._create_invoice_for_unbilled_delivery_impl_20260718(p_delivery_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid; v_existing jsonb; v_delivery record; v_existing_count integer;
  v_invoice_id uuid; v_invoice_number text; v_total_cents bigint := 0;
  v_cost_cents bigint := 0; v_item record; v_result jsonb;
  -- CRX-MONEY-LIFECYCLE-001: see public._allocated_delivery_cents.
  v_line_alloc_cents bigint := 0;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT is_admin() THEN RAISE EXCEPTION 'Admin access required to create an invoice for a delivery'; END IF;
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'create_invoice_for_unbilled_delivery');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;
  SELECT * INTO v_delivery FROM deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery not found: %', p_delivery_id; END IF;
  IF v_delivery.status != 'completed' THEN
    RAISE EXCEPTION 'Delivery is not completed (current status: %). Only completed deliveries can be invoiced retroactively.', v_delivery.status;
  END IF;
  IF v_delivery.order_id IS NULL THEN RAISE EXCEPTION 'Delivery has no order_id — cannot auto-invoice an orphan delivery'; END IF;
  PERFORM 1 FROM orders WHERE id = v_delivery.order_id FOR UPDATE;

  -- CODE-RABBIT FIX: child allocation inserts take a KEY SHARE lock on their
  -- parent item. Lock every item in stable id order before checking OIFA rows.
  PERFORM 1
    FROM order_items
   WHERE order_id = v_delivery.order_id
   ORDER BY id
   FOR UPDATE;

  IF (SELECT COALESCE(needs_split_billing, false) FROM orders WHERE id = v_delivery.order_id)
     OR EXISTS (
       SELECT 1 FROM order_item_field_allocations oifa
       JOIN order_items oi ON oi.id = oifa.order_item_id
       WHERE oi.order_id = v_delivery.order_id
     ) THEN
    RAISE EXCEPTION 'ORDER_NEEDS_SPLIT_BILLING: delivery %''s order uses split billing — a single backfilled invoice would mono-bill it and mis-attribute AR. Create the split invoices through the split-billing flow instead.', v_delivery.delivery_number;
  END IF;

  SELECT COUNT(*) INTO v_existing_count FROM invoices
  WHERE order_id = v_delivery.order_id AND status NOT IN ('voided', 'cancelled')
    AND (delivery_id = p_delivery_id OR delivery_id IS NULL) AND deleted_at IS NULL;
  IF v_existing_count > 0 THEN
    RAISE EXCEPTION 'This delivery already has an active invoice (or an order-level invoice covers the whole order) — nothing to backfill. Find and review the existing invoice instead.';
  END IF;
  v_invoice_number := next_invoice_number('chemical_sale');
  INSERT INTO invoices (invoice_number, invoice_type, order_id, customer_id, delivery_id,
    status, invoice_date, total_amount_cents, total_cost_cents, created_by)
  VALUES (v_invoice_number, 'chemical_sale', v_delivery.order_id, v_delivery.customer_id,
    p_delivery_id, 'draft', CURRENT_DATE, 0, 0, v_actor) RETURNING id INTO v_invoice_id;
  FOR v_item IN
    SELECT di.product_id, di.quantity_delivered, di.unit_size, di.order_item_id,
      oi.price_per_unit, oi.cost_per_unit, oi.product_name AS oi_product_name, p.product_name AS p_name
    FROM delivery_items di JOIN order_items oi ON oi.id = di.order_item_id
    JOIN products p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id AND COALESCE(di.quantity_delivered, 0) > 0
  LOOP
    v_line_alloc_cents := public._allocated_delivery_cents(
                            v_item.order_item_id, v_item.quantity_delivered, NULL);
    v_total_cents := v_total_cents + v_line_alloc_cents;
    v_cost_cents := v_cost_cents + ROUND(v_item.quantity_delivered * COALESCE(v_item.cost_per_unit, 0) * 100)::bigint;
    INSERT INTO invoice_items (invoice_id, order_item_id, product_id, description,
      quantity, unit_price_cents, extended_cents, cost_cents, unit_size)
    VALUES (v_invoice_id, v_item.order_item_id, v_item.product_id,
      COALESCE(v_item.oi_product_name, v_item.p_name), v_item.quantity_delivered,
      ROUND(v_item.price_per_unit * 100)::bigint,
      v_line_alloc_cents,
      ROUND(COALESCE(v_item.cost_per_unit, 0) * 100)::bigint, v_item.unit_size);
  END LOOP;
  UPDATE invoices SET total_amount_cents = v_total_cents, total_cost_cents = v_cost_cents WHERE id = v_invoice_id;
  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description)
  VALUES ('invoice_created', 'invoice', v_invoice_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('invoice_number', v_invoice_number, 'delivery_id', p_delivery_id,
      'order_id', v_delivery.order_id, 'customer_id', v_delivery.customer_id, 'total_cents', v_total_cents),
    v_total_cents, 'Invoice ' || v_invoice_number || ' backfilled for completed delivery ' || v_delivery.delivery_number);
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_backfilled_for_delivery', 'Backfilled draft invoice ' || v_invoice_number ||
    ' for completed delivery ' || v_delivery.delivery_number, v_actor, 'invoice', v_invoice_id, v_delivery.customer_id);
  v_result := jsonb_build_object('success', true, 'delivery_id', p_delivery_id,
    'invoice_id', v_invoice_id, 'invoice_number', v_invoice_number, 'total_cents', v_total_cents);
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_invoice_for_unbilled_delivery', v_result);
  END IF;
  RETURN v_result;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3/3  Cancel Remaining: scale the allocation to the delivered portion.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._close_undelivered_order_remainder_20260718(
  p_order_id uuid,
  p_actor uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_order record;
  v_item record;
  v_draw_item record;
  v_draw_quote record;
  v_draw_fully_drawn boolean;
  v_undelivered numeric;
  v_prebooked numeric;
  v_quantity_drawn numeric;
  v_released_quantity numeric := 0;
  v_holds_released integer := 0;
  v_deliveries_cancelled integer := 0;
  v_remainders_cancelled integer := 0;
  v_commissions_recomputed integer := 0;
  v_total_profit numeric;
  v_split_total numeric;
  v_profit_cents bigint;
  v_item_snapshot jsonb;
BEGIN
  IF p_actor IS NULL OR p_actor IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = p_actor AND is_active = true AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  SELECT * INTO v_order
    FROM public.orders
   WHERE id = p_order_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;
  IF v_order.status NOT IN ('confirmed', 'partially_fulfilled') THEN
    RAISE EXCEPTION 'ORDER_REMAINDER_CLOSE_STATUS_INVALID: %', v_order.status;
  END IF;

  -- Lock/refuse the whole-order invoice immediately after the order and before
  -- commissions. void_invoice owns invoice -> commission; matching that order
  -- here prevents a close-vs-void deadlock while still serializing creation via
  -- the order lock held above.
  PERFORM 1
    FROM public.invoices
   WHERE order_id = p_order_id
     AND delivery_id IS NULL
     AND deleted_at IS NULL
     AND status NOT IN ('cancelled', 'voided')
   ORDER BY id
   FOR UPDATE;
  IF FOUND THEN
    RAISE EXCEPTION 'ORDER_LEVEL_INVOICE_ACTIVE: cancel or void the active whole-order invoice before closing the undelivered remainder';
  END IF;

  PERFORM 1 FROM public.order_items
   WHERE order_id = p_order_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.deliveries
   WHERE order_id = p_order_id AND deleted_at IS NULL ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.commissions
   WHERE order_id = p_order_id AND deleted_at IS NULL ORDER BY id FOR UPDATE;

  IF NOT EXISTS (
    SELECT 1 FROM public.order_items
     WHERE order_id = p_order_id AND COALESCE(quantity_delivered, 0) > 0
  ) THEN
    RAISE EXCEPTION 'ORDER_DELIVERY_QUANTITY_DRIFT: no delivered order-item quantity exists';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.delivery_items di
      JOIN public.deliveries d ON d.id = di.delivery_id
     WHERE d.order_id = p_order_id
       AND d.deleted_at IS NULL
       AND d.status = 'completed'
       AND (
         COALESCE(di.quantity_delivered, 0) < 0
         OR COALESCE(di.quantity_delivered, 0) > di.quantity
       )
  ) THEN
    RAISE EXCEPTION 'ORDER_DELIVERY_QUANTITY_DRIFT: completed delivery quantities must be between zero and the planned quantity';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.delivery_items di
      JOIN public.deliveries d ON d.id = di.delivery_id
      JOIN public.orders o ON o.id = d.order_id
      JOIN public.order_items oi ON oi.id = di.order_item_id
     WHERE d.order_id = p_order_id
       AND d.deleted_at IS NULL
       AND d.status = 'completed'
       AND (
         d.customer_id IS DISTINCT FROM o.customer_id
         OR oi.order_id IS DISTINCT FROM p_order_id
         OR oi.product_id IS DISTINCT FROM di.product_id
       )
  ) THEN
    RAISE EXCEPTION 'ORDER_DELIVERY_LINEAGE_INVALID: completed delivery customer, order item, and product must match the same order';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.order_items oi
      LEFT JOIN (
        SELECT di.order_item_id,
               SUM(COALESCE(di.quantity_delivered, 0)) AS completed_quantity
          FROM public.delivery_items di
          JOIN public.deliveries d ON d.id = di.delivery_id
         WHERE d.order_id = p_order_id
           AND d.deleted_at IS NULL
           AND d.status = 'completed'
         GROUP BY di.order_item_id
      ) delivered ON delivered.order_item_id = oi.id
     WHERE oi.order_id = p_order_id
       AND COALESCE(oi.quantity_delivered, 0)
             IS DISTINCT FROM COALESCE(delivered.completed_quantity, 0)
  ) THEN
    RAISE EXCEPTION 'ORDER_DELIVERY_QUANTITY_DRIFT: order-item delivered quantities do not match completed delivery-item history';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.commissions
     WHERE order_id = p_order_id AND deleted_at IS NULL AND status = 'paid'
  ) THEN
    RAISE EXCEPTION 'ORDER_COMMISSIONS_PAID_VOID_BATCH_FIRST';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.commissions c
      JOIN public.commission_payment_items cpi ON cpi.commission_id = c.id
      JOIN public.commission_payments cp ON cp.id = cpi.commission_payment_id
     WHERE c.order_id = p_order_id
       AND c.deleted_at IS NULL
       AND c.status = 'pending'
       AND cp.status <> 'voided'
  ) THEN
    RAISE EXCEPTION 'ORDER_HAS_BATCHED_COMMISSIONS';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.commissions
     WHERE order_id = p_order_id AND deleted_at IS NULL AND status <> 'pending'
  ) THEN
    RAISE EXCEPTION 'ORDER_COMMISSION_STATE_UNSAFE';
  END IF;

  -- Booking draw-down locks the quote before inventory. Match that order here
  -- so a concurrent draw and remainder close cannot deadlock.
  IF COALESCE(v_order.booking_draw, false) AND v_order.quote_id IS NULL THEN
    RAISE EXCEPTION 'BOOKING_DRAW_QUOTE_MISSING: booking-draw order % has no source quote', p_order_id;
  END IF;
  IF COALESCE(v_order.booking_draw, false) AND v_order.quote_id IS NOT NULL THEN
    SELECT * INTO v_draw_quote
      FROM public.quotes
     WHERE id = v_order.quote_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'QUOTE_NOT_FOUND: booking-draw order % references missing quote %',
        p_order_id, v_order.quote_id;
    END IF;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'order_item_id', oi.id,
           'product_id', oi.product_id,
           'before_total_units', oi.total_units_needed,
           'delivered_units', oi.quantity_delivered,
           'released_units', GREATEST(oi.total_units_needed - oi.quantity_delivered, 0)
         ) ORDER BY oi.id), '[]'::jsonb)
    INTO v_item_snapshot
    FROM public.order_items oi
   WHERE oi.order_id = p_order_id;

  PERFORM set_config('app.admin_override', 'true', true);

  UPDATE public.deliveries
     SET status = 'cancelled',
         cancelled_at = now(),
         cancelled_by = p_actor,
         cancel_reason = 'Undelivered remainder closed for order ' || v_order.order_number,
         updated_at = now()
   WHERE order_id = p_order_id
     AND deleted_at IS NULL
     AND status IN ('scheduled', 'in_progress');
  GET DIAGNOSTICS v_deliveries_cancelled = ROW_COUNT;

  UPDATE public.delivery_remainders
     SET status = 'cancelled', updated_at = now()
   WHERE order_id = p_order_id
     AND status IN ('pending', 'scheduled');
  GET DIAGNOSTICS v_remainders_cancelled = ROW_COUNT;

  FOR v_item IN
    SELECT product_id,
           SUM(GREATEST(total_units_needed - COALESCE(quantity_delivered, 0), 0)) AS qty_undelivered
      FROM public.order_items
     WHERE order_id = p_order_id
     GROUP BY product_id
     ORDER BY product_id
  LOOP
    v_undelivered := v_item.qty_undelivered;
    IF v_undelivered <= 0 THEN CONTINUE; END IF;
    v_released_quantity := v_released_quantity + v_undelivered;

    SELECT quantity_prebooked INTO v_prebooked
      FROM public.inventory
     WHERE product_id = v_item.product_id AND location = 'Main Warehouse'
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'INVENTORY_PREBOOK_ROW_MISSING: product % has no Main Warehouse inventory row', v_item.product_id;
    END IF;
    IF COALESCE(v_prebooked, 0) < v_undelivered THEN
      RAISE EXCEPTION 'INVENTORY_PREBOOK_UNDERFLOW: product % has % prebooked but % undelivered units must be released',
        v_item.product_id, COALESCE(v_prebooked, 0), v_undelivered;
    END IF;
    UPDATE public.inventory
       SET quantity_prebooked = quantity_prebooked - v_undelivered,
           updated_at = now()
     WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

    INSERT INTO public.inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      order_id, performed_by, notes
    ) VALUES (
      v_item.product_id, 'released', v_undelivered, 'Main Warehouse',
      p_order_id, p_actor,
      'Released ' || v_undelivered || ' undelivered units — order ' ||
        v_order.order_number || ' remainder closed'
    );
  END LOOP;

  IF COALESCE(v_order.booking_draw, false) AND v_order.quote_id IS NOT NULL THEN
    FOR v_draw_item IN
      SELECT product_id,
             SUM(GREATEST(total_units_needed - COALESCE(quantity_delivered, 0), 0)) AS qty_undelivered
        FROM public.order_items
       WHERE order_id = p_order_id
       GROUP BY product_id
       ORDER BY product_id
    LOOP
      IF v_draw_item.qty_undelivered <= 0 THEN CONTINUE; END IF;
      SELECT quantity_drawn INTO v_quantity_drawn
        FROM public.quote_product_draws
       WHERE quote_id = v_order.quote_id
         AND product_id = v_draw_item.product_id
       FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'QUOTE_DRAW_ROW_MISSING: quote % product % has no draw row',
          v_order.quote_id, v_draw_item.product_id;
      END IF;
      IF COALESCE(v_quantity_drawn, 0) < v_draw_item.qty_undelivered THEN
        RAISE EXCEPTION 'QUOTE_DRAW_UNDERFLOW: quote % product % has % drawn but % undelivered units must be released',
          v_order.quote_id, v_draw_item.product_id,
          COALESCE(v_quantity_drawn, 0), v_draw_item.qty_undelivered;
      END IF;
      UPDATE public.quote_product_draws
         SET quantity_drawn = quantity_drawn - v_draw_item.qty_undelivered,
             updated_at = now()
       WHERE quote_id = v_order.quote_id
         AND product_id = v_draw_item.product_id;
    END LOOP;

    IF v_draw_quote.status = 'accepted' THEN
      SELECT COALESCE(bool_and(COALESCE(d.quantity_drawn, 0) >= b.booked), true)
        INTO v_draw_fully_drawn
        FROM (
          SELECT product_id, SUM(COALESCE(total_units_needed, 0)) AS booked
            FROM public.quote_items
           WHERE quote_id = v_order.quote_id
           GROUP BY product_id
        ) b
        LEFT JOIN public.quote_product_draws d
          ON d.quote_id = v_order.quote_id AND d.product_id = b.product_id
       WHERE b.booked > 0;

      IF NOT v_draw_fully_drawn THEN
        UPDATE public.quotes SET status = 'sent', updated_at = now()
         WHERE id = v_order.quote_id;
      END IF;
    END IF;
    PERFORM public._sync_planned_holds(v_order.quote_id, p_actor);
  ELSIF v_order.quote_id IS NOT NULL THEN
    UPDATE public.inventory_holds
       SET is_active = false, updated_at = now()
     WHERE source_id = v_order.quote_id AND is_active = true;
    GET DIAGNOSTICS v_holds_released = ROW_COUNT;
  END IF;

  UPDATE public.order_items
     SET total_units_needed = quantity_delivered,
         quantity_remaining = 0,
         -- CRX-MONEY-LIFECYCLE-001: scale the line's ALLOCATED total down to
         -- the delivered portion. Re-extending price x quantity here discarded
         -- the tier allocation and pushed the difference into the order header
         -- and pending commissions.
         total_price = public._allocated_cumulative_cents(id, quantity_delivered)::numeric / 100,
         profit = public._allocated_cumulative_cents(id, quantity_delivered)::numeric / 100
                  - ROUND(COALESCE(cost_per_unit, 0) * quantity_delivered, 2),
         net_margin = CASE
           WHEN price_per_unit > 0
             THEN ROUND(((price_per_unit - COALESCE(cost_per_unit, 0)) / price_per_unit) * 100, 2)
           ELSE 0
         END
   WHERE order_id = p_order_id;

  UPDATE public.orders
     SET status = 'fulfilled', updated_at = now()
   WHERE id = p_order_id;

  -- Keep the privileged trigger bypass narrowly bracketed. Leaving this GUC
  -- enabled would let later statements in the caller's transaction bypass
  -- unrelated immutability guards.
  PERFORM set_config('app.admin_override', 'false', true);

  SELECT ROUND(total_profit, 2) INTO v_total_profit
    FROM public.orders WHERE id = p_order_id;
  SELECT COALESCE(SUM(split_percentage), 0)
    INTO v_split_total
    FROM public.commissions
   WHERE order_id = p_order_id AND deleted_at IS NULL AND status = 'pending';

  IF EXISTS (
    SELECT 1 FROM public.commissions
     WHERE order_id = p_order_id AND deleted_at IS NULL AND status = 'pending'
  ) AND (
    abs(v_split_total - 100) > 0.01
    OR EXISTS (
      SELECT 1 FROM public.commissions
       WHERE order_id = p_order_id
         AND deleted_at IS NULL
         AND status = 'pending'
         AND split_percentage < 0
    )
  ) THEN
    RAISE EXCEPTION 'COMMISSION_SPLIT_INVALID: percentages must be nonnegative and total 100.00 (actual total=%)', v_split_total;
  END IF;

  v_profit_cents := ROUND(GREATEST(COALESCE(v_total_profit, 0), 0) * 100)::bigint;
  WITH raw_allocations AS (
    SELECT c.id,
           c.split_percentage,
           (v_profit_cents::numeric * c.split_percentage / NULLIF(v_split_total, 0)) AS raw_cents
      FROM public.commissions c
     WHERE c.order_id = p_order_id
       AND c.deleted_at IS NULL
       AND c.status = 'pending'
  ), ranked AS (
    SELECT r.id,
           FLOOR(r.raw_cents)::bigint AS base_cents,
           row_number() OVER (
             ORDER BY (r.raw_cents - FLOOR(r.raw_cents)) DESC, r.id
           ) AS remainder_rank,
           SUM(FLOOR(r.raw_cents)::bigint) OVER () AS allocated_base_cents
      FROM raw_allocations r
  ), calculated AS (
    SELECT r.id,
           r.base_cents
             + CASE
                 WHEN r.remainder_rank <= v_profit_cents - r.allocated_base_cents THEN 1
                 ELSE 0
               END AS reconciled_cents
      FROM ranked r
  ), updated AS (
    UPDATE public.commissions c
       SET order_profit = COALESCE(v_total_profit, 0),
           commission_amount = calculated.reconciled_cents / 100.0
      FROM calculated
     WHERE c.id = calculated.id
     RETURNING c.id
  )
  SELECT count(*) INTO v_commissions_recomputed FROM updated;

  INSERT INTO public.financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'order_updated', 'order', p_order_id, 'admin',
    jsonb_build_object('status', v_order.status, 'items', v_item_snapshot),
    jsonb_build_object(
      'status', 'fulfilled',
      'released_quantity', v_released_quantity,
      'delivered_total_price', (SELECT total_price FROM public.orders WHERE id = p_order_id),
      'delivered_total_profit', v_total_profit,
      'commissions_recomputed', v_commissions_recomputed
    ),
    0,
    'Closed undelivered remainder for order ' || v_order.order_number ||
      '; delivered quantity remains fulfilled and billable'
  );

  INSERT INTO public.activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'order_remainder_closed',
    'Closed ' || v_released_quantity || ' undelivered unit(s) on order ' ||
      v_order.order_number || '; delivered quantity remains fulfilled',
    p_actor, 'order', p_order_id, v_order.customer_id
  );

  RETURN jsonb_build_object(
    'success', true,
    'mode', 'remainder_closed',
    'status', 'fulfilled',
    'order_number', v_order.order_number,
    'released_quantity', v_released_quantity,
    'deliveries_cancelled', v_deliveries_cancelled,
    'delivery_remainders_cancelled', v_remainders_cancelled,
    'holds_released', v_holds_released,
    'commissions_recomputed', v_commissions_recomputed,
    'commissions_cancelled', 0,
    'paid_commissions_flagged', 0,
    'draft_invoices_cancelled', 0,
    'posted_invoices_flagged', 0
  );
END;
$function$;

-- ---------------------------------------------------------------------------
-- Postconditions. Every rewritten body must actually reach the allocator, and
-- no lifecycle body may still re-extend price x quantity for revenue.
-- ---------------------------------------------------------------------------
DO $postcheck$
DECLARE
  v_sig text;
  v_src text;
  v_sigs constant text[] := ARRAY[
    'public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamptz)',
    'public._create_invoice_for_unbilled_delivery_impl_20260718(uuid,uuid,text)',
    'public._close_undelivered_order_remainder_20260718(uuid,uuid)'
  ];
BEGIN
  FOREACH v_sig IN ARRAY v_sigs LOOP
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_sig::regprocedure;
    IF v_src IS NULL OR length(v_src) = 0 THEN
      RAISE EXCEPTION 'POSTCONDITION: % has no readable body', v_sig;
    END IF;
    IF v_src NOT LIKE '%_allocated_%_cents(%' THEN
      RAISE EXCEPTION 'POSTCONDITION: % does not call the allocation helper', v_sig;
    END IF;
  END LOOP;

  -- The revenue re-extension is gone from all three. (Cost keeps its ordinary
  -- per-line residual, so cost_per_unit extensions are expected to remain.)
  FOREACH v_sig IN ARRAY v_sigs LOOP
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_sig::regprocedure;
    IF v_src LIKE '%quantity_delivered * ' || 'v_item.price_per_unit%'
       OR v_src LIKE '%ROUND(price_per_unit * ' || 'quantity_delivered, 2)%'
       OR v_src LIKE '%di.quantity_delivered * ' || 'ii.unit_price_cents%' THEN
      RAISE EXCEPTION 'POSTCONDITION: % still re-extends revenue from price x quantity', v_sig;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = '_allocated_cumulative_cents' AND p.provolatile = 's'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION: _allocated_cumulative_cents is not STABLE';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('_allocated_cumulative_cents', '_allocated_delivery_cents')
       AND (p.prosecdef OR has_function_privilege('anon', p.oid, 'EXECUTE')
                        OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION: allocation helper is SECURITY DEFINER or reachable by a browser role';
  END IF;
END
$postcheck$;
