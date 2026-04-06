-- Migration: Smart Pricing Flow
-- Money: all prices stored as bigint cents, displayed divided by 100
-- 1. Add quoted_price_cents + price_source to invoice_items
-- 2. Add application_service_id to blend_tickets
-- 3. Enhance create_invoice_from_blend_ticket

ALTER TABLE invoice_items
  ADD COLUMN IF NOT EXISTS quoted_price_cents bigint,
  ADD COLUMN IF NOT EXISTS price_source text;

DO $$ BEGIN
  ALTER TABLE invoice_items
    ADD CONSTRAINT chk_invoice_items_price_source
    CHECK (price_source IS NULL OR price_source IN ('quoted','tier','manual'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE blend_tickets
  ADD COLUMN IF NOT EXISTS application_service_id uuid REFERENCES application_services(id);

CREATE INDEX IF NOT EXISTS idx_bt_app_service
  ON blend_tickets(application_service_id) WHERE application_service_id IS NOT NULL;

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
  v_existing text; v_ticket record; v_customer record;
  v_invoice_id uuid; v_item record;
  v_total_cents bigint := 0; v_unit_price bigint; v_unit_cost bigint;
  v_extended bigint; v_price_source text; v_quoted_price bigint;
  v_quote_section_id uuid; v_qi_price numeric;
  v_app_service record; v_fee_rate bigint; v_fee_acres numeric;
  v_fee_extended bigint; v_fee_cost bigint;
  v_planned_acres numeric; v_actual_acres numeric;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing FROM idempotency_keys WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN v_existing::uuid; END IF;
  END IF;

  SELECT bt.* INTO v_ticket FROM blend_tickets bt WHERE bt.id = p_blend_ticket_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Blend ticket not found: %', p_blend_ticket_id; END IF;
  IF v_ticket.review_status != 'approved' THEN RAISE EXCEPTION 'Blend ticket must be approved. Current status: %', v_ticket.review_status; END IF;
  IF v_ticket.payment_status = 'billed' THEN RAISE EXCEPTION 'Blend ticket is already billed'; END IF;
  IF v_ticket.customer_id IS NULL THEN RAISE EXCEPTION 'Blend ticket has no customer assigned'; END IF;

  SELECT * INTO v_customer FROM customers WHERE id = v_ticket.customer_id;

  v_quote_section_id := NULL;
  IF v_ticket.job_id IS NOT NULL THEN
    SELECT j.quote_section_id INTO v_quote_section_id FROM jobs j WHERE j.id = v_ticket.job_id;
  END IF;

  INSERT INTO invoices (
    blend_ticket_id, customer_id, invoice_type, status, season,
    salesman_id, created_by, total_amount_cents, invoice_date
  ) VALUES (
    p_blend_ticket_id, v_ticket.customer_id, 'field_application', 'draft',
    COALESCE(v_ticket.season, current_season()),
    v_ticket.salesman_id, p_created_by, 0, CURRENT_DATE
  ) RETURNING id INTO v_invoice_id;

  FOR v_item IN
    SELECT btp.*, p.unit_cost AS product_cost,
           p.tier1_price, p.tier2_price, p.tier3_price,
           p.product_name AS full_product_name
    FROM blend_ticket_products btp
    LEFT JOIN products p ON p.id = btp.product_id
    WHERE btp.blend_ticket_id = p_blend_ticket_id
    ORDER BY btp.sequence_order
  LOOP
    v_price_source := NULL; v_quoted_price := NULL; v_unit_price := NULL;

    IF v_item.unit_price_cents IS NOT NULL THEN
      v_unit_price := v_item.unit_price_cents;
      v_price_source := 'manual';
    ELSIF v_quote_section_id IS NOT NULL AND v_item.product_id IS NOT NULL THEN
      SELECT qi.price_per_unit INTO v_qi_price
      FROM quote_items qi
      WHERE qi.section_id = v_quote_section_id AND qi.product_id = v_item.product_id
      LIMIT 1;
      IF v_qi_price IS NOT NULL THEN
        v_unit_price := round(v_qi_price * 100)::bigint;
        v_quoted_price := v_unit_price;
        v_price_source := 'quoted';
      END IF;
    END IF;

    IF v_unit_price IS NULL THEN
      IF v_item.product_id IS NOT NULL THEN
        v_unit_price := CASE v_customer.assigned_tier
          WHEN 1 THEN COALESCE(round(v_item.tier1_price * 100), 0)
          WHEN 2 THEN COALESCE(round(v_item.tier2_price * 100), 0)
          WHEN 3 THEN COALESCE(round(v_item.tier3_price * 100), 0)
          ELSE COALESCE(round(v_item.tier1_price * 100), 0)
        END;
      ELSE v_unit_price := 0;
      END IF;
      IF v_price_source IS NULL THEN v_price_source := 'tier'; END IF;
    END IF;

    IF v_item.unit_cost_cents IS NOT NULL THEN v_unit_cost := v_item.unit_cost_cents;
    ELSIF v_item.product_id IS NOT NULL THEN v_unit_cost := COALESCE(round(v_item.product_cost * 100), 0);
    ELSE v_unit_cost := 0;
    END IF;

    v_extended := round(v_unit_price * v_item.quantity);

    INSERT INTO invoice_items (
      invoice_id, product_id, description,
      quantity, unit_price_cents, extended_cents, cost_cents,
      sort_order, rate_per_acre, acres, quoted_price_cents, price_source
    ) VALUES (
      v_invoice_id, v_item.product_id,
      COALESCE(v_item.full_product_name, v_item.product_name),
      v_item.quantity, v_unit_price, v_extended, v_unit_cost,
      v_item.sequence_order, v_item.rate_per_acre,
      CASE WHEN v_item.rate_per_acre IS NOT NULL AND v_item.rate_per_acre > 0
           THEN round(v_item.quantity / v_item.rate_per_acre, 2) ELSE NULL END,
      v_quoted_price, v_price_source
    );
    v_total_cents := v_total_cents + v_extended;
  END LOOP;

  IF v_ticket.application_service_id IS NOT NULL THEN
    SELECT * INTO v_app_service FROM application_services WHERE id = v_ticket.application_service_id;
    IF FOUND AND v_app_service.is_active THEN
      SELECT car.rate_per_acre_cents INTO v_fee_rate
      FROM customer_application_rates car
      WHERE car.customer_id = v_ticket.customer_id
        AND car.application_service_id = v_ticket.application_service_id
        AND car.season = COALESCE(v_ticket.season, current_season()) LIMIT 1;
      IF v_fee_rate IS NULL THEN v_fee_rate := v_app_service.default_rate_per_acre_cents; END IF;
      SELECT COALESCE(SUM(btf.actual_acres), 0) INTO v_fee_acres
      FROM blend_ticket_fields btf WHERE btf.blend_ticket_id = p_blend_ticket_id;
      IF v_fee_acres = 0 THEN v_fee_acres := COALESCE(v_ticket.total_acres, 0); END IF;
      IF v_fee_rate > 0 AND v_fee_acres > 0 THEN
        v_fee_extended := round(v_fee_rate * v_fee_acres);
        v_fee_cost := round(v_app_service.cost_per_acre_cents * v_fee_acres);
        INSERT INTO invoice_items (
          invoice_id, description, quantity, unit_price_cents, extended_cents,
          cost_cents, sort_order, acres, is_application_fee, price_source
        ) VALUES (
          v_invoice_id, v_app_service.name, v_fee_acres,
          v_fee_rate, v_fee_extended, v_fee_cost, 9999, v_fee_acres, true, 'tier'
        );
        v_total_cents := v_total_cents + v_fee_extended;
      END IF;
    END IF;
  END IF;

  IF v_quote_section_id IS NOT NULL THEN
    SELECT COALESCE(MAX(qi.acres), 0) INTO v_planned_acres FROM quote_items qi WHERE qi.section_id = v_quote_section_id;
    SELECT COALESCE(SUM(btf.actual_acres), 0) INTO v_actual_acres FROM blend_ticket_fields btf WHERE btf.blend_ticket_id = p_blend_ticket_id;
    IF v_actual_acres > v_planned_acres AND v_planned_acres > 0 THEN
      UPDATE invoices SET header_notes = COALESCE(header_notes, '') ||
        CASE WHEN header_notes IS NOT NULL AND header_notes != '' THEN E'\n' ELSE '' END ||
        'Note: Actual acres (' || round(v_actual_acres, 1) || ') exceed program plan (' || round(v_planned_acres, 1) || ')'
      WHERE id = v_invoice_id;
    END IF;
  END IF;

  UPDATE invoices SET total_amount_cents = v_total_cents WHERE id = v_invoice_id;
  UPDATE blend_tickets SET payment_status = 'billed' WHERE id = p_blend_ticket_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'invoice_created', 'invoice', v_invoice_id,
    COALESCE((SELECT role FROM profiles WHERE id = p_created_by), 'admin'),
    jsonb_build_object('invoice_number', (SELECT invoice_number FROM invoices WHERE id = v_invoice_id),
      'blend_ticket_number', v_ticket.ticket_number, 'customer_id', v_ticket.customer_id,
      'total_cents', v_total_cents, 'source', 'blend_ticket'),
    v_total_cents, 'Invoice created from blend ticket ' || v_ticket.ticket_number
  );

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_created', 'Invoice created from blend ticket ' || v_ticket.ticket_number,
    p_created_by, 'invoice', v_invoice_id, v_ticket.customer_id);

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'create_invoice_from_blend_ticket', to_jsonb(v_invoice_id));
  END IF;

  RETURN v_invoice_id;
END;
$$;

GRANT EXECUTE ON FUNCTION create_invoice_from_blend_ticket(uuid, uuid, text) TO authenticated;
