-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Nightly Debug Mission · Large-RPC pass #2 (PARKED-05 + update_order_items) ║
-- ║ 2026-06-16 · PAIRED change — must ship together (gate-deferred otherwise)  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- WHY THIS IS ONE MIGRATION (two functions):
--   PARKED-05 broadens _enforce_delivery_items_parent_lock so delivery_items are
--   locked on ANY non-scheduled parent delivery (today only 'in_progress' /
--   'completed' are blocked; 'cancelled' / 'voided' were left writable — a
--   sales_rep could INSERT/DELETE items on a cancelled/voided delivery straight
--   through PostgREST/RLS and corrupt the historical record). BUT update_order_items
--   contains a sanctioned cleanup DELETE of orphaned delivery_items belonging to
--   already-cancelled/voided deliveries, run WITHOUT app.admin_override. Broadening
--   the lock alone would make that DELETE raise DELIVERY_ITEMS_LOCKED and crash the
--   whole "edit order items" feature. The apply gate proved exactly this regression,
--   so the two changes are paired: bracket that one DELETE in app.admin_override
--   (the same override complete_delivery / void_delivery already use), THEN broaden.
--
-- CROSS-FUNCTION SAFETY (verified live, project rhyzpcqhnizqbxphqdkr, 2026-06-16):
--   Every function that writes delivery_items was scanned. Only these write them:
--     - create_delivery_with_items → INSERTs onto a NEW delivery it creates as
--                                    status='scheduled'                 → unaffected
--     - create_followup_delivery  → INSERTs onto a NEW delivery it creates as
--                                    status='scheduled'                 → unaffected
--     - create_quick_delivery     → INSERTs onto a NEW delivery it creates as
--                                    status='scheduled'                 → unaffected
--     - edit_delivery             → INSERT/DELETE only inside its
--                                    `v_delivery.status = 'scheduled'` branch
--                                    (explicitly rejects in_progress item edits) → unaffected
--     - complete_delivery         → UPDATE under app.admin_override     → unaffected
--     - update_order_items        → DELETE on cancelled/voided deliveries → BRACKETED here
--   So the only sanctioned non-scheduled delivery_items write is the one fixed below.
--
-- DEFERRED (update_order_items LOW + Codex P2, 2026-06-16): recomputing
--   orders.total_profit / total_margin_pct on an item edit is intentionally NOT
--   bundled here. Codex flagged that updating the order header's profit without
--   also updating the denormalized commissions rows (commissions.order_profit /
--   commission_amount, plus the paid-vs-pending distinction) would make commission
--   reports/payouts disagree with the order header. Today neither is updated on an
--   edit, so they stay mutually consistent; fixing the order profit alone would
--   break that. The profit recompute + its commission-aware counterpart are
--   deferred to a separate, properly-scoped change. THIS migration = security
--   pairing only (override bracket + lock broadening); update_order_items therefore
--   differs from its live definition by ONLY the admin_override bracket.
--
-- FIDELITY: both functions are reproduced verbatim from their live source
--   definitions; the ONLY changes are the labelled BEGIN/END blocks below and the
--   two broadened status checks in the trigger.
--
-- ROLLBACK: re-apply the prior definitions — the two trigger checks back to
--   `IN ('in_progress', 'completed')`, and update_order_items without the override
--   bracket / profit-margin recompute (single migration revert).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) update_order_items: bracket the cancelled/voided cleanup DELETE in the
--    admin override (this is its ONLY change vs the live definition). The
--    total_profit / total_margin_pct recompute is deferred — see header note.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_order_items(p_order_id uuid, p_items jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid; v_order record; v_old_item record; v_item jsonb; v_qty_diff numeric; v_new_total numeric;
  v_result jsonb; v_passed_ids uuid[]; v_new_item_id uuid; v_product record; v_new_qty numeric;
  v_new_price numeric; v_new_cost numeric; v_new_items_added integer := 0; v_new_product_id uuid;
  v_old_remaining numeric; v_blocking_table text; v_existing jsonb;
BEGIN
  -- Strict actor pattern (codex audit F2)
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found: %', p_order_id; END IF;
  IF v_order.status NOT IN ('confirmed', 'pending') THEN
    RAISE EXCEPTION 'Cannot edit order in status: %', v_order.status;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'Not authorized to update order items';
  END IF;

  -- BEGIN active-actor guard (20260611120000)
  -- rls-review L2 (2026-06-11): the verbatim role gate above lacks
  -- is_active, so a deactivated admin/sales_rep session could still edit
  -- items. Canonical strict-actor blocks require is_active = true.
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;
  -- END active-actor guard (20260611120000)

  -- BEGIN draw-order lock guard (20260611120000)
  -- Codex round-2 HIGH (2026-06-11): a draw-created order mirrors
  -- quote_product_draws (the booking ledger). Editing its items here would
  -- desync order vs ledger (e.g. draw 200, edit to 300: the ledger still says
  -- 200 and permits the same 100 to be drawn again). The sanctioned paths are
  -- void_order / cancel_order — both reverse the ledger (20260610185806) —
  -- then draw again at the corrected quantities.
  IF v_order.booking_draw THEN
    RAISE EXCEPTION 'BOOKING_DRAW_ORDER_LOCKED: order % was created by a booking draw-down — its items mirror the booking ledger. Void or cancel the order to return quantity to the booking, then draw again', v_order.order_number;
  END IF;
  -- END draw-order lock guard (20260611120000)

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'update_order_items');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT array_agg((el->>'id')::uuid) INTO v_passed_ids
    FROM jsonb_array_elements(p_items) el WHERE (el->>'id') IS NOT NULL;

  FOR v_old_item IN SELECT oi.* FROM order_items oi
    WHERE oi.order_id = p_order_id AND (v_passed_ids IS NULL OR oi.id != ALL(v_passed_ids))
  LOOP
    IF v_old_item.quantity_delivered > 0 THEN
      RAISE EXCEPTION 'Cannot remove "%" — % unit(s) have already been delivered. Edit the quantity instead.',
        v_old_item.product_name, v_old_item.quantity_delivered;
    END IF;

    IF EXISTS (SELECT 1 FROM delivery_items di JOIN deliveries d ON d.id = di.delivery_id
       WHERE di.order_item_id = v_old_item.id AND d.status NOT IN ('cancelled', 'voided') LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot remove "%" — it is linked to an active delivery. Remove it from the delivery first.', v_old_item.product_name;
    END IF;

    -- BEGIN delivery-item lock pairing (20260616220000)
    -- This migration broadens _enforce_delivery_items_parent_lock to block
    -- delivery_items writes on ANY non-scheduled parent (incl. cancelled/voided).
    -- This cleanup of orphaned items on already-cancelled/voided deliveries is a
    -- sanctioned housekeeping write, so it brackets app.admin_override exactly
    -- like complete_delivery / void_delivery. Transaction-local; reset right after.
    PERFORM set_config('app.admin_override', 'true', true);
    DELETE FROM delivery_items WHERE order_item_id = v_old_item.id
      AND delivery_id IN (SELECT id FROM deliveries WHERE status IN ('cancelled', 'voided'));
    PERFORM set_config('app.admin_override', 'false', true);
    -- END delivery-item lock pairing (20260616220000)

    IF EXISTS (SELECT 1 FROM return_items ri JOIN returns r ON r.id = ri.return_id
       WHERE ri.order_item_id = v_old_item.id AND r.status NOT IN ('cancelled', 'rejected') LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot remove "%" — it is linked to a return/RMA. Process or cancel the return first.', v_old_item.product_name;
    END IF;

    UPDATE return_items SET order_item_id = NULL WHERE order_item_id = v_old_item.id
      AND return_id IN (SELECT id FROM returns WHERE status IN ('cancelled', 'rejected'));

    DELETE FROM delivery_remainders WHERE order_item_id = v_old_item.id
      AND (status IN ('resolved', 'cancelled')
           OR original_delivery_id IN (SELECT id FROM deliveries WHERE status IN ('cancelled', 'voided')));

    IF EXISTS (SELECT 1 FROM delivery_remainders WHERE order_item_id = v_old_item.id LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot remove "%" — it has active delivery remainder records. Resolve or cancel them first.', v_old_item.product_name;
    END IF;

    DELETE FROM order_line_allocations WHERE order_item_id = v_old_item.id;

    IF EXISTS (SELECT 1 FROM invoice_items ii JOIN invoices inv ON inv.id = ii.invoice_id
       WHERE ii.order_item_id = v_old_item.id AND inv.status NOT IN ('draft', 'voided', 'cancelled') LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot remove "%" — it is linked to a posted or paid invoice. Void the invoice first.', v_old_item.product_name;
    END IF;

    UPDATE invoice_items SET order_item_id = NULL WHERE order_item_id = v_old_item.id
      AND invoice_id IN (SELECT id FROM invoices WHERE status IN ('draft', 'voided', 'cancelled'));

    IF v_old_item.quantity_remaining > 0 THEN
      UPDATE inventory SET quantity_prebooked = GREATEST(quantity_prebooked - v_old_item.quantity_remaining, 0), updated_at = now()
        WHERE product_id = v_old_item.product_id AND location = 'Main Warehouse';
      INSERT INTO inventory_transactions (product_id, transaction_type, quantity, order_id, performed_by, notes)
      VALUES (v_old_item.product_id, 'released', v_old_item.quantity_remaining, p_order_id, v_actor,
        'Order edit: item removed from ' || v_order.order_number);
    END IF;

    DELETE FROM order_items WHERE id = v_old_item.id;
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF (v_item->>'id') IS NOT NULL THEN
      SELECT * INTO v_old_item FROM order_items WHERE id = (v_item->>'id')::uuid;
      IF NOT FOUND THEN CONTINUE; END IF;

      v_new_product_id := COALESCE((v_item->>'product_id')::uuid, v_old_item.product_id);
      v_qty_diff := (v_item->>'total_units_needed')::numeric - v_old_item.total_units_needed;

      IF v_new_product_id IS DISTINCT FROM v_old_item.product_id THEN
        v_old_remaining := GREATEST(v_old_item.total_units_needed - v_old_item.quantity_delivered, 0);
        IF v_old_remaining > 0 THEN
          UPDATE inventory SET quantity_prebooked = GREATEST(quantity_prebooked - v_old_remaining, 0), updated_at = now()
          WHERE product_id = v_old_item.product_id AND location = 'Main Warehouse';
          INSERT INTO inventory_transactions (product_id, transaction_type, quantity, order_id, performed_by, notes)
          VALUES (v_old_item.product_id, 'released', v_old_remaining, p_order_id, v_actor,
            'Order edit: product swapped from ' || v_old_item.product_name || ' on ' || v_order.order_number);
        END IF;

        v_new_qty := (v_item->>'total_units_needed')::numeric;
        IF v_new_qty > 0 THEN
          UPDATE inventory SET quantity_prebooked = quantity_prebooked + v_new_qty, updated_at = now()
          WHERE product_id = v_new_product_id AND location = 'Main Warehouse';
          INSERT INTO inventory_transactions (product_id, transaction_type, quantity, order_id, performed_by, notes)
          VALUES (v_new_product_id, 'prebooked', v_new_qty, p_order_id, v_actor,
            'Order edit: product swapped to ' || COALESCE(v_item->>'product_name', '') || ' on ' || v_order.order_number);
        END IF;

        v_new_cost := COALESCE((v_item->>'cost_per_unit')::numeric, 0);
        IF v_new_cost = 0 THEN
          SELECT current_cost INTO v_new_cost FROM products WHERE id = v_new_product_id;
          v_new_cost := COALESCE(v_new_cost, 0);
        END IF;

        UPDATE order_items SET
          product_id = v_new_product_id,
          product_name = COALESCE(v_item->>'product_name', product_name),
          unit_size = COALESCE(v_item->>'unit_size', unit_size),
          cost_per_unit = v_new_cost,
          price_per_unit = (v_item->>'price_per_unit')::numeric,
          total_units_needed = (v_item->>'total_units_needed')::numeric,
          quantity_remaining = GREATEST((v_item->>'total_units_needed')::numeric - v_old_item.quantity_delivered, 0),
          total_price = (v_item->>'price_per_unit')::numeric * (v_item->>'total_units_needed')::numeric,
          profit = ((v_item->>'price_per_unit')::numeric - v_new_cost) * (v_item->>'total_units_needed')::numeric,
          net_margin = CASE WHEN (v_item->>'price_per_unit')::numeric > 0
            THEN ROUND((((v_item->>'price_per_unit')::numeric - v_new_cost) / (v_item->>'price_per_unit')::numeric) * 100, 2)
            ELSE 0 END
        WHERE id = v_old_item.id;
      ELSE
        UPDATE order_items SET
          product_name = COALESCE(v_item->>'product_name', product_name),
          price_per_unit = (v_item->>'price_per_unit')::numeric,
          total_units_needed = (v_item->>'total_units_needed')::numeric,
          quantity_remaining = GREATEST((v_item->>'total_units_needed')::numeric - v_old_item.quantity_delivered, 0),
          total_price = (v_item->>'price_per_unit')::numeric * (v_item->>'total_units_needed')::numeric
        WHERE id = v_old_item.id;

        IF v_qty_diff <> 0 THEN
          UPDATE inventory SET quantity_prebooked = GREATEST(quantity_prebooked + v_qty_diff, 0), updated_at = now()
          WHERE product_id = v_old_item.product_id AND location = 'Main Warehouse';
          INSERT INTO inventory_transactions (product_id, transaction_type, quantity, order_id, performed_by, notes)
          VALUES (v_old_item.product_id, CASE WHEN v_qty_diff > 0 THEN 'prebooked' ELSE 'released' END,
            ABS(v_qty_diff), p_order_id, v_actor, 'Order edit: adjusted prebooked by ' || v_qty_diff);
        END IF;
      END IF;
    ELSE
      v_new_qty := COALESCE((v_item->>'total_units_needed')::numeric, 0);
      v_new_price := COALESCE((v_item->>'price_per_unit')::numeric, 0);
      v_new_cost := COALESCE((v_item->>'cost_per_unit')::numeric, 0);
      IF v_new_cost = 0 AND (v_item->>'product_id') IS NOT NULL THEN
        SELECT current_cost INTO v_new_cost FROM products WHERE id = (v_item->>'product_id')::uuid;
        v_new_cost := COALESCE(v_new_cost, 0);
      END IF;
      IF v_new_qty <= 0 THEN CONTINUE; END IF;

      v_new_item_id := gen_random_uuid();
      INSERT INTO order_items (id, order_id, product_id, product_name, price_per_unit, cost_per_unit,
        total_units_needed, unit_size, section_name, total_price, profit, net_margin, quantity_delivered, quantity_remaining)
      VALUES (v_new_item_id, p_order_id, (v_item->>'product_id')::uuid, COALESCE(v_item->>'product_name', ''),
        v_new_price, v_new_cost, v_new_qty, v_item->>'unit_size', v_item->>'section_name',
        v_new_price * v_new_qty, (v_new_price - v_new_cost) * v_new_qty,
        CASE WHEN v_new_price > 0 THEN ROUND(((v_new_price - v_new_cost) / v_new_price) * 100, 2) ELSE 0 END,
        0, v_new_qty);

      UPDATE inventory SET quantity_prebooked = quantity_prebooked + v_new_qty, updated_at = now()
      WHERE product_id = (v_item->>'product_id')::uuid AND location = 'Main Warehouse';

      INSERT INTO inventory_transactions (product_id, transaction_type, quantity, order_id, performed_by, notes)
      VALUES ((v_item->>'product_id')::uuid, 'prebooked', v_new_qty, p_order_id, v_actor,
        'New item added to existing order ' || v_order.order_number);

      v_new_items_added := v_new_items_added + 1;
    END IF;
  END LOOP;

  SELECT COALESCE(SUM(total_price), 0) INTO v_new_total FROM order_items WHERE order_id = p_order_id;
  UPDATE orders SET total_price = v_new_total, updated_at = now() WHERE id = p_order_id;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('order_edited',
    'Order ' || v_order.order_number || ' items updated' ||
    CASE WHEN v_new_items_added > 0 THEN ' (' || v_new_items_added || ' new item(s) added)' ELSE '' END ||
    ' — new total $' || ROUND(v_new_total, 2),
    v_actor, 'order', p_order_id, v_order.customer_id);

  v_result := jsonb_build_object('status', 'updated', 'new_items_added', v_new_items_added);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'update_order_items', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) _enforce_delivery_items_parent_lock: broaden both checks from
--    `IN ('in_progress', 'completed')` to `IS NOT NULL AND <> 'scheduled'`,
--    so cancelled/voided (and any future non-scheduled) parents lock too. The
--    IS NOT NULL guard keeps a missing/not-yet-visible parent from raising.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._enforce_delivery_items_parent_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_status text;
BEGIN
  IF _is_admin_override() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT status INTO v_status FROM deliveries WHERE id = OLD.delivery_id;
    IF v_status IS NOT NULL AND v_status <> 'scheduled' THEN
      RAISE EXCEPTION
        'DELIVERY_ITEMS_LOCKED: cannot % delivery items on a % delivery (items are editable only while scheduled)',
        lower(TG_OP), v_status;
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT status INTO v_status FROM deliveries WHERE id = NEW.delivery_id;
    IF v_status IS NOT NULL AND v_status <> 'scheduled' THEN
      RAISE EXCEPTION
        'DELIVERY_ITEMS_LOCKED: cannot % delivery items on a % delivery (items are editable only while scheduled)',
        lower(TG_OP), v_status;
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) Re-assert the SECURITY DEFINER ACL on update_order_items. CREATE OR REPLACE
--    preserves the existing grants, but the project pattern re-asserts so the
--    grant is explicit and machine-checkable. Live state pre-apply (confirmed):
--    anon=false, authenticated=true, service_role=true — this is idempotent.
-- caller-analysis: update_order_items :: REVOKE is only FROM PUBLIC, anon (NOT from authenticated); the GRANT re-asserts authenticated + service_role. The two UI callers (src/lib/offlineSync.ts:161, src/pages/OrderDetail.tsx:428) run as the authenticated role — the frontend uses the anon/authenticated client, never service_role — so they retain EXECUTE and are unaffected. Net effect is a no-op re-assertion of the already-correct live ACL.
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.update_order_items(uuid, jsonb, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_order_items(uuid, jsonb, uuid, text) TO authenticated, service_role;
