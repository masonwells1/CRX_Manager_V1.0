-- ============================================================================
-- Phase 2: Blend Ticket → Invoice (Pillar 1)
-- One-click invoice creation from approved blend tickets
-- ============================================================================

-- ---------------------------------------------------------------------------
-- RPC: create_invoice_from_blend_ticket
-- Creates a draft invoice from an approved blend ticket.
-- Uses snapshot cost/price if available, falls back to current product data.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_invoice_from_blend_ticket(
  p_blend_ticket_id uuid,
  p_created_by      uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing    text;
  v_ticket      record;
  v_customer    record;
  v_invoice_id  uuid;
  v_item        record;
  v_total_cents bigint := 0;
  v_unit_price  bigint;
  v_unit_cost   bigint;
  v_extended    bigint;
BEGIN
  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN
      RETURN v_existing::uuid;
    END IF;
  END IF;

  -- Fetch blend ticket
  SELECT bt.* INTO v_ticket
  FROM blend_tickets bt
  WHERE bt.id = p_blend_ticket_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Blend ticket not found: %', p_blend_ticket_id;
  END IF;

  -- Validate: must be approved
  IF v_ticket.review_status != 'approved' THEN
    RAISE EXCEPTION 'Blend ticket must be approved. Current status: %', v_ticket.review_status;
  END IF;

  -- Validate: must not already be billed
  IF v_ticket.payment_status = 'billed' THEN
    RAISE EXCEPTION 'Blend ticket is already billed';
  END IF;

  -- Validate: must have a customer
  IF v_ticket.customer_id IS NULL THEN
    RAISE EXCEPTION 'Blend ticket has no customer assigned';
  END IF;

  -- Get customer tier for price lookup
  SELECT * INTO v_customer FROM customers WHERE id = v_ticket.customer_id;

  -- Create invoice (draft status, no order_id, blend_ticket_id set)
  INSERT INTO invoices (
    blend_ticket_id, customer_id, invoice_type, status, season,
    salesman_id, created_by, total_amount_cents, invoice_date
  ) VALUES (
    p_blend_ticket_id, v_ticket.customer_id, 'field_application', 'draft',
    COALESCE(v_ticket.season, current_season()),
    v_ticket.salesman_id,
    p_created_by, 0, CURRENT_DATE
  )
  RETURNING id INTO v_invoice_id;

  -- Create invoice items from blend_ticket_products
  FOR v_item IN
    SELECT btp.*, p.unit_cost AS product_cost,
           p.tier1_price, p.tier2_price, p.tier3_price,
           p.product_name AS full_product_name
    FROM blend_ticket_products btp
    LEFT JOIN products p ON p.id = btp.product_id
    WHERE btp.blend_ticket_id = p_blend_ticket_id
    ORDER BY btp.sequence_order
  LOOP
    -- Use snapshot price if available, otherwise look up current tier price
    IF v_item.unit_price_cents IS NOT NULL THEN
      v_unit_price := v_item.unit_price_cents;
    ELSIF v_item.product_id IS NOT NULL THEN
      v_unit_price := CASE v_customer.assigned_tier
        WHEN 1 THEN COALESCE(round(v_item.tier1_price * 100), 0)
        WHEN 2 THEN COALESCE(round(v_item.tier2_price * 100), 0)
        WHEN 3 THEN COALESCE(round(v_item.tier3_price * 100), 0)
        ELSE COALESCE(round(v_item.tier1_price * 100), 0)
      END;
    ELSE
      v_unit_price := 0;
    END IF;

    -- Use snapshot cost if available, otherwise current product cost
    IF v_item.unit_cost_cents IS NOT NULL THEN
      v_unit_cost := v_item.unit_cost_cents;
    ELSIF v_item.product_id IS NOT NULL THEN
      v_unit_cost := COALESCE(round(v_item.product_cost * 100), 0);
    ELSE
      v_unit_cost := 0;
    END IF;

    v_extended := round(v_unit_price * v_item.quantity);

    INSERT INTO invoice_items (
      invoice_id, product_id, description,
      quantity, unit_price_cents, extended_cents, cost_cents,
      sort_order, rate_per_acre, acres
    ) VALUES (
      v_invoice_id, v_item.product_id,
      COALESCE(v_item.full_product_name, v_item.product_name),
      v_item.quantity, v_unit_price, v_extended, v_unit_cost,
      v_item.sequence_order,
      v_item.rate_per_acre,
      CASE WHEN v_item.rate_per_acre IS NOT NULL AND v_item.rate_per_acre > 0
           THEN round(v_item.quantity / v_item.rate_per_acre, 2)
           ELSE NULL
      END
    );

    v_total_cents := v_total_cents + v_extended;
  END LOOP;

  -- Update invoice total
  UPDATE invoices SET total_amount_cents = v_total_cents WHERE id = v_invoice_id;

  -- Mark blend ticket as billed
  UPDATE blend_tickets
    SET payment_status = 'billed', updated_at = now()
  WHERE id = p_blend_ticket_id;

  -- Financial audit log
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'invoice_created', 'invoice', v_invoice_id,
    COALESCE((SELECT role FROM profiles WHERE id = p_created_by), 'admin'),
    jsonb_build_object(
      'invoice_number', (SELECT invoice_number FROM invoices WHERE id = v_invoice_id),
      'blend_ticket_number', v_ticket.ticket_number,
      'customer_id', v_ticket.customer_id,
      'total_cents', v_total_cents,
      'source', 'blend_ticket'
    ),
    v_total_cents,
    'Invoice created from blend ticket ' || v_ticket.ticket_number
  );

  -- Activity feed
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'invoice_created',
    'Invoice created from blend ticket ' || v_ticket.ticket_number,
    p_created_by, 'invoice', v_invoice_id, v_ticket.customer_id
  );

  -- Save idempotency
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'create_invoice_from_blend_ticket', v_invoice_id::text);
  END IF;

  RETURN v_invoice_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Trigger: Auto-sync payment_status when invoice with blend_ticket_id voided
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sync_blend_ticket_payment_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Only fire for invoices linked to blend tickets
  IF NEW.blend_ticket_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Invoice voided or cancelled → set ticket back to unbilled
  IF NEW.status IN ('voided', 'cancelled') AND OLD.status NOT IN ('voided', 'cancelled') THEN
    UPDATE blend_tickets
      SET payment_status = 'unbilled', updated_at = now()
    WHERE id = NEW.blend_ticket_id
      AND payment_status = 'billed';
  END IF;

  RETURN NEW;
END;
$$;

-- Create the trigger (idempotent)
DROP TRIGGER IF EXISTS trg_sync_blend_ticket_payment ON invoices;
CREATE TRIGGER trg_sync_blend_ticket_payment
  AFTER UPDATE ON invoices
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION sync_blend_ticket_payment_status();
