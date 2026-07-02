-- ============================================================================
-- PARKED DRAFT — DO NOT APPLY (structure-fix loop, Wave A / A7). 2026-07-02.
-- Mason applies via the DRAFT/APPLY protocol after review.
--
-- WHAT: Two parts.
--   PART 1 (PREVENTION) — save_purchase_order now always INSERTs a NEW purchase
--     order as status='draft', then (after its items are inserted) promotes it to
--     the requested status via an UPDATE. That UPDATE fires the existing, tested
--     draft→submitted on-order trigger (trg_po_submitted_on_order → function
--     trg_po_submitted_update_on_order) exactly once, so quantity_on_order is
--     incremented. Signature and all other behavior are verbatim from live
--     pg_get_functiondef (the sole overload, uuid,jsonb,jsonb,uuid,text).
--   PART 2 (RECOMPUTE) — one-time authoritative rebuild of inventory.quantity_on_order
--     for every Main-Warehouse row: SUM(GREATEST(ordered - received, 0)) over each
--     product's open POs (status IN submitted, partially_received).
-- WHY:  The on-order trigger fires ONLY on `UPDATE OF status` for a draft→submitted
--       transition (mig 20260329100000). But save_purchase_order's create branch
--       (mig 20260430250000_field_app_workflow_phase13) INSERTed the PO directly
--       with status='submitted' when the user clicked "Submit" on a brand-new PO,
--       so the AFTER-UPDATE-OF-status trigger never fired and quantity_on_order was
--       never incremented. Direct-frontend `.update({status:'submitted'})` on an
--       already-saved draft DID fire it correctly. Result: 16 of the 114 products
--       that have inventory rows have drifted on-order (14 under-counted incl. the
--       worst 0→9000, 2 over-counted).
-- SCOPE: 1 RPC (save_purchase_order, CREATE OR REPLACE, no signature change) +
--        1 one-time UPDATE on inventory. No new tables, columns, triggers, grants,
--        CHECK constraints, or enum values. RLS unchanged. Reuses the existing
--        on-order trigger — no second increment path is created (cannot double-count).
-- SAFE: - Option A (insert-as-draft-then-promote) reuses the ONLY existing on-order
--         increment path; it does not add a second one, so double-counting is
--         impossible. The trigger increments solely on a draft→submitted UPDATE;
--         an INSERT never hits that path.
--       - enforce_po_status_transition ALLOWS draft→submitted and draft→cancelled
--         (verified live), and the frontend only ever creates a NEW PO as
--         'draft' or 'submitted' (NewPurchaseOrder.tsx handleSave: 'draft'|'submitted').
--       - Items are inserted BEFORE the promote UPDATE, so the trigger's
--         per-item loop sees them.
--       - Recompute is authoritative and matches the trigger's steady-state
--         semantics (submit +ordered; receive_po_items −received; cancel −remaining),
--         scoped to location='Main Warehouse' exactly as the trigger writes.
--
-- SMOKE (2026-07-02, live rolled-back BEGIN…ROLLBACK, nothing persisted):
--   [1] save_purchase_order — CREATE OR REPLACE parsed & created inside a tx;
--       plpgsql_check_function('save_purchase_order(uuid,jsonb,jsonb,uuid,text)'::regprocedure)
--       = NO FINDINGS — CLEAN. Tx aborted via summary RAISE (live fn unchanged; live
--       create-branch still inserts COALESCE(status,'draft'), i.e. the un-fixed form).
--   [2] recompute (v2, with the Codex-P1 LOCK + Codex-P2 insert-missing) — ran in a
--       rolled-back tx, then RAISEd the diff before ROLLBACK: total became 116 (2 rows
--       INSERTED for open-PO products lacking a Main-Warehouse row — Codex P2 confirmed
--       REAL, not just theoretical), 16 rows changed. Worst: 0→9000 (+9000), 0→2545, 0→1125.
--       Live inventory still 114 rows after (rollback confirmed; nothing persisted).
-- CODEX: R1 → two findings FIXED: [P1] added a SHARE ROW EXCLUSIVE table lock so the one-time
--   recompute can't race a concurrent PO write; [P2] added an INSERT for open-PO products with no
--   Main-Warehouse inventory row (smoke proved 2 real such rows). R2 → CLEAN on those, and raised a
--   SEPARATE [P2] latent issue: the on-order INCREMENT is hardcoded to Main Warehouse (trigger) while
--   receive_po_items DECREMENTs at the RECEIVED storage location — so receiving into a non-Main
--   location would overstate Main-Warehouse on-order. DOCUMENTED as a follow-up (NOT fixed here): it's
--   a DIFFERENT drift mechanism from A7's INSERT-path bug, it's LATENT (all 114 inventory rows are
--   single-location Main Warehouse live; multi-location receiving isn't in use), this recompute already
--   CORRECTS the current snapshot (computes ordered−received directly), and the proper fix belongs with
--   the warehouse/location vocabulary work (audit Tier-1), aligning receive_po_items' decrement location
--   with the trigger's increment location. → see owner-decisions Packet 5 / warehouse theme.
-- ============================================================================

-- === PART 1 — PREVENTION ===================================================
-- Rebuilt verbatim from live pg_get_functiondef; the ONLY changes are marked
-- "A7 FIX" in the v_is_new (create) branch.
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
  IF NOT is_admin() THEN RAISE EXCEPTION 'Only admins can manage purchase orders'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'save_purchase_order');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_total_cost := v_total_cost +
      COALESCE((v_item->>'quantity_ordered')::numeric, 0) *
      COALESCE((v_item->>'unit_cost')::numeric, 0);
  END LOOP;

  IF v_is_new THEN
    -- A7 FIX: always INSERT a new PO as 'draft' (was COALESCE(status,'draft')).
    -- The requested status is applied by the promote UPDATE below, AFTER items
    -- exist, so the draft→submitted on-order trigger fires and increments
    -- quantity_on_order. Inserting directly as 'submitted' skipped that trigger.
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
      quantity_ordered, unit_cost, quantity_received)
    SELECT v_po_id, (item->>'product_id')::uuid, item->>'product_name', item->>'unit_size',
      COALESCE((item->>'quantity_ordered')::numeric, 0),
      COALESCE((item->>'unit_cost')::numeric, 0), 0
    FROM jsonb_array_elements(p_items) AS item
    WHERE (item->>'product_id') IS NOT NULL;

    -- A7 FIX: promote the freshly-inserted 'draft' PO to the requested status.
    -- This single UPDATE OF status fires the existing on-order trigger exactly
    -- once (items are already inserted above, so its per-item loop sees them).
    -- enforce_po_status_transition allows draft→submitted / draft→cancelled;
    -- the frontend only ever creates a new PO as 'draft' or 'submitted'.
    v_new_status := COALESCE(p_po_payload->>'status', 'draft');
    IF v_new_status <> 'draft' THEN
      UPDATE purchase_orders SET status = v_new_status, updated_at = now()
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
      submitted_date = COALESCE((p_po_payload->>'submitted_date')::date, submitted_date),
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
          unit_cost = COALESCE((v_item->>'unit_cost')::numeric, unit_cost)
        WHERE id = (v_item->>'id')::uuid AND purchase_order_id = v_po_id;
      ELSE
        INSERT INTO purchase_order_items (purchase_order_id, product_id, product_name, unit_size,
          quantity_ordered, unit_cost, quantity_received)
        VALUES (v_po_id, (v_item->>'product_id')::uuid, v_item->>'product_name', v_item->>'unit_size',
          COALESCE((v_item->>'quantity_ordered')::numeric, 0),
          COALESCE((v_item->>'unit_cost')::numeric, 0), 0);
      END IF;
    END LOOP;
  END IF;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES (
    CASE WHEN v_is_new THEN 'po_created' ELSE 'po_updated' END,
    CASE WHEN v_is_new THEN 'PO ' || COALESCE(v_po_number, '') || ' created'
                       ELSE 'PO ' || COALESCE(v_po_number, '') || ' updated' END,
    v_actor, 'purchase_order', v_po_id
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_purchase_order',
      jsonb_build_object('status', 'saved', 'po_id', v_po_id));
  END IF;

  RETURN jsonb_build_object('status', 'saved', 'po_id', v_po_id);
END;
$function$;

-- === PART 2 — RECOMPUTE ====================================================
-- One-time authoritative rebuild of inventory.quantity_on_order for the drifted
-- rows. Mirrors the trigger's semantics exactly: on-order = outstanding
-- (ordered − received, floored at 0) summed over each product's OPEN POs, where
-- open = status IN ('submitted','partially_received'). Scoped to
-- location='Main Warehouse' — the only location the on-order trigger ever writes.
--
-- Codex P1 (concurrency): a plain UPDATE could take its snapshot before a concurrent
-- PO submit/receive/cancel commits and then overwrite the trigger's increment/decrement.
-- Serialize this one-time recompute against all PO/inventory DML with a brief table lock
-- (released at the end of the migration txn). SHARE ROW EXCLUSIVE conflicts with the
-- ROW EXCLUSIVE that INSERT/UPDATE/DELETE take, so no concurrent PO write can interleave.
LOCK TABLE inventory, purchase_orders, purchase_order_items IN SHARE ROW EXCLUSIVE MODE;

-- Codex P2 (missing rows): a product with an OPEN PO but no Main-Warehouse inventory row
-- would never be backfilled by the UPDATE below (it only touches existing rows). Create the
-- row first (zeroed; the UPDATE then sets its on-order). Defaulted NOT-NULL columns
-- (reorder_point / min_stock_level / manufactured_at_delivery) take their defaults.
INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
SELECT DISTINCT poi.product_id, 'Main Warehouse', 0, 0, 0
  FROM purchase_order_items poi
  JOIN purchase_orders po ON po.id = poi.purchase_order_id
 WHERE po.status IN ('submitted','partially_received')
   AND NOT EXISTS (
     SELECT 1 FROM inventory i WHERE i.product_id = poi.product_id AND i.location = 'Main Warehouse'
   );

UPDATE inventory inv SET
  quantity_on_order = COALESCE((
    SELECT SUM(GREATEST(poi.quantity_ordered - COALESCE(poi.quantity_received,0), 0))
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.purchase_order_id
     WHERE poi.product_id = inv.product_id
       AND po.status IN ('submitted','partially_received')
  ), 0),
  updated_at = now()
WHERE inv.location = 'Main Warehouse';
