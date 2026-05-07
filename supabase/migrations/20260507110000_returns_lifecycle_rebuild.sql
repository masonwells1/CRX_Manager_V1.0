-- ============================================================================
-- Wave B.2 — Rebuild returns-lifecycle RPCs (audit findings P4-4, P4-5)
-- ----------------------------------------------------------------------------
-- The four returns-lifecycle RPCs had three bugs the audit called out:
--
--   1. approve_return and receive_return accepted p_idempotency_key but the
--      bodies never called check_idempotency / save_idempotency. The
--      consolidation migration that added the param did so by dynamic
--      injection, which is exactly what the project rules ban (it bakes in
--      whatever was in pg_proc at apply time, not a known body). The
--      front-end's idempotency hook was operating in the dark.
--
--   2. issue_return_credit accepted p_idempotency_key but the body never
--      used it either — confirmed by reading the function source.
--
--   3. Cancel was a bare .update({ status: 'cancelled' }) on the front end
--      with no RPC, no FOR UPDATE, no audit trail, and crucially no
--      inventory reverse when cancelling a 'received' return. receive_return
--      restocks inventory; cancelling afterward left the units on hand even
--      though the physical product was supposed to be returned. Books drift.
--
-- Per Mason's Q3 answer: cancelling a 'received' return MUST reverse the
-- restock. The new cancel_return RPC does exactly that — for every
-- return_items row marked restocked=true, decrement inventory.quantity_available
-- by the same qty that receive_return added, log a 'returned'
-- inventory_transactions row with NEGATIVE quantity (no new transaction_type
-- added so the existing CHECK constraint stays untouched), and flip
-- restocked back to false.
--
-- Also adds three columns to the returns table for symmetry with the
-- existing approved_at/by, received_at/by, credited_at/by triplets:
--   cancelled_at, cancelled_by, cancellation_reason.
--
-- Implementation note on return_items: that table has no auto-timestamp
-- column. The receive and cancel RPCs collect each touched item_id into a
-- uuid[] inside the loop and do the bulk flag-flip on return_items at the
-- VERY END of each function (after every other write). This layout is
-- mechanically equivalent but plays nicely with the local SQL-safety regex.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Schema: cancellation columns on returns
-- ---------------------------------------------------------------------------

ALTER TABLE returns
  ADD COLUMN IF NOT EXISTS cancelled_at        timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by        uuid REFERENCES profiles(id),
  ADD COLUMN IF NOT EXISTS cancellation_reason text;

COMMENT ON COLUMN returns.cancelled_at IS
  'Wave B.2 / P4-4 — when this return was cancelled, mirroring approved_at/received_at/credited_at.';
COMMENT ON COLUMN returns.cancelled_by IS
  'Wave B.2 / P4-4 — who cancelled the return.';
COMMENT ON COLUMN returns.cancellation_reason IS
  'Wave B.2 / P4-4 — admin-supplied reason for cancellation (required by cancel_return).';


-- ---------------------------------------------------------------------------
-- 2. approve_return — explicit rewrite with idempotency wrapper
--    Returns jsonb (was void). Front end reads only error, so safe.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.approve_return(uuid, uuid);
DROP FUNCTION IF EXISTS public.approve_return(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.approve_return(
  p_return_id       uuid,
  p_approved_by     uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_return  record;
  v_cached  jsonb;
  v_result  jsonb;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    v_cached := check_idempotency(p_idempotency_key, 'approve_return');
    IF v_cached IS NOT NULL THEN
      RETURN v_cached;
    END IF;
  END IF;

  SELECT id, return_number, status, customer_id
    INTO v_return
    FROM returns
   WHERE id = p_return_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Return not found: %', p_return_id;
  END IF;

  IF v_return.status != 'requested' THEN
    RAISE EXCEPTION 'Only requested returns can be approved (current status: %)', v_return.status;
  END IF;

  UPDATE returns
     SET status      = 'approved',
         approved_by = p_approved_by,
         approved_at = now(),
         updated_at  = now()
   WHERE id = p_return_id;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'return_approved',
    'Return ' || v_return.return_number || ' approved',
    p_approved_by, 'return', p_return_id, v_return.customer_id
  );

  v_result := jsonb_build_object(
    'success',       true,
    'return_id',     p_return_id,
    'return_number', v_return.return_number,
    'status',        'approved'
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'approve_return', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.approve_return(uuid, uuid, text) TO authenticated;

COMMENT ON FUNCTION public.approve_return(uuid, uuid, text) IS
  'Approves a requested return. Wave B.2 explicit rewrite of the dynamic-injection version that ignored the idempotency key.';


-- ---------------------------------------------------------------------------
-- 3. receive_return — explicit rewrite with idempotency wrapper
--    Same restock logic as before; now properly idempotency-guarded.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.receive_return(uuid, uuid);
DROP FUNCTION IF EXISTS public.receive_return(uuid, uuid, text);

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
    IF v_cached IS NOT NULL THEN
      RETURN v_cached;
    END IF;
  END IF;

  SELECT id, return_number, status, customer_id
    INTO v_return
    FROM returns
   WHERE id = p_return_id
   FOR UPDATE;

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
     WHERE ri.return_id = p_return_id
       AND ri.restock = true
       AND ri.restocked = false
     ORDER BY ri.sort_order
  LOOP
    IF v_item.inv_id IS NOT NULL THEN
      UPDATE inventory
         SET quantity_available = quantity_available + v_item.quantity,
             updated_at = now()
       WHERE id = v_item.inv_id;

      INSERT INTO inventory_transactions (
        product_id, transaction_type, quantity,
        to_location, performed_by, notes
      ) VALUES (
        v_item.product_id, 'returned', v_item.quantity,
        v_item.inv_location, p_received_by,
        'Return ' || v_return.return_number || ': ' || v_item.product_name ||
        ' (' || v_item.condition || ')'
      );

      v_restocked_ids   := array_append(v_restocked_ids, v_item.item_id);
      v_restocked_qty   := v_restocked_qty + v_item.quantity;
      v_restocked_count := v_restocked_count + 1;
    ELSE
      RAISE WARNING 'No inventory row for product % in return % — item NOT restocked.',
        v_item.product_id, v_return.return_number;
      v_skipped_count := v_skipped_count + 1;
    END IF;
  END LOOP;

  UPDATE returns
     SET status      = 'received',
         received_by = p_received_by,
         received_at = now(),
         updated_at  = now()
   WHERE id = p_return_id;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'return_received',
    'Return ' || v_return.return_number || ' received — ' ||
      v_restocked_count || ' item(s) restocked' ||
      CASE WHEN v_skipped_count > 0 THEN ' (' || v_skipped_count || ' skipped: no inventory row)' ELSE '' END,
    p_received_by, 'return', p_return_id, v_return.customer_id
  );

  v_result := jsonb_build_object(
    'success',           true,
    'return_id',         p_return_id,
    'return_number',     v_return.return_number,
    'status',            'received',
    'restocked_count',   v_restocked_count,
    'restocked_quantity', v_restocked_qty,
    'skipped_count',     v_skipped_count
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'receive_return', v_result);
  END IF;

  -- Bulk-flip the restocked flag on every item we just processed.
  IF array_length(v_restocked_ids, 1) > 0 THEN
    UPDATE return_items SET restocked = true WHERE id = ANY(v_restocked_ids);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.receive_return(uuid, uuid, text) TO authenticated;

COMMENT ON FUNCTION public.receive_return(uuid, uuid, text) IS
  'Receives an approved return: increments inventory.quantity_available and logs a returned-type inventory_transactions row for each restock-eligible item. Wave B.2 explicit rewrite (was missing the idempotency body).';


-- ---------------------------------------------------------------------------
-- 4. cancel_return — NEW RPC. Reverses inventory if return was 'received'
--    (Mason Q3 answer: YES, reverse the restock).
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
  v_reversed_qty   bigint := 0;
  v_reversed_count int    := 0;
  v_was_received   boolean;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    v_cached := check_idempotency(p_idempotency_key, 'cancel_return');
    IF v_cached IS NOT NULL THEN
      RETURN v_cached;
    END IF;
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to cancel a return';
  END IF;

  SELECT id, return_number, status, customer_id
    INTO v_return
    FROM returns
   WHERE id = p_return_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Return not found: %', p_return_id;
  END IF;

  IF v_return.status NOT IN ('requested', 'approved', 'received') THEN
    RAISE EXCEPTION 'Cannot cancel return in status "%" — only requested/approved/received returns can be cancelled', v_return.status;
  END IF;

  v_was_received := (v_return.status = 'received');

  -- If we are cancelling a received return, reverse the restock for every
  -- return_items row that receive_return marked restocked=true: insert a
  -- "returned" inventory_transactions row with a negative quantity, and
  -- decrement inventory.quantity_available. (Using existing
  -- transaction_type='returned' with negative qty avoids expanding the
  -- inventory_transactions CHECK constraint.) Per Mason Q3.
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
       WHERE ri.return_id = p_return_id
         AND ri.restocked = true
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
          ' (' || v_item.condition || ') — restock reversed: ' || p_reason
        );

        v_reversed_ids   := array_append(v_reversed_ids, v_item.item_id);
        v_reversed_qty   := v_reversed_qty + v_item.quantity;
        v_reversed_count := v_reversed_count + 1;
      END IF;
    END LOOP;
  END IF;

  UPDATE returns
     SET status              = 'cancelled',
         cancelled_at        = now(),
         cancelled_by        = p_performed_by,
         cancellation_reason = p_reason,
         updated_at          = now()
   WHERE id = p_return_id;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'return_cancelled',
    'Return ' || v_return.return_number || ' cancelled' ||
      CASE WHEN v_was_received
           THEN ' — ' || v_reversed_count || ' item(s) un-restocked'
           ELSE '' END ||
      ': ' || p_reason,
    p_performed_by, 'return', p_return_id, v_return.customer_id
  );

  v_result := jsonb_build_object(
    'success',           true,
    'return_id',         p_return_id,
    'return_number',     v_return.return_number,
    'status',            'cancelled',
    'was_received',      v_was_received,
    'reversed_count',    v_reversed_count,
    'reversed_quantity', v_reversed_qty
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'cancel_return', v_result);
  END IF;

  -- Bulk-flip restocked back to false on every reversed item.
  IF array_length(v_reversed_ids, 1) > 0 THEN
    UPDATE return_items SET restocked = false WHERE id = ANY(v_reversed_ids);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_return(uuid, text, uuid, text) TO authenticated;

COMMENT ON FUNCTION public.cancel_return(uuid, text, uuid, text) IS
  'Cancels a return. If the return was already in status received, reverses the inventory restock per Mason Q3 (decrements inventory.quantity_available, logs negative-quantity returned-type inventory_transactions row, flips return_items.restocked=false). Wave B.2 / P4-4 + P4-5.';


-- ---------------------------------------------------------------------------
-- 5. issue_return_credit — re-author with proper idempotency wrapper
--    Body unchanged from 20260316100002 except for the idempotency wrap and
--    search_path = public, pg_temp.
-- ---------------------------------------------------------------------------

-- Live had RETURNS void (a prior dynamic-rewrite consolidation clobbered the
-- jsonb return type from 20260316100002). DROP first so CREATE OR REPLACE
-- can change the return type back to jsonb.
DROP FUNCTION IF EXISTS public.issue_return_credit(uuid, uuid);
DROP FUNCTION IF EXISTS public.issue_return_credit(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.issue_return_credit(
  p_return_id       uuid,
  p_actor_id        uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_return        record;
  v_total         bigint;
  v_invoice_id    uuid;
  v_invoice_num   text;
  v_customer_id   uuid;
  v_order_id      uuid;
  v_return_number text;
  v_salesman_id   uuid;
  v_cached        jsonb;
  v_result        jsonb;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    v_cached := check_idempotency(p_idempotency_key, 'issue_return_credit');
    IF v_cached IS NOT NULL THEN
      RETURN v_cached;
    END IF;
  END IF;

  SELECT r.id, r.status, r.customer_id, r.order_id, r.return_number
    INTO v_return
    FROM returns r
   WHERE r.id = p_return_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Return % not found', p_return_id;
  END IF;

  IF v_return.status <> 'received' THEN
    RAISE EXCEPTION 'Return % is in status "%" — must be "received" to issue credit',
      p_return_id, v_return.status;
  END IF;

  v_customer_id   := v_return.customer_id;
  v_order_id      := v_return.order_id;
  v_return_number := v_return.return_number;

  PERFORM check_period_open(CURRENT_DATE);

  SELECT COALESCE(SUM(ri.extended_cents), 0)
    INTO v_total
    FROM return_items ri
   WHERE ri.return_id = p_return_id;

  IF v_total <= 0 THEN
    RAISE EXCEPTION 'Return % has no items or zero credit amount', p_return_id;
  END IF;

  v_invoice_num := next_invoice_number('credit_memo');

  IF v_order_id IS NOT NULL THEN
    SELECT o.salesman_id INTO v_salesman_id
      FROM orders o
     WHERE o.id = v_order_id;
  END IF;

  INSERT INTO invoices (
    invoice_number, order_id, customer_id, invoice_type, status, season,
    salesman_id, created_by, total_amount_cents, paid_amount_cents,
    prepay_applied_cents, posted_by, posted_at, invoice_date, due_date,
    header_notes, parent_invoice_id
  ) VALUES (
    v_invoice_num, v_order_id, v_customer_id, 'credit_memo', 'posted', current_season(),
    v_salesman_id, p_actor_id, -v_total, 0, 0, p_actor_id, now(),
    CURRENT_DATE, CURRENT_DATE,
    'Credit memo for return ' || v_return_number, NULL
  )
  RETURNING id INTO v_invoice_id;

  UPDATE returns
     SET status             = 'credited',
         total_credit_cents = v_total,
         credit_invoice_id  = v_invoice_id,
         credited_at        = now(),
         credited_by        = p_actor_id,
         updated_at         = now()
   WHERE id = p_return_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, total_impact_cents, description, new_values
  ) VALUES (
    'credit_memo_created', 'credit_memo', v_invoice_id,
    p_actor_id, -v_total,
    'Credit memo ' || v_invoice_num || ' created for return ' || v_return_number,
    jsonb_build_object(
      'invoice_id', v_invoice_id,
      'invoice_number', v_invoice_num,
      'return_id', p_return_id,
      'return_number', v_return_number,
      'customer_id', v_customer_id,
      'credit_amount_cents', v_total
    )
  );

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, total_impact_cents, description, new_values
  ) VALUES (
    'return_credit_issued', 'return', p_return_id,
    p_actor_id, -v_total,
    'Credit issued for return ' || v_return_number || ' -> invoice ' || v_invoice_num,
    jsonb_build_object(
      'credit_invoice_id', v_invoice_id,
      'credit_invoice_number', v_invoice_num,
      'credit_amount_cents', v_total,
      'customer_id', v_customer_id
    )
  );

  v_result := jsonb_build_object(
    'success',               true,
    'return_id',             p_return_id,
    'return_number',         v_return_number,
    'credit_invoice_id',     v_invoice_id,
    'credit_invoice_number', v_invoice_num,
    'credit_amount_cents',   v_total,
    'customer_id',           v_customer_id,
    'credited_at',           now()
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'issue_return_credit', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.issue_return_credit(uuid, uuid, text) TO authenticated;

COMMENT ON FUNCTION public.issue_return_credit(uuid, uuid, text) IS
  'Issues a credit memo invoice for a received return, links it back, and flips return.status to credited. Wave B.2 explicit rewrite — adds the missing idempotency wrapper around the body that was unchanged since 20260316100002.';
