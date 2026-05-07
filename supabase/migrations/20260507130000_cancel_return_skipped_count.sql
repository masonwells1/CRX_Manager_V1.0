-- ============================================================================
-- Wave B audit follow-up — cancel_return surfaces skipped_count, both RPCs
-- reorder save_idempotency for defensive atomicity (B-2 + B-11)
-- ----------------------------------------------------------------------------
-- B-2: When cancel_return runs against a 'received' return whose product's
--      inventory row has been deleted in the meantime (e.g. product retired
--      between receive and cancel), the LEFT JOIN LATERAL returned NULL,
--      the IF v_item.inv_id IS NOT NULL block was skipped, and the item was
--      silently left with restocked=true. The activity_feed message and
--      result jsonb both reported "X items un-restocked" but reality was
--      divergent — books drift permanently. receive_return already mirrors
--      this case correctly via RAISE WARNING + v_skipped_count surfaced in
--      the result jsonb; cancel_return now matches.
--
--      Behavior change: when inventory row is missing at cancel time, we
--      still flip the return_items.restocked flag back to false (the user
--      is unwinding the restock state — leaving the flag true would be
--      misleading) but we DON'T attempt to decrement a non-existent
--      inventory row. We surface skipped_count and a RAISE WARNING so the
--      admin knows to reconcile manually.
--
-- B-11: Defensive reorder of save_idempotency. PostgreSQL function bodies
--       are atomic — any unhandled error rolls back the WHOLE function
--       including the idempotency_keys insert — so the previous ordering
--       was technically safe. But moving the bulk UPDATE return_items
--       BEFORE save_idempotency removes any need to think about it, and
--       protects against a future refactor that might split this into a
--       sub-transaction or add an EXCEPTION block. Cheap to do now.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. cancel_return — surface skipped_count + defensive ordering
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.cancel_return(
  p_return_id       uuid,
  p_reason          text,
  p_performed_by    uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_return         record;
  v_item           record;
  v_cached         jsonb;
  v_result         jsonb;
  v_reversed_ids   uuid[] := ARRAY[]::uuid[];
  v_skipped_ids    uuid[] := ARRAY[]::uuid[];
  v_reversed_qty   bigint := 0;
  v_reversed_count int    := 0;
  v_skipped_count  int    := 0;
  v_was_received   boolean;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    v_cached := check_idempotency(p_idempotency_key, 'cancel_return');
    IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to cancel a return';
  END IF;

  SELECT id, return_number, status, customer_id INTO v_return
  FROM returns WHERE id = p_return_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Return not found: %', p_return_id;
  END IF;

  IF v_return.status NOT IN ('requested', 'approved', 'received') THEN
    RAISE EXCEPTION 'Cannot cancel return in status "%" - only requested/approved/received returns can be cancelled', v_return.status;
  END IF;

  v_was_received := (v_return.status = 'received');

  IF v_was_received THEN
    FOR v_item IN
      SELECT ri.id AS item_id, ri.product_id, ri.quantity, ri.product_name, ri.condition,
             inv.id AS inv_id, inv.location AS inv_location
      FROM return_items ri
      LEFT JOIN LATERAL (
        SELECT id, location FROM inventory
        WHERE product_id = ri.product_id AND location = 'Main Warehouse'
        LIMIT 1
      ) inv ON true
      WHERE ri.return_id = p_return_id AND ri.restocked = true
      ORDER BY ri.sort_order
    LOOP
      IF v_item.inv_id IS NOT NULL THEN
        UPDATE inventory
           SET quantity_available = quantity_available - v_item.quantity,
               updated_at = now()
         WHERE id = v_item.inv_id;

        INSERT INTO inventory_transactions (
          product_id, transaction_type, quantity,
          to_location, performed_by, notes
        ) VALUES (
          v_item.product_id, 'returned', -v_item.quantity,
          v_item.inv_location, p_performed_by,
          'Cancel of return ' || v_return.return_number || ': ' || v_item.product_name ||
          ' (' || v_item.condition || ') - restock reversed: ' || p_reason
        );

        v_reversed_ids := array_append(v_reversed_ids, v_item.item_id);
        v_reversed_qty := v_reversed_qty + v_item.quantity;
        v_reversed_count := v_reversed_count + 1;
      ELSE
        -- B-2 fix: inventory row missing at cancel time. Receive previously
        -- incremented a row that no longer exists (product retired between
        -- receive and cancel). Track so the admin can reconcile manually.
        RAISE WARNING 'Cancel of return %: item % (product %) was restocked but inventory row no longer exists - skipping reversal, restocked flag will still be cleared.',
          v_return.return_number, v_item.item_id, v_item.product_id;
        v_skipped_ids := array_append(v_skipped_ids, v_item.item_id);
        v_skipped_count := v_skipped_count + 1;
      END IF;
    END LOOP;
  END IF;

  UPDATE returns SET status='cancelled', cancelled_at=now(), cancelled_by=p_performed_by,
                     cancellation_reason=p_reason, updated_at=now() WHERE id=p_return_id;

  -- B-11 defensive reorder: bulk-flip restocked BEFORE save_idempotency so
  -- the cached result and the underlying state can never diverge. Includes
  -- both reversed and skipped items - both leave the return in a consistent
  -- "restock unwound" state from the user's perspective (skipped items just
  -- couldn't have inventory decremented because the row is gone).
  IF array_length(v_reversed_ids, 1) > 0 OR array_length(v_skipped_ids, 1) > 0 THEN
    UPDATE return_items SET restocked = false WHERE id = ANY(v_reversed_ids || v_skipped_ids);
  END IF;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('return_cancelled',
          'Return ' || v_return.return_number || ' cancelled' ||
          CASE WHEN v_was_received
               THEN ' - ' || v_reversed_count || ' item(s) un-restocked' ||
                    CASE WHEN v_skipped_count > 0
                         THEN ' (' || v_skipped_count || ' skipped: inventory row missing - admin must reconcile)'
                         ELSE '' END
               ELSE '' END ||
          ': ' || p_reason,
          p_performed_by, 'return', p_return_id, v_return.customer_id);

  v_result := jsonb_build_object(
    'success', true,
    'return_id', p_return_id,
    'return_number', v_return.return_number,
    'status', 'cancelled',
    'was_received', v_was_received,
    'reversed_count', v_reversed_count,
    'reversed_quantity', v_reversed_qty,
    'skipped_count', v_skipped_count
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'cancel_return', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_return(uuid, text, uuid, text) TO authenticated;

COMMENT ON FUNCTION public.cancel_return(uuid, text, uuid, text) IS
  'Cancels a return. If the return was already in status received, reverses the inventory restock per Mason Q3. When the inventory row no longer exists at cancel time, the restock cannot be decremented; surfaces skipped_count in the result so the admin can reconcile manually. Wave B.2 / P4-4 + P4-5 + audit B-2.';


-- ---------------------------------------------------------------------------
-- 2. receive_return — defensive ordering only (no behavior change)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.receive_return(
  p_return_id       uuid,
  p_received_by     uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_return          record;
  v_item            record;
  v_cached          jsonb;
  v_result          jsonb;
  v_restocked_ids   uuid[] := ARRAY[]::uuid[];
  v_restocked_qty   bigint := 0;
  v_restocked_count int    := 0;
  v_skipped_count   int    := 0;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    v_cached := check_idempotency(p_idempotency_key, 'receive_return');
    IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  END IF;

  SELECT id, return_number, status, customer_id INTO v_return
  FROM returns WHERE id = p_return_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Return not found: %', p_return_id;
  END IF;
  IF v_return.status != 'approved' THEN
    RAISE EXCEPTION 'Only approved returns can be received (current status: %)', v_return.status;
  END IF;

  FOR v_item IN
    SELECT ri.id AS item_id, ri.product_id, ri.quantity, ri.product_name, ri.condition,
           inv.id AS inv_id, inv.location AS inv_location
    FROM return_items ri
    LEFT JOIN LATERAL (
      SELECT id, location FROM inventory
      WHERE product_id = ri.product_id AND location = 'Main Warehouse'
      LIMIT 1
    ) inv ON true
    WHERE ri.return_id = p_return_id AND ri.restock = true AND ri.restocked = false
    ORDER BY ri.sort_order
  LOOP
    IF v_item.inv_id IS NOT NULL THEN
      UPDATE inventory SET quantity_available = quantity_available + v_item.quantity, updated_at = now() WHERE id = v_item.inv_id;
      INSERT INTO inventory_transactions (product_id, transaction_type, quantity, to_location, performed_by, notes)
      VALUES (v_item.product_id, 'returned', v_item.quantity, v_item.inv_location, p_received_by,
              'Return ' || v_return.return_number || ': ' || v_item.product_name || ' (' || v_item.condition || ')');
      v_restocked_ids := array_append(v_restocked_ids, v_item.item_id);
      v_restocked_qty := v_restocked_qty + v_item.quantity;
      v_restocked_count := v_restocked_count + 1;
    ELSE
      RAISE WARNING 'No inventory row for product % in return % - item NOT restocked.', v_item.product_id, v_return.return_number;
      v_skipped_count := v_skipped_count + 1;
    END IF;
  END LOOP;

  UPDATE returns SET status='received', received_by=p_received_by, received_at=now(), updated_at=now() WHERE id=p_return_id;

  -- B-11 defensive reorder: bulk-flip restocked BEFORE save_idempotency.
  IF array_length(v_restocked_ids, 1) > 0 THEN
    UPDATE return_items SET restocked = true WHERE id = ANY(v_restocked_ids);
  END IF;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('return_received',
          'Return ' || v_return.return_number || ' received - ' || v_restocked_count || ' item(s) restocked' ||
          CASE WHEN v_skipped_count > 0 THEN ' (' || v_skipped_count || ' skipped: no inventory row)' ELSE '' END,
          p_received_by, 'return', p_return_id, v_return.customer_id);

  v_result := jsonb_build_object('success', true, 'return_id', p_return_id, 'return_number', v_return.return_number,
                                  'status', 'received', 'restocked_count', v_restocked_count,
                                  'restocked_quantity', v_restocked_qty, 'skipped_count', v_skipped_count);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'receive_return', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.receive_return(uuid, uuid, text) TO authenticated;
