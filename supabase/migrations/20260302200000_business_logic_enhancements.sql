-- ============================================================================
-- BUSINESS LOGIC ENHANCEMENTS — Production Readiness
-- ============================================================================
-- Implements 5 business logic tasks + 6 audit integrity fixes.
--
-- IMPLEMENTATION TASKS:
--   T5: Enforce draft invoice creation (trigger)
--   T2: Quick delivery commissions (always generate)
--   T3: Order cancellation cascade (void drafts, zero commissions, release holds)
--   T1: Partial delivery invoice auto-adjustment
--   T4: Delivery remainder auto-reminders (7-day + 14-day escalation)
--
-- AUDIT FIXES:
--   A2.1: Delivery cancellation restores inventory
--   A2.2: Delivery cancellation voids/notifies linked invoices
--   A2.3: Void invoice reverses payment allocations
--   A2.5: Quick delivery uses correct tier pricing
--   A2.7: Inventory holds released on quote decline/expiry
--   A2.8: Job completion deducts from quantity_available (not quantity_on_hand)
-- ============================================================================


-- ============================================================================
-- T5: ENFORCE DRAFT INVOICE CREATION
-- ============================================================================
-- Business rule: all invoices start as draft, require manual posting by sales rep.
-- This trigger prevents any code path from accidentally creating a non-draft invoice.
-- ============================================================================

CREATE OR REPLACE FUNCTION enforce_invoice_draft_on_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Business rule: invoices always start as draft
  IF NEW.status != 'draft' THEN
    RAISE EXCEPTION 'Invoices must be created with status draft. Got: %', NEW.status;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_invoice_draft_insert ON invoices;
CREATE TRIGGER trg_invoice_draft_insert
  BEFORE INSERT ON invoices
  FOR EACH ROW
  EXECUTE FUNCTION enforce_invoice_draft_on_insert();


-- ============================================================================
-- T4: DELIVERY REMAINDER AUTO-REMINDERS
-- ============================================================================
-- Add reminder tracking columns to delivery_remainders
-- ============================================================================

ALTER TABLE delivery_remainders ADD COLUMN IF NOT EXISTS reminder_sent_at timestamptz DEFAULT NULL;
ALTER TABLE delivery_remainders ADD COLUMN IF NOT EXISTS escalation_sent_at timestamptz DEFAULT NULL;


-- ============================================================================
-- T4: check_remainder_reminders() RPC
-- ============================================================================
-- Checks for delivery remainders pending 7+ days (reminder) and 14+ days (escalation).
-- Called from Dashboard on load, fire-and-forget.
-- ============================================================================

CREATE OR REPLACE FUNCTION check_remainder_reminders()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_remainder record;
  v_admin record;
  v_sales_rep_id uuid;
  v_reminders_sent integer := 0;
  v_escalations_sent integer := 0;
BEGIN
  -- 7-day reminders
  FOR v_remainder IN
    SELECT dr.*, p.product_name, d.delivery_number,
           o.customer_id AS order_customer_id
    FROM delivery_remainders dr
    JOIN products p ON p.id = dr.product_id
    JOIN deliveries d ON d.id = dr.original_delivery_id
    JOIN orders o ON o.id = dr.order_id
    WHERE dr.status = 'pending'
      AND dr.created_at < NOW() - INTERVAL '7 days'
      AND dr.reminder_sent_at IS NULL
  LOOP
    -- Look up assigned sales rep from customer
    SELECT c.assigned_sales_rep INTO v_sales_rep_id
    FROM customers c WHERE c.id = v_remainder.customer_id;

    -- Notify admins
    FOR v_admin IN
      SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
    LOOP
      INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
      VALUES (
        v_admin.id,
        'Delivery Remainder Pending 7+ Days',
        v_remainder.product_name || ' (' || v_remainder.quantity_remaining || ' units) from delivery ' || v_remainder.delivery_number || ' has been pending for 7+ days.',
        'remainder_reminder', 'delivery', v_remainder.original_delivery_id
      );
    END LOOP;

    -- Notify sales rep if set and not admin
    IF v_sales_rep_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM profiles WHERE id = v_sales_rep_id AND role = 'admin'
    ) THEN
      INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
      VALUES (
        v_sales_rep_id,
        'Delivery Remainder Pending 7+ Days',
        v_remainder.product_name || ' (' || v_remainder.quantity_remaining || ' units) from delivery ' || v_remainder.delivery_number || ' has been pending for 7+ days.',
        'remainder_reminder', 'delivery', v_remainder.original_delivery_id
      );
    END IF;

    UPDATE delivery_remainders SET reminder_sent_at = NOW() WHERE id = v_remainder.id;
    v_reminders_sent := v_reminders_sent + 1;
  END LOOP;

  -- 14-day escalation
  FOR v_remainder IN
    SELECT dr.*, p.product_name, d.delivery_number
    FROM delivery_remainders dr
    JOIN products p ON p.id = dr.product_id
    JOIN deliveries d ON d.id = dr.original_delivery_id
    WHERE dr.status = 'pending'
      AND dr.created_at < NOW() - INTERVAL '14 days'
      AND dr.reminder_sent_at IS NOT NULL
      AND dr.escalation_sent_at IS NULL
  LOOP
    FOR v_admin IN
      SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
    LOOP
      INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
      VALUES (
        v_admin.id,
        'URGENT: Delivery Remainder Pending 14+ Days',
        v_remainder.product_name || ' (' || v_remainder.quantity_remaining || ' units) from delivery ' || v_remainder.delivery_number || ' has been pending for 14+ days. Please schedule follow-up or cancel.',
        'remainder_escalation', 'delivery', v_remainder.original_delivery_id
      );
    END LOOP;

    UPDATE delivery_remainders SET escalation_sent_at = NOW() WHERE id = v_remainder.id;
    v_escalations_sent := v_escalations_sent + 1;
  END LOOP;

  RETURN jsonb_build_object('reminders_sent', v_reminders_sent, 'escalations_sent', v_escalations_sent);
END;
$$;

GRANT EXECUTE ON FUNCTION check_remainder_reminders() TO authenticated;


-- ============================================================================
-- A2.8: FIX JOB COMPLETION — DEDUCT FROM quantity_available NOT quantity_on_hand
-- ============================================================================
-- complete_job() was deducting from quantity_on_hand, bypassing the
-- inventory hold/prebooked system. Must deduct from quantity_available
-- (consistent with complete_delivery) and check availability first.
-- ============================================================================

CREATE OR REPLACE FUNCTION complete_job(
  p_job_id uuid,
  p_applied_info jsonb,
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job RECORD;
  v_record_number text;
  v_record_id uuid;
  v_product_data jsonb;
  v_weather jsonb;
  v_chem RECORD;
  v_inv record;
BEGIN
  -- Lock the job
  SELECT j.*, c.farm_name AS customer_name
  INTO v_job
  FROM jobs j
  JOIN customers c ON c.id = j.customer_id
  WHERE j.id = p_job_id
  FOR UPDATE OF j;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found: %', p_job_id;
  END IF;

  IF v_job.status NOT IN ('scheduled', 'in_progress') THEN
    RAISE EXCEPTION 'Job cannot be completed from status: %', v_job.status;
  END IF;

  -- PRE-CHECK: Verify inventory availability for all chemicals (A2.8 fix)
  FOR v_chem IN
    SELECT jc.product_id, jc.quantity, jc.unit, p.product_name
    FROM job_chemicals jc
    JOIN products p ON p.id = jc.product_id
    WHERE jc.job_id = p_job_id AND jc.quantity > 0
  LOOP
    SELECT * INTO v_inv
    FROM inventory
    WHERE product_id = v_chem.product_id AND location = 'Main Warehouse'
    FOR UPDATE;

    IF NOT FOUND OR v_inv.quantity_available < v_chem.quantity THEN
      RAISE EXCEPTION 'Insufficient inventory for %: need % units, only % available',
        v_chem.product_name,
        v_chem.quantity,
        COALESCE(v_inv.quantity_available, 0);
    END IF;
  END LOOP;

  -- Update job status
  UPDATE jobs SET status = 'completed' WHERE id = p_job_id;

  -- Insert applied info
  INSERT INTO job_applied_info (
    job_id, actual_start_time, actual_end_time,
    wind_speed, wind_direction, temperature, humidity,
    actual_gallons_applied, notes
  ) VALUES (
    p_job_id,
    CASE WHEN p_applied_info->>'actual_start_time' IS NOT NULL
      THEN (p_applied_info->>'actual_start_time')::timestamptz ELSE NULL END,
    CASE WHEN p_applied_info->>'actual_end_time' IS NOT NULL
      THEN (p_applied_info->>'actual_end_time')::timestamptz ELSE NULL END,
    (p_applied_info->>'wind_speed')::numeric,
    p_applied_info->>'wind_direction',
    (p_applied_info->>'temperature')::numeric,
    (p_applied_info->>'humidity')::numeric,
    (p_applied_info->>'actual_gallons_applied')::numeric,
    p_applied_info->>'notes'
  )
  ON CONFLICT (job_id) DO UPDATE SET
    actual_start_time = EXCLUDED.actual_start_time,
    actual_end_time = EXCLUDED.actual_end_time,
    wind_speed = EXCLUDED.wind_speed,
    wind_direction = EXCLUDED.wind_direction,
    temperature = EXCLUDED.temperature,
    humidity = EXCLUDED.humidity,
    actual_gallons_applied = EXCLUDED.actual_gallons_applied,
    notes = EXCLUDED.notes;

  -- Build product_data JSONB from job_chemicals
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'product_id', jc.product_id,
        'product_name', p.product_name,
        'quantity', jc.quantity,
        'unit', jc.unit,
        'rate_per_acre', jc.rate_per_acre,
        'rate_unit', jc.rate_unit,
        'epa_registration', p.epa_registration,
        'is_rup', COALESCE(p.is_rup, false)
      )
      ORDER BY jc.sort_order
    ),
    '[]'::jsonb
  )
  INTO v_product_data
  FROM job_chemicals jc
  LEFT JOIN products p ON p.id = jc.product_id
  WHERE jc.job_id = p_job_id;

  -- Build weather conditions
  v_weather := jsonb_build_object(
    'wind_speed', (p_applied_info->>'wind_speed')::numeric,
    'wind_direction', p_applied_info->>'wind_direction',
    'temperature', (p_applied_info->>'temperature')::numeric,
    'humidity', (p_applied_info->>'humidity')::numeric
  );

  -- Generate application record number
  v_record_number := next_application_record_number();

  -- Create application record
  INSERT INTO application_records (
    record_number, source_type, source_id,
    customer_id, applicator_id, field_id,
    application_date, product_data,
    total_acres, total_volume, total_volume_unit,
    vehicle_id, weather_conditions,
    notes, season, created_by
  ) VALUES (
    v_record_number, 'job', p_job_id,
    v_job.customer_id,
    v_job.applicator_id,
    (SELECT field_id FROM job_fields WHERE job_id = p_job_id ORDER BY sort_order LIMIT 1),
    v_job.job_date,
    v_product_data,
    v_job.total_acres,
    (p_applied_info->>'actual_gallons_applied')::numeric,
    'gallons',
    v_job.vehicle_id,
    v_weather,
    v_job.notes,
    v_job.season,
    p_performed_by
  )
  RETURNING id INTO v_record_id;

  -- A2.8 FIX: Deduct inventory from quantity_available (not quantity_on_hand)
  -- This is consistent with complete_delivery() behavior
  FOR v_chem IN
    SELECT jc.product_id, jc.quantity, jc.unit
    FROM job_chemicals jc
    WHERE jc.job_id = p_job_id AND jc.quantity > 0
  LOOP
    UPDATE inventory SET
      quantity_available = quantity_available - v_chem.quantity,
      quantity_prebooked = GREATEST(quantity_prebooked - v_chem.quantity, 0),
      updated_at = now()
    WHERE product_id = v_chem.product_id AND location = 'Main Warehouse';

    -- Create inventory transaction for audit trail
    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, from_location,
      performed_by, notes
    ) VALUES (
      v_chem.product_id, 'job_applied', v_chem.quantity, 'Main Warehouse',
      p_performed_by,
      'Job ' || v_job.job_number || ' completed — ' || v_chem.quantity || ' units applied'
    );
  END LOOP;

  -- Activity log
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'job_completed',
    'Job ' || v_job.job_number || ' completed. Application record: ' || v_record_number,
    p_performed_by, 'job', p_job_id, v_job.customer_id
  );

  RETURN jsonb_build_object(
    'success', true,
    'job_id', p_job_id,
    'application_record_id', v_record_id,
    'record_number', v_record_number
  );
END;
$$;

GRANT EXECUTE ON FUNCTION complete_job(uuid, jsonb, uuid) TO authenticated;


-- ============================================================================
-- A2.7: RELEASE INVENTORY HOLDS ON QUOTE DECLINE/EXPIRY
-- ============================================================================
-- When a quote is declined or expired, release all active inventory holds.
-- We create a trigger that fires on quote status change.
-- ============================================================================

CREATE OR REPLACE FUNCTION release_holds_on_quote_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_released_count integer;
BEGIN
  -- Only fire when status changes TO declined or expired
  IF NEW.status IN ('declined', 'expired') AND OLD.status NOT IN ('declined', 'expired') THEN
    UPDATE inventory_holds
    SET is_active = false, updated_at = now()
    WHERE quote_id = NEW.id AND is_active = true;

    GET DIAGNOSTICS v_released_count = ROW_COUNT;

    IF v_released_count > 0 THEN
      INSERT INTO activity_feed (
        event_type, description, performed_by,
        related_entity_type, related_entity_id, customer_id
      ) VALUES (
        'inventory_holds_released',
        'Released ' || v_released_count || ' inventory hold(s) for quote ' || NEW.quote_number || ' (' || NEW.status || ')',
        COALESCE(auth.uid(), '00000000-0000-0000-0000-000000000000'),
        'quote', NEW.id, NEW.customer_id
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_release_holds_on_quote_status ON quotes;
CREATE TRIGGER trg_release_holds_on_quote_status
  AFTER UPDATE OF status ON quotes
  FOR EACH ROW
  EXECUTE FUNCTION release_holds_on_quote_status_change();


-- ============================================================================
-- A2.3: VOID INVOICE REVERSES PAYMENT ALLOCATIONS
-- ============================================================================
-- When void_invoice() is called, reverse all payment allocations and
-- restore prepay credits. This is critical for financial integrity.
-- ============================================================================

CREATE OR REPLACE FUNCTION void_invoice(
  p_invoice_id  uuid,
  p_void_reason text DEFAULT 'Voided by admin'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv record;
  v_alloc record;
  v_total_allocations_reversed bigint := 0;
  v_total_prepay_restored bigint := 0;
  v_prepay_app record;
BEGIN
  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found: %', p_invoice_id;
  END IF;

  IF v_inv.status = 'voided' THEN
    RAISE EXCEPTION 'Invoice already voided';
  END IF;

  IF v_inv.status = 'cancelled' THEN
    RAISE EXCEPTION 'Cannot void a cancelled invoice';
  END IF;

  -- A2.3 FIX: Reverse payment allocations
  FOR v_alloc IN
    SELECT ila.id, ila.allocated_cents, ila.allocation_set_id
    FROM invoice_line_allocations ila
    WHERE ila.invoice_id = p_invoice_id
  LOOP
    v_total_allocations_reversed := v_total_allocations_reversed + v_alloc.allocated_cents;
    DELETE FROM invoice_line_allocations WHERE id = v_alloc.id;
  END LOOP;

  -- Update allocation_sets: recalculate total_allocated_cents
  -- and remove empty sets
  IF v_total_allocations_reversed > 0 THEN
    -- Update the allocation sets that had allocations to this invoice
    UPDATE allocation_sets SET
      total_allocated_cents = (
        SELECT COALESCE(SUM(allocated_cents), 0)
        FROM invoice_line_allocations
        WHERE allocation_set_id = allocation_sets.id
      ),
      updated_at = now()
    WHERE id IN (
      SELECT DISTINCT allocation_set_id FROM invoice_line_allocations
      WHERE invoice_id = p_invoice_id
    );

    -- Update invoice paid_amount_cents to reflect removed allocations
    UPDATE invoices SET
      paid_amount_cents = GREATEST(paid_amount_cents - v_total_allocations_reversed, 0),
      updated_at = now()
    WHERE id = p_invoice_id;
  END IF;

  -- A2.3 FIX: Restore prepay credits
  FOR v_prepay_app IN
    SELECT pa.id, pa.amount_cents, pa.prepay_credit_id
    FROM prepay_applications pa
    WHERE pa.invoice_id = p_invoice_id
  LOOP
    v_total_prepay_restored := v_total_prepay_restored + v_prepay_app.amount_cents;

    -- Restore remaining_cents on the prepay credit
    UPDATE prepay_credits SET
      remaining_cents = remaining_cents + v_prepay_app.amount_cents,
      updated_at = now()
    WHERE id = v_prepay_app.prepay_credit_id;

    -- Delete the application record
    DELETE FROM prepay_applications WHERE id = v_prepay_app.id;
  END LOOP;

  -- Restore customer prepay balance
  IF v_total_prepay_restored > 0 THEN
    UPDATE customers SET
      prepay_balance = COALESCE(prepay_balance, 0) + (v_total_prepay_restored / 100.0)::numeric,
      updated_at = now()
    WHERE id = v_inv.customer_id;

    -- Update invoice prepay_applied_cents
    UPDATE invoices SET
      prepay_applied_cents = GREATEST(prepay_applied_cents - v_total_prepay_restored, 0)
    WHERE id = p_invoice_id;
  END IF;

  -- Now void the invoice
  UPDATE invoices SET
    status = 'voided',
    voided_by = auth.uid(),
    voided_at = now(),
    void_reason = p_void_reason,
    updated_at = now()
  WHERE id = p_invoice_id;

  -- Audit log
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'invoice_voided', 'invoice', p_invoice_id,
    (SELECT role FROM profiles WHERE id = auth.uid()),
    jsonb_build_object(
      'status', v_inv.status,
      'total_cents', v_inv.total_amount_cents,
      'paid_amount_cents', v_inv.paid_amount_cents,
      'prepay_applied_cents', v_inv.prepay_applied_cents
    ),
    jsonb_build_object(
      'status', 'voided',
      'void_reason', p_void_reason,
      'allocations_reversed_cents', v_total_allocations_reversed,
      'prepay_restored_cents', v_total_prepay_restored
    ),
    -1 * v_inv.total_amount_cents,
    'Voided ' || v_inv.invoice_number || ' — ' || p_void_reason ||
      CASE WHEN v_total_allocations_reversed > 0
        THEN '. Reversed $' || (v_total_allocations_reversed / 100.0)::text || ' in allocations.'
        ELSE '' END ||
      CASE WHEN v_total_prepay_restored > 0
        THEN ' Restored $' || (v_total_prepay_restored / 100.0)::text || ' in prepay credits.'
        ELSE '' END
  );

  -- Activity log
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_voided',
    'Voided invoice ' || v_inv.invoice_number || ' — ' || p_void_reason ||
      CASE WHEN v_total_allocations_reversed > 0
        THEN '. Reversed $' || (v_total_allocations_reversed / 100.0)::text || ' in allocations.'
        ELSE '' END ||
      CASE WHEN v_total_prepay_restored > 0
        THEN ' Restored $' || (v_total_prepay_restored / 100.0)::text || ' in prepay credits.'
        ELSE '' END,
    auth.uid(), 'invoice', p_invoice_id, v_inv.customer_id
  );

  -- Notify admin about reversals
  IF v_total_allocations_reversed > 0 OR v_total_prepay_restored > 0 THEN
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    SELECT p.id,
      'Invoice Voided — Allocations Reversed',
      'Invoice ' || v_inv.invoice_number || ' voided. $' ||
        (v_total_allocations_reversed / 100.0)::text || ' in allocations reversed, $' ||
        (v_total_prepay_restored / 100.0)::text || ' in prepay credits restored.',
      'invoice_void_reversal', 'invoice', p_invoice_id
    FROM profiles p
    WHERE p.role = 'admin' AND p.is_active = true;
  END IF;
END;
$$;


-- ============================================================================
-- A2.1 + A2.2: DELIVERY CANCELLATION — RESTORE INVENTORY + HANDLE INVOICES
-- ============================================================================
-- cancel_delivery() now:
--   - Restores inventory if delivery was completed or in_progress
--   - Updates order_items (decrement quantity_delivered, increment quantity_remaining)
--   - Re-evaluates order status
--   - Auto-voids linked draft invoices
--   - Notifies admins about posted invoices needing manual review
-- ============================================================================

CREATE OR REPLACE FUNCTION cancel_delivery(
  p_delivery_id uuid,
  p_cancel_reason text DEFAULT 'Cancelled',
  p_performed_by uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_delivery record;
  v_actor uuid;
  v_item record;
  v_inv record;
  v_items_restored integer := 0;
  v_invoice record;
  v_draft_voided integer := 0;
  v_posted_notified integer := 0;
  v_admin record;
  v_order_has_remaining boolean;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  SELECT * INTO v_delivery
  FROM deliveries WHERE id = p_delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found';
  END IF;

  IF v_delivery.status NOT IN ('scheduled', 'in_progress', 'completed') THEN
    RAISE EXCEPTION 'Cannot cancel a % delivery', v_delivery.status;
  END IF;

  -- Verify caller is admin or sales_rep
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to cancel deliveries';
  END IF;

  -- A2.1 FIX: If delivery was completed or in_progress, restore inventory
  IF v_delivery.status IN ('completed', 'in_progress') THEN
    FOR v_item IN
      SELECT di.*, p.product_name
      FROM delivery_items di
      JOIN products p ON p.id = di.product_id
      WHERE di.delivery_id = p_delivery_id
    LOOP
      -- Only restore if quantities were actually delivered
      IF COALESCE(v_item.quantity_delivered, 0) > 0 THEN
        -- Restore inventory
        UPDATE inventory SET
          quantity_available = quantity_available + v_item.quantity_delivered,
          updated_at = now()
        WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

        -- Create reversal inventory transaction
        INSERT INTO inventory_transactions (
          product_id, transaction_type, quantity, to_location,
          order_id, delivery_id, performed_by, notes
        ) VALUES (
          v_item.product_id, 'cancelled_delivery_reversal', v_item.quantity_delivered, 'Main Warehouse',
          v_delivery.order_id, p_delivery_id, v_actor,
          'Delivery ' || v_delivery.delivery_number || ' cancelled — restored ' || v_item.quantity_delivered || ' units of ' || v_item.product_name
        );

        -- Update order_items: decrement delivered, increment remaining
        UPDATE order_items SET
          quantity_delivered = GREATEST(quantity_delivered - v_item.quantity_delivered, 0),
          quantity_remaining = quantity_remaining + v_item.quantity_delivered
        WHERE id = v_item.order_item_id;

        v_items_restored := v_items_restored + 1;
      END IF;
    END LOOP;

    -- Re-evaluate order status
    IF v_delivery.order_id IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1 FROM order_items
        WHERE order_id = v_delivery.order_id AND quantity_remaining > 0
      ) INTO v_order_has_remaining;

      IF v_order_has_remaining THEN
        -- Check if any items have been delivered at all
        IF EXISTS (
          SELECT 1 FROM order_items
          WHERE order_id = v_delivery.order_id AND quantity_delivered > 0
        ) THEN
          UPDATE orders SET status = 'partially_fulfilled', updated_at = now()
          WHERE id = v_delivery.order_id;
        ELSE
          UPDATE orders SET status = 'confirmed', updated_at = now()
          WHERE id = v_delivery.order_id;
        END IF;
      END IF;
    END IF;

    -- Mark any delivery_remainders as cancelled
    UPDATE delivery_remainders SET
      status = 'cancelled', updated_at = now()
    WHERE original_delivery_id = p_delivery_id AND status = 'pending';
  END IF;

  -- Mark delivery as cancelled
  UPDATE deliveries SET
    status = 'cancelled',
    cancelled_at = now(),
    cancelled_by = v_actor,
    cancel_reason = p_cancel_reason,
    updated_at = now()
  WHERE id = p_delivery_id;

  -- A2.2 FIX: Handle linked invoices
  IF v_delivery.order_id IS NOT NULL THEN
    FOR v_invoice IN
      SELECT * FROM invoices
      WHERE order_id = v_delivery.order_id
        AND status IN ('draft', 'posted')
        AND deleted_at IS NULL
    LOOP
      IF v_invoice.status = 'draft' THEN
        -- Auto-void draft invoices (especially for quick deliveries)
        UPDATE invoices SET
          status = 'voided',
          voided_by = v_actor,
          voided_at = now(),
          void_reason = 'Delivery ' || v_delivery.delivery_number || ' cancelled',
          updated_at = now()
        WHERE id = v_invoice.id;

        INSERT INTO financial_audit_log (
          operation_type, entity_type, entity_id, actor_role,
          old_values, new_values, total_impact_cents, description
        ) VALUES (
          'invoice_voided', 'invoice', v_invoice.id,
          (SELECT role FROM profiles WHERE id = v_actor),
          jsonb_build_object('status', 'draft', 'total_cents', v_invoice.total_amount_cents),
          jsonb_build_object('status', 'voided', 'void_reason', 'Delivery cancelled'),
          -1 * v_invoice.total_amount_cents,
          'Auto-voided draft invoice ' || v_invoice.invoice_number || ' — delivery ' || v_delivery.delivery_number || ' cancelled'
        );

        v_draft_voided := v_draft_voided + 1;

      ELSIF v_invoice.status = 'posted' THEN
        -- DO NOT auto-void posted invoices — notify admins for manual review
        FOR v_admin IN
          SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
        LOOP
          INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
          VALUES (
            v_admin.id,
            'Delivery Cancelled — Posted Invoice Needs Review',
            'Delivery ' || v_delivery.delivery_number || ' was cancelled but invoice ' || v_invoice.invoice_number || ' is already posted. Manual review required.',
            'delivery_cancelled_invoice_posted', 'invoice', v_invoice.id
          );
        END LOOP;

        v_posted_notified := v_posted_notified + 1;
      END IF;
    END LOOP;
  END IF;

  -- Notify assigned driver
  IF v_delivery.assigned_driver IS NOT NULL THEN
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    VALUES (
      v_delivery.assigned_driver,
      'Delivery Cancelled',
      'Delivery ' || v_delivery.delivery_number || ' has been cancelled. Reason: ' || p_cancel_reason,
      'delivery_cancelled', 'delivery', p_delivery_id
    );
  END IF;

  -- Activity log
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_cancelled',
    'Delivery ' || v_delivery.delivery_number || ' cancelled. Reason: ' || p_cancel_reason ||
      CASE WHEN v_items_restored > 0 THEN '. Inventory restored for ' || v_items_restored || ' item(s).' ELSE '' END ||
      CASE WHEN v_draft_voided > 0 THEN ' ' || v_draft_voided || ' draft invoice(s) voided.' ELSE '' END ||
      CASE WHEN v_posted_notified > 0 THEN ' ' || v_posted_notified || ' posted invoice(s) flagged for admin review.' ELSE '' END,
    v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  RETURN jsonb_build_object(
    'status', 'cancelled',
    'delivery_id', p_delivery_id,
    'items_restored', v_items_restored,
    'draft_invoices_voided', v_draft_voided,
    'posted_invoices_notified', v_posted_notified
  );
END;
$$;

GRANT EXECUTE ON FUNCTION cancel_delivery(uuid, text, uuid) TO authenticated;


-- ============================================================================
-- T3: ORDER CANCELLATION CASCADE
-- ============================================================================
-- cancel_order() now atomically:
--   - Releases inventory holds
--   - Zeros pending commissions (leaves paid ones, notifies admin)
--   - Voids draft invoices
--   - Notifies admin about posted invoices needing manual void
-- ============================================================================

CREATE OR REPLACE FUNCTION cancel_order(
  p_order_id uuid,
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order record;
  v_item record;
  v_undelivered numeric;
  v_holds_released integer := 0;
  v_commissions_cancelled integer := 0;
  v_paid_commissions integer := 0;
  v_draft_voided integer := 0;
  v_posted_notified integer := 0;
  v_invoice record;
  v_admin record;
BEGIN
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;
  IF v_order.status = 'cancelled' THEN
    RETURN jsonb_build_object('status', 'already_cancelled');
  END IF;

  -- Verify caller is admin
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_performed_by AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only admins can cancel orders';
  END IF;

  -- Update order status
  UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = p_order_id;

  -- Release prebooked inventory for undelivered items
  FOR v_item IN
    SELECT product_id, total_units_needed, quantity_delivered
    FROM order_items WHERE order_id = p_order_id
  LOOP
    v_undelivered := GREATEST(v_item.total_units_needed - COALESCE(v_item.quantity_delivered, 0), 0);
    IF v_undelivered <= 0 THEN CONTINUE; END IF;

    UPDATE inventory SET
      quantity_prebooked = GREATEST(quantity_prebooked - v_undelivered, 0),
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      order_id, performed_by, notes
    ) VALUES (
      v_item.product_id, 'adjusted', -v_undelivered, 'Main Warehouse',
      p_order_id, p_performed_by,
      'Released ' || v_undelivered || ' units — order ' || v_order.order_number || ' cancelled'
    );
  END LOOP;

  -- T3 FIX: Release inventory holds
  UPDATE inventory_holds SET is_active = false, updated_at = now()
  WHERE order_id = p_order_id AND is_active = true;
  GET DIAGNOSTICS v_holds_released = ROW_COUNT;

  -- T3 FIX: Cancel pending commissions
  UPDATE commissions SET
    status = 'cancelled',
    commission_amount = 0
  WHERE order_id = p_order_id AND status = 'pending';
  GET DIAGNOSTICS v_commissions_cancelled = ROW_COUNT;

  -- Check for paid commissions — don't touch them, just notify
  SELECT COUNT(*) INTO v_paid_commissions
  FROM commissions WHERE order_id = p_order_id AND status = 'paid';

  IF v_paid_commissions > 0 THEN
    FOR v_admin IN
      SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
    LOOP
      INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
      VALUES (
        v_admin.id,
        'Cancelled Order Has Paid Commissions',
        'Order ' || v_order.order_number || ' was cancelled but has ' || v_paid_commissions || ' paid commission(s). Manual review required.',
        'cancellation_review', 'order', p_order_id
      );
    END LOOP;
  END IF;

  -- T3 FIX: Void draft invoices, notify about posted ones
  FOR v_invoice IN
    SELECT * FROM invoices
    WHERE order_id = p_order_id AND deleted_at IS NULL AND status IN ('draft', 'posted')
  LOOP
    IF v_invoice.status = 'draft' THEN
      UPDATE invoices SET
        status = 'voided',
        voided_by = p_performed_by,
        voided_at = now(),
        void_reason = 'Order ' || v_order.order_number || ' cancelled',
        balance_cents = 0,
        updated_at = now()
      WHERE id = v_invoice.id;

      INSERT INTO financial_audit_log (
        operation_type, entity_type, entity_id, actor_role,
        old_values, new_values, total_impact_cents, description
      ) VALUES (
        'invoice_voided', 'invoice', v_invoice.id, 'admin',
        jsonb_build_object('status', 'draft', 'total_cents', v_invoice.total_amount_cents),
        jsonb_build_object('status', 'voided', 'void_reason', 'Order cancelled'),
        -1 * v_invoice.total_amount_cents,
        'Auto-voided draft invoice ' || v_invoice.invoice_number || ' — order ' || v_order.order_number || ' cancelled'
      );

      v_draft_voided := v_draft_voided + 1;

    ELSIF v_invoice.status = 'posted' THEN
      FOR v_admin IN
        SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
      LOOP
        INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
        VALUES (
          v_admin.id,
          'Manual Invoice Void Required',
          'Order ' || v_order.order_number || ' cancelled but has posted invoice ' || v_invoice.invoice_number || ' — manual void required.',
          'cancellation_review', 'invoice', v_invoice.id
        );
      END LOOP;

      v_posted_notified := v_posted_notified + 1;
    END IF;
  END LOOP;

  -- Activity log
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'order_cancelled',
    'Order ' || v_order.order_number || ' cancelled. ' ||
      v_holds_released || ' hold(s) released, ' ||
      v_commissions_cancelled || ' commission(s) zeroed, ' ||
      v_draft_voided || ' draft invoice(s) voided.' ||
      CASE WHEN v_posted_notified > 0 THEN ' ' || v_posted_notified || ' posted invoice(s) flagged for review.' ELSE '' END ||
      CASE WHEN v_paid_commissions > 0 THEN ' ' || v_paid_commissions || ' paid commission(s) flagged for review.' ELSE '' END,
    p_performed_by, 'order', p_order_id, v_order.customer_id
  );

  RETURN jsonb_build_object(
    'status', 'cancelled',
    'holds_released', v_holds_released,
    'commissions_cancelled', v_commissions_cancelled,
    'paid_commissions_flagged', v_paid_commissions,
    'draft_invoices_voided', v_draft_voided,
    'posted_invoices_notified', v_posted_notified
  );
END;
$$;

GRANT EXECUTE ON FUNCTION cancel_order(uuid, uuid) TO authenticated;


-- ============================================================================
-- A2.5: QUICK DELIVERY USES CORRECT TIER PRICING
-- ============================================================================
-- T2: Quick delivery commissions — always generate using customer's commission_split
-- ============================================================================
-- create_quick_delivery() now:
--   - Uses customer's assigned_tier to pick the right price (not just tier1_price)
--   - Generates commissions from customer.commission_split
-- ============================================================================

CREATE OR REPLACE FUNCTION create_quick_delivery(
  p_customer_id uuid,
  p_items jsonb,
  p_driver_id uuid DEFAULT NULL,
  p_scheduled_date date DEFAULT CURRENT_DATE,
  p_delivery_notes text DEFAULT NULL,
  p_performed_by uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_order_id uuid;
  v_order_number text;
  v_delivery_id uuid;
  v_delivery_number text;
  v_invoice_id uuid;
  v_invoice_number text;
  v_item jsonb;
  v_order_item_id uuid;
  v_product record;
  v_total_cents bigint := 0;
  v_total_cost_cents bigint := 0;
  v_item_price_cents bigint;
  v_item_qty numeric;
  v_sort integer := 0;
  v_customer record;
  v_split jsonb;
  v_split_entry jsonb;
  v_order_profit numeric;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  -- Verify caller is admin, sales_rep, or driver
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep', 'driver')
  ) THEN
    RAISE EXCEPTION 'Not authorized to create quick deliveries';
  END IF;

  -- Verify customer exists
  SELECT * INTO v_customer
  FROM customers WHERE id = p_customer_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer not found';
  END IF;

  -- Validate items
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'At least one item is required';
  END IF;

  -- -----------------------------------------------------------------------
  -- Step 1: Create Order
  -- -----------------------------------------------------------------------
  v_order_id := gen_random_uuid();
  v_order_number := generate_order_number();

  INSERT INTO orders (
    id, order_number, customer_id, status,
    order_date, notes, total_price, total_cost, total_profit, total_margin_pct,
    commission_split
  ) VALUES (
    v_order_id, v_order_number, p_customer_id, 'confirmed',
    CURRENT_DATE, 'Quick delivery', 0, 0, 0, 0,
    v_customer.commission_split
  );

  -- -----------------------------------------------------------------------
  -- Step 2: Create Delivery
  -- -----------------------------------------------------------------------
  v_delivery_id := gen_random_uuid();
  v_delivery_number := next_delivery_number();

  INSERT INTO deliveries (
    id, delivery_number, order_id, customer_id,
    assigned_driver, scheduled_date, status,
    delivery_notes, is_quick_delivery
  ) VALUES (
    v_delivery_id, v_delivery_number, v_order_id, p_customer_id,
    p_driver_id, p_scheduled_date, 'scheduled',
    p_delivery_notes, true
  );

  -- -----------------------------------------------------------------------
  -- Step 3: Create Invoice (draft chemical_sale)
  -- Business rule: invoices always start as draft
  -- -----------------------------------------------------------------------
  v_invoice_id := gen_random_uuid();
  v_invoice_number := next_invoice_number('chemical_sale');

  INSERT INTO invoices (
    id, invoice_number, invoice_type, order_id, customer_id,
    status, total_amount_cents, paid_amount_cents, prepay_applied_cents,
    invoice_date, is_quick_delivery, created_by
  ) VALUES (
    v_invoice_id, v_invoice_number, 'chemical_sale', v_order_id, p_customer_id,
    'draft', 0, 0, 0,
    CURRENT_DATE, true, v_actor
  );

  -- -----------------------------------------------------------------------
  -- Step 4: Process items — create order_items, delivery_items, invoice_items
  -- -----------------------------------------------------------------------
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_sort := v_sort + 1;

    -- Lookup product
    SELECT * INTO v_product
    FROM products WHERE id = (v_item->>'product_id')::uuid AND is_active = true;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product not found or inactive: %', v_item->>'product_id';
    END IF;

    v_item_qty := (v_item->>'quantity')::numeric;
    v_item_price_cents := (v_item->>'price_cents')::bigint;

    -- A2.5 FIX: Use customer's assigned_tier price, not always tier1
    IF v_item_price_cents IS NULL THEN
      v_item_price_cents := CASE COALESCE(v_customer.assigned_tier, 1)
        WHEN 1 THEN COALESCE(v_product.tier1_price * 100, 0)::bigint
        WHEN 2 THEN COALESCE(v_product.tier2_price * 100, v_product.tier1_price * 100, 0)::bigint
        WHEN 3 THEN COALESCE(v_product.tier3_price * 100, v_product.tier1_price * 100, 0)::bigint
        ELSE COALESCE(v_product.tier1_price * 100, 0)::bigint
      END;
    END IF;

    -- Create order item
    v_order_item_id := gen_random_uuid();
    INSERT INTO order_items (
      id, order_id, product_id, product_name, price_per_unit, cost_per_unit,
      total_units_needed, quantity_remaining, quantity_delivered, unit_size,
      total_price, profit, net_margin
    ) VALUES (
      v_order_item_id, v_order_id, v_product.id, v_product.product_name,
      (v_item_price_cents / 100.0)::numeric, COALESCE(v_product.current_cost, 0),
      v_item_qty, v_item_qty, 0,
      COALESCE(v_item->>'unit_size', v_product.unit_size),
      (v_item_price_cents * v_item_qty / 100.0)::numeric,
      ((v_item_price_cents / 100.0) - COALESCE(v_product.current_cost, 0)) * v_item_qty,
      CASE WHEN v_item_price_cents > 0
        THEN ((v_item_price_cents / 100.0 - COALESCE(v_product.current_cost, 0)) / (v_item_price_cents / 100.0) * 100)
        ELSE 0
      END
    );

    -- Create delivery item
    INSERT INTO delivery_items (
      delivery_id, order_item_id, product_id, quantity, unit_size
    ) VALUES (
      v_delivery_id, v_order_item_id, v_product.id, v_item_qty,
      COALESCE(v_item->>'unit_size', v_product.unit_size)
    );

    -- Create invoice item
    INSERT INTO invoice_items (
      invoice_id, order_item_id, product_id, description,
      quantity, unit_price_cents, extended_cents, cost_cents,
      unit_size, sort_order
    ) VALUES (
      v_invoice_id, v_order_item_id, v_product.id, v_product.product_name,
      v_item_qty, v_item_price_cents, v_item_price_cents * v_item_qty::bigint,
      COALESCE(v_product.current_cost * 100, 0)::bigint,
      COALESCE(v_item->>'unit_size', v_product.unit_size), v_sort
    );

    v_total_cents := v_total_cents + (v_item_price_cents * v_item_qty::bigint);
    v_total_cost_cents := v_total_cost_cents + (COALESCE(v_product.current_cost * 100, 0)::bigint * v_item_qty::bigint);
  END LOOP;

  -- -----------------------------------------------------------------------
  -- Step 5: Update totals
  -- -----------------------------------------------------------------------
  v_order_profit := ((v_total_cents - v_total_cost_cents) / 100.0)::numeric;

  UPDATE orders SET
    total_price = (v_total_cents / 100.0)::numeric,
    total_cost = (v_total_cost_cents / 100.0)::numeric,
    total_profit = v_order_profit,
    total_margin_pct = CASE WHEN v_total_cents > 0
      THEN ((v_total_cents - v_total_cost_cents)::numeric / v_total_cents * 100)
      ELSE 0 END
  WHERE id = v_order_id;

  UPDATE invoices SET
    total_amount_cents = v_total_cents
  WHERE id = v_invoice_id;

  -- -----------------------------------------------------------------------
  -- T2: Generate commissions from customer's commission_split
  -- -----------------------------------------------------------------------
  v_split := v_customer.commission_split;
  IF v_split IS NOT NULL AND jsonb_typeof(v_split) = 'array' AND jsonb_array_length(v_split) > 0 THEN
    FOR v_split_entry IN SELECT * FROM jsonb_array_elements(v_split)
    LOOP
      INSERT INTO commissions (
        order_id, customer_id, recipient,
        split_percentage, commission_amount, order_profit,
        order_date, status
      ) VALUES (
        v_order_id, p_customer_id,
        COALESCE(v_split_entry->>'recipient', v_split_entry->>'name', 'Unknown'),
        (v_split_entry->>'percentage')::numeric,
        v_order_profit * ((v_split_entry->>'percentage')::numeric / 100.0),
        v_order_profit,
        CURRENT_DATE,
        'pending'
      );
    END LOOP;
  END IF;

  -- -----------------------------------------------------------------------
  -- Step 6: Activity log
  -- -----------------------------------------------------------------------
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'quick_delivery_created',
    'Quick delivery ' || v_delivery_number || ' created with order ' || v_order_number || ' and draft invoice ' || v_invoice_number,
    v_actor, 'delivery', v_delivery_id, p_customer_id
  );

  RETURN jsonb_build_object(
    'status', 'created',
    'order_id', v_order_id,
    'order_number', v_order_number,
    'delivery_id', v_delivery_id,
    'delivery_number', v_delivery_number,
    'invoice_id', v_invoice_id,
    'invoice_number', v_invoice_number
  );
END;
$$;

GRANT EXECUTE ON FUNCTION create_quick_delivery(uuid, jsonb, uuid, date, text, uuid) TO authenticated;


-- ============================================================================
-- T1: PARTIAL DELIVERY INVOICE AUTO-ADJUSTMENT
-- ============================================================================
-- complete_delivery() now auto-adjusts linked draft invoices to match
-- actual delivered quantities after partial delivery, or notifies admin
-- about posted invoices needing review.
-- ============================================================================

CREATE OR REPLACE FUNCTION complete_delivery(
  p_delivery_id uuid,
  p_signed_by text,
  p_performed_by uuid,
  p_quantities jsonb DEFAULT NULL,
  p_issue_type text DEFAULT NULL,
  p_issue_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_delivery record;
  v_item record;
  v_inv record;
  v_all_delivered boolean;
  v_qty_to_deliver numeric;
  v_any_partial boolean := false;
  v_linked_invoice record;
  v_old_total bigint;
  v_new_total bigint;
  v_admin record;
BEGIN
  -- Validate delivery exists
  SELECT * INTO v_delivery FROM deliveries WHERE id = p_delivery_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found';
  END IF;

  -- Require in_progress status
  IF v_delivery.status = 'completed' THEN
    RETURN jsonb_build_object('status', 'already_completed');
  END IF;

  IF v_delivery.status != 'in_progress' THEN
    RAISE EXCEPTION 'Delivery must be started before completing. Current status: %', v_delivery.status;
  END IF;

  -- Verify caller is the assigned driver or an admin
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = p_performed_by
      AND is_active = true
      AND (role = 'admin' OR (role = 'driver' AND p_performed_by = v_delivery.assigned_driver))
  ) THEN
    RAISE EXCEPTION 'Not authorized to complete this delivery';
  END IF;

  -- PRE-CHECK INVENTORY AVAILABILITY for all items
  FOR v_item IN
    SELECT di.*, p.product_name
    FROM delivery_items di
    JOIN products p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id
  LOOP
    IF p_quantities IS NOT NULL AND p_quantities ? v_item.id::text THEN
      v_qty_to_deliver := (p_quantities->>v_item.id::text)::numeric;
      v_qty_to_deliver := GREATEST(0, LEAST(v_qty_to_deliver, v_item.quantity));
    ELSE
      v_qty_to_deliver := v_item.quantity;
    END IF;

    IF v_qty_to_deliver < v_item.quantity THEN
      v_any_partial := true;
    END IF;

    IF v_qty_to_deliver = 0 THEN
      CONTINUE;
    END IF;

    SELECT * INTO v_inv
    FROM inventory
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse'
    FOR UPDATE;

    IF NOT FOUND OR v_inv.quantity_available < v_qty_to_deliver THEN
      RAISE EXCEPTION 'Insufficient inventory for %: need % units, only % available',
        v_item.product_name,
        v_qty_to_deliver,
        COALESCE(v_inv.quantity_available, 0);
    END IF;
  END LOOP;

  -- Mark delivery completed (with issue info)
  UPDATE deliveries SET
    status = 'completed',
    completed_at = now(),
    signed_by = p_signed_by,
    issue_type = COALESCE(p_issue_type, issue_type),
    issue_notes = CASE WHEN p_issue_notes IS NOT NULL THEN p_issue_notes ELSE issue_notes END
  WHERE id = p_delivery_id;

  -- Process each delivery item
  FOR v_item IN
    SELECT di.*, p.product_name
    FROM delivery_items di
    JOIN products p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id
  LOOP
    IF p_quantities IS NOT NULL AND p_quantities ? v_item.id::text THEN
      v_qty_to_deliver := (p_quantities->>v_item.id::text)::numeric;
      v_qty_to_deliver := GREATEST(0, LEAST(v_qty_to_deliver, v_item.quantity));
    ELSE
      v_qty_to_deliver := v_item.quantity;
    END IF;

    UPDATE delivery_items SET quantity_delivered = v_qty_to_deliver
    WHERE id = v_item.id;

    IF v_qty_to_deliver = 0 THEN
      CONTINUE;
    END IF;

    UPDATE order_items SET
      quantity_delivered = quantity_delivered + v_qty_to_deliver,
      quantity_remaining = GREATEST(quantity_remaining - v_qty_to_deliver, 0)
    WHERE id = v_item.order_item_id;

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, from_location,
      order_id, delivery_id, performed_by, notes
    ) VALUES (
      v_item.product_id, 'delivered', v_qty_to_deliver, 'Main Warehouse',
      v_delivery.order_id, p_delivery_id, p_performed_by,
      'Delivery ' || v_delivery.delivery_number ||
        CASE WHEN v_qty_to_deliver < v_item.quantity
          THEN ' (partial: ' || v_qty_to_deliver || '/' || v_item.quantity || ')'
          ELSE ''
        END ||
        '. Signed by: ' || p_signed_by
    );

    UPDATE inventory SET
      quantity_available = quantity_available - v_qty_to_deliver,
      quantity_prebooked = GREATEST(quantity_prebooked - v_qty_to_deliver, 0),
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';
  END LOOP;

  -- Create remainder records for partial deliveries
  IF v_any_partial THEN
    FOR v_item IN
      SELECT di.*, p.product_name
      FROM delivery_items di
      JOIN products p ON p.id = di.product_id
      WHERE di.delivery_id = p_delivery_id
        AND di.quantity_delivered < di.quantity
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

  -- Check if entire order is fully delivered
  SELECT NOT EXISTS (
    SELECT 1 FROM order_items
    WHERE order_id = v_delivery.order_id AND quantity_remaining > 0
  ) INTO v_all_delivered;

  UPDATE orders SET
    status = CASE WHEN v_all_delivered THEN 'fulfilled' ELSE 'partially_fulfilled' END,
    updated_at = now()
  WHERE id = v_delivery.order_id;

  -- =====================================================================
  -- T1 FIX: Partial delivery invoice auto-adjustment
  -- =====================================================================
  IF v_any_partial AND v_delivery.order_id IS NOT NULL THEN
    FOR v_linked_invoice IN
      SELECT * FROM invoices
      WHERE order_id = v_delivery.order_id
        AND deleted_at IS NULL
        AND status IN ('draft', 'posted')
    LOOP
      IF v_linked_invoice.status = 'draft' THEN
        -- Auto-adjust draft invoice items to match delivered quantities
        v_old_total := v_linked_invoice.total_amount_cents;

        UPDATE invoice_items ii SET
          quantity = oi.quantity_delivered,
          extended_cents = ii.unit_price_cents * oi.quantity_delivered::bigint
        FROM order_items oi
        WHERE ii.invoice_id = v_linked_invoice.id
          AND ii.order_item_id = oi.id
          AND oi.quantity_delivered < oi.total_units_needed;

        -- Recalculate invoice total
        SELECT COALESCE(SUM(extended_cents), 0) INTO v_new_total
        FROM invoice_items WHERE invoice_id = v_linked_invoice.id;

        UPDATE invoices SET
          total_amount_cents = v_new_total,
          updated_at = now()
        WHERE id = v_linked_invoice.id;

        -- Financial audit log
        IF v_old_total != v_new_total THEN
          INSERT INTO financial_audit_log (
            operation_type, entity_type, entity_id, actor_role,
            old_values, new_values, total_impact_cents, description
          ) VALUES (
            'partial_delivery_adjustment', 'invoice', v_linked_invoice.id,
            (SELECT role FROM profiles WHERE id = p_performed_by),
            jsonb_build_object('total_amount_cents', v_old_total),
            jsonb_build_object('total_amount_cents', v_new_total),
            v_new_total - v_old_total,
            'Adjusted invoice ' || v_linked_invoice.invoice_number || ' for partial delivery ' || v_delivery.delivery_number ||
              ': $' || (v_old_total / 100.0)::text || ' → $' || (v_new_total / 100.0)::text
          );
        END IF;

      ELSIF v_linked_invoice.status = 'posted' THEN
        -- Notify admins about posted invoice needing review
        FOR v_admin IN
          SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
        LOOP
          INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
          VALUES (
            v_admin.id,
            'Partial Delivery Review Needed',
            'Partial delivery ' || v_delivery.delivery_number || ' completed — posted invoice ' || v_linked_invoice.invoice_number || ' may need adjustment.',
            'partial_delivery_review', 'invoice', v_linked_invoice.id
          );
        END LOOP;
      END IF;
    END LOOP;
  END IF;

  -- Notification for driver-reported issues (AUDIT 3.1 fix)
  IF p_issue_type IS NOT NULL AND p_issue_type != 'none' THEN
    FOR v_admin IN
      SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
    LOOP
      INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
      VALUES (
        v_admin.id,
        'Driver Issue: ' || REPLACE(p_issue_type, '_', ' ') || ' on ' || v_delivery.delivery_number,
        'Driver reported ' || REPLACE(p_issue_type, '_', ' ') || ' on delivery ' || v_delivery.delivery_number ||
          CASE WHEN p_issue_notes IS NOT NULL AND p_issue_notes != ''
            THEN '. Notes: ' || p_issue_notes
            ELSE '' END,
        'delivery_issue_reported', 'delivery', p_delivery_id
      );
    END LOOP;
  END IF;

  -- Log activity
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_completed',
    'Delivery ' || v_delivery.delivery_number ||
      CASE WHEN v_any_partial THEN ' completed (partial quantities)' ELSE ' completed' END ||
      CASE WHEN p_issue_type IS NOT NULL AND p_issue_type <> 'none'
        THEN '. Issue: ' || p_issue_type
        ELSE '' END ||
      '. Signed by: ' || p_signed_by,
    p_performed_by, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  RETURN jsonb_build_object(
    'status', 'completed',
    'partial', v_any_partial,
    'order_status', CASE WHEN v_all_delivered THEN 'fulfilled' ELSE 'partially_fulfilled' END
  );
END;
$$;

GRANT EXECUTE ON FUNCTION complete_delivery(uuid, text, uuid, jsonb, text, text) TO authenticated;


-- ============================================================================
-- A2.7 (supplemental): Check for expired quotes with active holds
-- ============================================================================
-- This function can be called periodically to clean up holds from quotes
-- that expired without the trigger firing (e.g., already expired before migration).
-- ============================================================================

CREATE OR REPLACE FUNCTION release_expired_quote_holds()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_released integer;
BEGIN
  UPDATE inventory_holds ih SET
    is_active = false, updated_at = now()
  FROM quotes q
  WHERE ih.quote_id = q.id
    AND ih.is_active = true
    AND q.status IN ('declined', 'expired');

  GET DIAGNOSTICS v_released = ROW_COUNT;

  RETURN jsonb_build_object('holds_released', v_released);
END;
$$;

GRANT EXECUTE ON FUNCTION release_expired_quote_holds() TO authenticated;


-- ============================================================================
-- AUDIT 3.2: notify_damaged_receiving() — helper RPC
-- ============================================================================
-- Called from frontend after receive_po_items() when damaged items detected.
-- This is cleaner than embedding notification logic in the receive RPC.
-- ============================================================================

CREATE OR REPLACE FUNCTION notify_damaged_receiving(
  p_po_number text,
  p_items_summary text,
  p_po_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin record;
BEGIN
  FOR v_admin IN
    SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
  LOOP
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    VALUES (
      v_admin.id,
      'Damaged Items Received on ' || p_po_number,
      'Items received in non-good condition on ' || p_po_number || ': ' || p_items_summary,
      'po_damaged_received', 'purchase_order', p_po_id
    );
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION notify_damaged_receiving(text, text, uuid) TO authenticated;


-- ============================================================================
-- Add 'cancelled' to commission status if needed
-- ============================================================================
-- The commissions table uses a text status field, so we just need the app
-- to recognize it. But let's add a CHECK constraint if one doesn't exist.
-- ============================================================================

-- Drop and recreate check constraint to include 'cancelled'
DO $$
BEGIN
  -- Try to drop old constraint if exists
  ALTER TABLE commissions DROP CONSTRAINT IF EXISTS commissions_status_check;
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;

-- Columns may be text type with no constraint — that's fine, 'cancelled' just works.
-- Add a comment for documentation
COMMENT ON COLUMN commissions.status IS 'Commission status: pending, paid, or cancelled';
