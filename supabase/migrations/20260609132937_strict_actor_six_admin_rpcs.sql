-- idempotency-body-check: exempt
-- (release_inventory_hold + manual_inventory_add use the canonical check_idempotency /
--  save_idempotency helpers rather than touching idempotency_keys directly; the other four
--  RPCs in this file reference idempotency_keys directly. Bodies are verbatim from live
--  except (a) the auth block and (b) two idempotency-save calls changed from
--  to_jsonb(<uuid>::text) to to_jsonb(<uuid>) — byte-identical jsonb, required by the
--  sql-safety ::text rule; the stored value is not read on replay.)
--
-- Fix H1 part A (foundation audit 2026-06-09, HIGH — actor-forgery / privilege escalation).
--
-- These six SECURITY DEFINER, authenticated-executable RPCs authorized off
--   v_actor := COALESCE(p_performed_by, auth.uid())
-- and then checked the ROLE OF v_actor. Because p_performed_by is caller-supplied and an
-- active admin's id is readable via profile_public_view, any logged-in user (driver,
-- applicator, sales_rep) could forge an admin/sales_rep id and pass the gate — privilege
-- escalation on payments (void_payment), the month-end lock (reopen_accounting_period),
-- inventory (reverse_receiving_record / release_inventory_hold / manual_inventory_add) and
-- deliveries (edit_delivery).
--
-- Fix: bind the actor to auth.uid() and reject a mismatched p_performed_by with the canonical
-- strict-actor block (AUTH_REQUIRED / ACTOR_MISMATCH via IS DISTINCT FROM / INSUFFICIENT_ROLE),
-- placed BEFORE the idempotency check so a cached result can never be returned to an
-- unauthorized caller. Each function keeps its EXISTING role requirement; `is_active = true`
-- is now enforced via NOT EXISTS, which also closes a latent gap where a caller with no
-- profile row passed the old `role != 'admin'` test (NULL != 'admin' is not TRUE).
-- p_performed_by stays in every signature (no overload change). Reversible.

-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.void_payment(p_allocation_set_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_set              record;
  v_alloc            record;
  v_actor            uuid;
  v_reversed_cents   bigint := 0;
  v_invoice_count    int    := 0;
  v_prepay_reversed  bigint := 0;
  v_old_balance      bigint;
  v_existing         jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'allocation_set_id', p_allocation_set_id, 'idempotent', true);
    END IF;
  END IF;

  SELECT * INTO v_set FROM allocation_sets WHERE id = p_allocation_set_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Allocation set not found: %', p_allocation_set_id; END IF;
  IF NOT v_set.is_active THEN RAISE EXCEPTION 'Payment already voided'; END IF;

  FOR v_alloc IN
    SELECT ila.invoice_id, SUM(ila.amount_cents) AS total_amount
    FROM invoice_line_allocations ila
    WHERE ila.allocation_set_id = p_allocation_set_id AND ila.invoice_id IS NOT NULL
    GROUP BY ila.invoice_id
  LOOP
    UPDATE invoices
    SET paid_amount_cents = GREATEST(paid_amount_cents - v_alloc.total_amount, 0),
        status = CASE
          WHEN GREATEST(paid_amount_cents - v_alloc.total_amount, 0) = 0
               AND status IN ('paid', 'posted') THEN 'posted'
          ELSE status
        END,
        updated_at = now()
    WHERE id = v_alloc.invoice_id;
    v_reversed_cents := v_reversed_cents + v_alloc.total_amount;
    v_invoice_count  := v_invoice_count + 1;
  END LOOP;

  SELECT balance_cents INTO v_old_balance
  FROM prepay_credits
  WHERE source_type = 'overpayment' AND source_reference = p_allocation_set_id::text AND balance_cents > 0
  LIMIT 1 FOR UPDATE;

  IF FOUND AND v_old_balance > 0 THEN
    UPDATE prepay_credits
    SET balance_cents = 0, notes = COALESCE(notes, '') || ' [VOIDED: ' || p_reason || ']', updated_at = now()
    WHERE source_type = 'overpayment' AND source_reference = p_allocation_set_id::text;
    v_prepay_reversed := v_old_balance;
    UPDATE customers SET prepay_balance_cents = GREATEST(prepay_balance_cents - v_prepay_reversed, 0) WHERE id = v_set.customer_id;
  END IF;

  UPDATE allocation_sets SET is_active = false, notes = COALESCE(notes, '') || ' [VOIDED: ' || p_reason || ']', updated_at = now() WHERE id = p_allocation_set_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, old_values, new_values, total_impact_cents, description
  ) VALUES (
    'payment_voided', 'allocation_set', p_allocation_set_id, v_actor,
    jsonb_build_object('total_payment_cents', v_set.total_payment_cents, 'total_allocated_cents', v_set.total_allocated_cents, 'payment_method', v_set.payment_method, 'check_number', v_set.check_number, 'customer_id', v_set.customer_id),
    jsonb_build_object('reason', p_reason, 'invoices_reversed', v_invoice_count, 'prepay_reversed_cents', v_prepay_reversed),
    -1 * v_reversed_cents,
    'Voided payment ' || COALESCE(v_set.check_number, v_set.reference_number, v_set.id::text) || ' — ' || p_reason
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'void_payment', to_jsonb(p_allocation_set_id));
  END IF;

  RETURN jsonb_build_object('success', true, 'allocation_set_id', p_allocation_set_id, 'reversed_cents', v_reversed_cents, 'invoices_affected', v_invoice_count, 'prepay_reversed_cents', v_prepay_reversed);
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reopen_accounting_period(p_period_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor    uuid;
  v_period   record;
  v_existing jsonb;
  v_result   jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to reopen an accounting period';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key
       AND operation = 'reopen_accounting_period';
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  SELECT * INTO v_period
    FROM accounting_periods
   WHERE id = p_period_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Accounting period not found: %', p_period_id;
  END IF;

  IF v_period.status != 'closed' THEN
    RAISE EXCEPTION 'Accounting period is not closed (status: %)', v_period.status;
  END IF;

  UPDATE accounting_periods SET
    status     = 'open',
    closed_at  = NULL,
    closed_by  = NULL,
    updated_at = now()
  WHERE id = p_period_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, description
  ) VALUES (
    'period_reopened', 'accounting_period', p_period_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('status', 'closed', 'closed_at', v_period.closed_at),
    jsonb_build_object('status', 'open'),
    'Accounting period reopened: ' || p_reason
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id
  ) VALUES (
    'period_reopened',
    'Accounting period ' || v_period.period_start || ' to ' || v_period.period_end ||
      ' reopened: ' || p_reason,
    v_actor, 'accounting_period', p_period_id
  );

  v_result := jsonb_build_object(
    'success',      true,
    'period_id',    p_period_id,
    'period_start', v_period.period_start,
    'period_end',   v_period.period_end
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)
    VALUES (p_idempotency_key, 'reopen_accounting_period', v_result, now() + interval '24 hours')
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reverse_receiving_record(p_record_id uuid, p_reason text DEFAULT 'Manually reversed'::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rec    record;
  v_actor  uuid;
  v_existing jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'record_id', p_record_id, 'idempotent', true);
    END IF;
  END IF;

  SELECT * INTO v_rec
  FROM receiving_records
  WHERE id = p_record_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Receiving record not found: %', p_record_id;
  END IF;

  -- Set flags for safety trigger + status transition guard
  PERFORM set_config('app.reversal_rpc_active', 'true', true);
  PERFORM set_config('app.admin_override', 'true', true);

  UPDATE inventory
  SET quantity_available = GREATEST(quantity_available - v_rec.quantity_received, 0),
      updated_at         = now()
  WHERE product_id = v_rec.product_id
    AND location   = v_rec.storage_location;

  INSERT INTO inventory_transactions (
    product_id, transaction_type, quantity, to_location,
    notes, performed_by
  ) VALUES (
    v_rec.product_id,
    'adjusted',
    -1 * v_rec.quantity_received,
    v_rec.storage_location,
    'Reversed receiving record ' || p_record_id::text || ': ' || p_reason,
    v_actor
  );

  UPDATE purchase_order_items
  SET quantity_received = GREATEST(quantity_received - v_rec.quantity_received, 0)
  WHERE id = v_rec.po_item_id;

  UPDATE purchase_orders
  SET status = CASE
    WHEN (
      SELECT bool_and(quantity_received = 0)
      FROM purchase_order_items
      WHERE purchase_order_id = v_rec.purchase_order_id
    ) THEN 'submitted'
    WHEN (
      SELECT bool_and(quantity_received >= quantity_ordered)
      FROM purchase_order_items
      WHERE purchase_order_id = v_rec.purchase_order_id
    ) THEN 'fully_received'
    ELSE 'partially_received'
  END,
  updated_at = now()
  WHERE id = v_rec.purchase_order_id;

  DELETE FROM receiving_photos WHERE receiving_record_id = p_record_id;
  DELETE FROM receiving_records WHERE id = p_record_id;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'reverse_receiving_record', to_jsonb(p_record_id));
  END IF;

  RETURN jsonb_build_object(
    'success',             true,
    'record_id',           p_record_id,
    'product_id',          v_rec.product_id,
    'quantity_reversed',   v_rec.quantity_received,
    'storage_location',    v_rec.storage_location
  );
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.release_inventory_hold(p_hold_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_hold record;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  -- Idempotency guard (IDEMP-5)
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'release_inventory_hold');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_hold FROM inventory_holds WHERE id = p_hold_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory hold not found';
  END IF;

  IF NOT v_hold.is_active THEN
    RETURN jsonb_build_object('status', 'already_released');
  END IF;

  UPDATE inventory_holds SET is_active = false WHERE id = p_hold_id;

  -- Audit trail
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id
  ) VALUES (
    'inventory_hold_released',
    'Inventory hold released for product ' || v_hold.product_id::text,
    v_actor, 'inventory_hold', p_hold_id
  );

  v_result := jsonb_build_object('status', 'released', 'hold_id', p_hold_id);

  -- Save idempotency (IDEMP-5)
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'release_inventory_hold', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.manual_inventory_add(p_product_id uuid, p_location text, p_quantity numeric, p_unit_size text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text, p_unit_cost numeric DEFAULT NULL::numeric, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor    uuid;
  v_existing record;
  v_product  record;
  v_note     text;
  v_idemp_existing jsonb;
  v_result   jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  -- Idempotency guard (IDEMP-4)
  IF p_idempotency_key IS NOT NULL THEN
    v_idemp_existing := check_idempotency(p_idempotency_key, 'manual_inventory_add');
    IF v_idemp_existing IS NOT NULL THEN RETURN v_idemp_existing; END IF;
  END IF;

  -- Check for existing record
  SELECT * INTO v_existing
  FROM inventory WHERE product_id = p_product_id AND location = COALESCE(p_location, 'Main Warehouse');

  IF FOUND THEN
    RAISE EXCEPTION 'Inventory record already exists for this product at this location. Use Receive or Adjust instead.';
  END IF;

  -- Get product for unit_size fallback
  SELECT * INTO v_product FROM products WHERE id = p_product_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product not found';
  END IF;

  -- Insert inventory record
  INSERT INTO inventory (product_id, location, quantity_available, unit_size)
  VALUES (
    p_product_id,
    COALESCE(p_location, 'Main Warehouse'),
    GREATEST(p_quantity, 0),
    COALESCE(p_unit_size, v_product.unit_size)
  );

  -- Build the transaction note with cost info for audit trail
  v_note := COALESCE(p_notes, 'Initial inventory record created with ' || p_quantity || ' units');
  IF p_unit_cost IS NOT NULL AND p_unit_cost > 0 THEN
    v_note := v_note || ' (purchased @ $' || TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM p_unit_cost::text)) || '/unit)';
  END IF;

  -- Create audit trail (in same transaction)
  IF p_quantity > 0 THEN
    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity,
      to_location, performed_by, notes
    ) VALUES (
      p_product_id, 'adjusted', p_quantity,
      COALESCE(p_location, 'Main Warehouse'), v_actor,
      v_note
    );
  END IF;

  v_result := jsonb_build_object('success', true);

  -- Save idempotency (IDEMP-4)
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'manual_inventory_add', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.edit_delivery(p_delivery_id uuid, p_assigned_driver uuid DEFAULT NULL::uuid, p_scheduled_date date DEFAULT NULL::date, p_scheduled_time text DEFAULT NULL::text, p_delivery_window_start text DEFAULT NULL::text, p_delivery_window_end text DEFAULT NULL::text, p_delivery_address_id uuid DEFAULT NULL::uuid, p_delivery_notes text DEFAULT NULL::text, p_priority text DEFAULT NULL::text, p_items jsonb DEFAULT NULL::jsonb, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_delivery record;
  v_actor uuid;
  v_old_driver uuid;
  v_item jsonb;
  v_oi record;
  v_other_scheduled numeric;
  v_requested_qty numeric;
  v_max_allowed numeric;
  v_items_changed boolean := false;
  v_cached_result jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_cached_result
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key;
    IF v_cached_result IS NOT NULL THEN RETURN v_cached_result; END IF;
  END IF;

  -- Lock the delivery row
  SELECT * INTO v_delivery
  FROM deliveries WHERE id = p_delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found';
  END IF;

  IF v_delivery.status NOT IN ('scheduled', 'in_progress') THEN
    RAISE EXCEPTION 'Cannot edit a % delivery', v_delivery.status;
  END IF;

  v_old_driver := v_delivery.assigned_driver;

  -- Update delivery header (only non-null params)
  UPDATE deliveries SET
    assigned_driver = COALESCE(p_assigned_driver, assigned_driver),
    scheduled_date = COALESCE(p_scheduled_date, scheduled_date),
    scheduled_time = CASE WHEN p_scheduled_time IS NOT NULL THEN p_scheduled_time ELSE scheduled_time END,
    delivery_window_start = CASE WHEN p_delivery_window_start IS NOT NULL THEN p_delivery_window_start ELSE delivery_window_start END,
    delivery_window_end = CASE WHEN p_delivery_window_end IS NOT NULL THEN p_delivery_window_end ELSE delivery_window_end END,
    delivery_address_id = CASE WHEN p_delivery_address_id IS NOT NULL THEN p_delivery_address_id ELSE delivery_address_id END,
    delivery_notes = CASE WHEN p_delivery_notes IS NOT NULL THEN p_delivery_notes ELSE delivery_notes END,
    priority = COALESCE(p_priority, priority),
    last_edited_by = v_actor,
    last_edited_at = now(),
    updated_at = now()
  WHERE id = p_delivery_id;

  -- Item editing: only when status = 'scheduled'
  IF p_items IS NOT NULL AND v_delivery.status = 'scheduled' THEN
    -- Validate each item
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
      v_requested_qty := (v_item->>'quantity')::numeric;

      IF v_requested_qty <= 0 THEN
        CONTINUE;
      END IF;

      -- Look up the order item to get quantity_remaining
      SELECT * INTO v_oi
      FROM order_items
      WHERE id = (v_item->>'order_item_id')::uuid
        AND order_id = v_delivery.order_id
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Order item % not found on order %',
          v_item->>'order_item_id', v_delivery.order_id;
      END IF;

      -- Calculate how much is already scheduled on OTHER active deliveries
      SELECT COALESCE(SUM(di.quantity), 0) INTO v_other_scheduled
      FROM delivery_items di
      JOIN deliveries d ON d.id = di.delivery_id
      WHERE di.order_item_id = v_oi.id
        AND d.status IN ('scheduled', 'in_progress')
        AND d.id != p_delivery_id;

      v_max_allowed := v_oi.quantity_remaining - v_other_scheduled;

      IF v_requested_qty > v_max_allowed THEN
        RAISE EXCEPTION 'Cannot schedule % units of % — only % available (% remaining on order, % on other deliveries)',
          v_requested_qty,
          v_oi.product_name,
          GREATEST(v_max_allowed, 0),
          v_oi.quantity_remaining,
          v_other_scheduled;
      END IF;
    END LOOP;

    -- Delete old items and insert new ones
    DELETE FROM delivery_items WHERE delivery_id = p_delivery_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
      IF (v_item->>'quantity')::numeric > 0 THEN
        INSERT INTO delivery_items (
          delivery_id, order_item_id, product_id, quantity, unit_size
        ) VALUES (
          p_delivery_id,
          (v_item->>'order_item_id')::uuid,
          (v_item->>'product_id')::uuid,
          (v_item->>'quantity')::numeric,
          v_item->>'unit_size'
        );
      END IF;
    END LOOP;

    v_items_changed := true;
  END IF;

  -- Block item editing on in_progress deliveries with a clear message
  IF p_items IS NOT NULL AND v_delivery.status = 'in_progress' THEN
    RAISE EXCEPTION 'Cannot edit delivery items once delivery is in progress';
  END IF;

  -- Notify old driver if driver changed
  IF p_assigned_driver IS NOT NULL AND v_old_driver IS DISTINCT FROM p_assigned_driver THEN
    IF v_old_driver IS NOT NULL THEN
      INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
      VALUES (
        v_old_driver,
        'Delivery Reassigned',
        'Delivery ' || v_delivery.delivery_number || ' has been reassigned to another driver.',
        'delivery_update', 'delivery', p_delivery_id
      );
    END IF;

    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    VALUES (
      p_assigned_driver,
      'New Delivery Assigned',
      'Delivery ' || v_delivery.delivery_number || ' has been assigned to you.',
      'delivery_update', 'delivery', p_delivery_id
    );
  END IF;

  -- Activity log
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_edited',
    'Delivery ' || v_delivery.delivery_number || ' edited' ||
      CASE WHEN v_items_changed THEN ' (items updated)' ELSE '' END,
    v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  -- Store idempotency result (result column is jsonb)
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'edit_delivery',
      jsonb_build_object('status', 'updated', 'delivery_id', p_delivery_id, 'items_changed', v_items_changed)
    );
  END IF;

  RETURN jsonb_build_object('status', 'updated', 'delivery_id', p_delivery_id, 'items_changed', v_items_changed);
END;
$function$;
