-- ============================================================================
-- Phase 3: Field Billing Splits → Auto-Invoice (Pillar 2)
-- When fields have billing splits, create proportional split invoices
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Add field_id to quote_sections (links quote sections to fields)
-- ---------------------------------------------------------------------------
ALTER TABLE quote_sections
  ADD COLUMN IF NOT EXISTS field_id uuid REFERENCES fields(id);

CREATE INDEX IF NOT EXISTS idx_quote_sections_field
  ON quote_sections(field_id) WHERE field_id IS NOT NULL;

COMMENT ON COLUMN quote_sections.field_id
  IS 'Links quote section to a field — enables field billing splits to flow through quote → order → invoice';

-- ---------------------------------------------------------------------------
-- Add invoice_group_id to invoices (groups split invoices together)
-- ---------------------------------------------------------------------------
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS invoice_group_id uuid;

CREATE INDEX IF NOT EXISTS idx_invoices_group
  ON invoices(invoice_group_id) WHERE invoice_group_id IS NOT NULL;

COMMENT ON COLUMN invoices.invoice_group_id
  IS 'Groups split invoices together — all invoices in a group represent parts of the same billing event';

-- ---------------------------------------------------------------------------
-- Helper: get_field_billing_splits_for_order
-- Returns billing splits for all fields associated with an order's quote sections
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_field_billing_splits_for_order(p_order_id uuid)
RETURNS TABLE (
  customer_id uuid,
  split_pct   numeric,
  is_primary  boolean,
  field_id    uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
    SELECT DISTINCT fbd.customer_id, fbd.split_pct, fbd.is_primary, fbd.field_id
    FROM orders o
    JOIN quotes q ON q.id = o.quote_id
    JOIN quote_sections qs ON qs.quote_id = q.id
    JOIN field_billing_defaults fbd ON fbd.field_id = qs.field_id
    WHERE o.id = p_order_id
      AND qs.field_id IS NOT NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- Helper: get_field_billing_splits_for_blend_ticket
-- Returns billing splits for all fields associated with a blend ticket
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_field_billing_splits_for_blend_ticket(p_blend_ticket_id uuid)
RETURNS TABLE (
  customer_id uuid,
  split_pct   numeric,
  is_primary  boolean,
  field_id    uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
    -- From blend_ticket_fields
    SELECT DISTINCT fbd.customer_id, fbd.split_pct, fbd.is_primary, fbd.field_id
    FROM blend_ticket_fields btf
    JOIN field_billing_defaults fbd ON fbd.field_id = btf.field_id
    WHERE btf.blend_ticket_id = p_blend_ticket_id
    UNION
    -- Fallback: from blend_tickets.field_id
    SELECT DISTINCT fbd.customer_id, fbd.split_pct, fbd.is_primary, fbd.field_id
    FROM blend_tickets bt
    JOIN field_billing_defaults fbd ON fbd.field_id = bt.field_id
    WHERE bt.id = p_blend_ticket_id
      AND bt.field_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM blend_ticket_fields btf2 WHERE btf2.blend_ticket_id = p_blend_ticket_id
      );
END;
$$;

-- ---------------------------------------------------------------------------
-- create_split_invoices_from_order
-- Creates proportional split invoices if field billing splits exist.
-- Falls back to standard single invoice if no splits.
-- Returns array of invoice IDs.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_split_invoices_from_order(
  p_order_id        uuid,
  p_salesman_id     uuid DEFAULT NULL,
  p_invoice_type    text DEFAULT 'chemical_sale',
  p_idempotency_key text DEFAULT NULL
)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing      text;
  v_order         record;
  v_split         record;
  v_splits        record[];
  v_has_splits    boolean := false;
  v_group_id      uuid;
  v_invoice_id    uuid;
  v_invoice_ids   uuid[] := '{}';
  v_item          record;
  v_total_cents   bigint;
  v_split_total   bigint;
  v_split_ext     bigint;
BEGIN
  -- Idempotency
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing FROM idempotency_keys WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN string_to_array(v_existing, ',')::uuid[]; END IF;
  END IF;

  -- Get order
  SELECT * INTO v_order FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found: %', p_order_id; END IF;

  -- Check for field billing splits
  SELECT EXISTS (
    SELECT 1 FROM get_field_billing_splits_for_order(p_order_id)
  ) INTO v_has_splits;

  -- No splits → delegate to standard single invoice
  IF NOT v_has_splits THEN
    v_invoice_id := create_invoice_from_order(p_order_id, p_salesman_id, p_invoice_type, p_idempotency_key);
    RETURN ARRAY[v_invoice_id];
  END IF;

  -- Generate group ID for linked split invoices
  v_group_id := gen_random_uuid();

  -- Create one invoice per split customer
  FOR v_split IN
    SELECT customer_id, sum(split_pct) AS total_pct
    FROM get_field_billing_splits_for_order(p_order_id)
    GROUP BY customer_id
  LOOP
    v_total_cents := 0;

    INSERT INTO invoices (
      order_id, customer_id, invoice_type, status, season,
      salesman_id, created_by, total_amount_cents, invoice_date,
      invoice_group_id, header_notes
    ) VALUES (
      p_order_id, v_split.customer_id, p_invoice_type, 'draft',
      COALESCE(v_order.season, current_season()),
      COALESCE(p_salesman_id, v_order.salesman_id),
      auth.uid(), 0, CURRENT_DATE,
      v_group_id,
      'Split invoice (' || round(v_split.total_pct, 1) || '%) — grouped with ' ||
        (SELECT count(*) - 1 FROM (SELECT DISTINCT customer_id FROM get_field_billing_splits_for_order(p_order_id)) sub) ||
        ' other invoice(s)'
    )
    RETURNING id INTO v_invoice_id;

    -- Create proportional line items
    FOR v_item IN
      SELECT * FROM order_items WHERE order_id = p_order_id ORDER BY sort_order NULLS LAST, id
    LOOP
      v_split_ext := round(round(v_item.total_price * 100)::bigint * v_split.total_pct / 100);

      INSERT INTO invoice_items (
        invoice_id, order_item_id, product_id, description,
        quantity, unit_price_cents, extended_cents, cost_cents,
        sort_order, rate_per_acre, acres, unit_size
      ) VALUES (
        v_invoice_id, v_item.id, v_item.product_id,
        COALESCE(v_item.product_name, ''),
        round(v_item.total_units_needed * v_split.total_pct / 100, 4),
        round(v_item.price_per_unit * 100)::bigint,
        v_split_ext,
        round(v_item.cost_per_unit * 100)::bigint,
        COALESCE(v_item.sort_order, 0),
        v_item.actual_rate,
        v_item.acres,
        v_item.unit_size
      );

      v_total_cents := v_total_cents + v_split_ext;
    END LOOP;

    -- Update invoice total
    UPDATE invoices SET total_amount_cents = v_total_cents WHERE id = v_invoice_id;

    -- Audit log
    INSERT INTO financial_audit_log (
      operation_type, entity_type, entity_id, actor_role,
      new_values, total_impact_cents, description
    ) VALUES (
      'invoice_created', 'invoice', v_invoice_id,
      COALESCE((SELECT role FROM profiles WHERE id = auth.uid()), 'admin'),
      jsonb_build_object(
        'invoice_number', (SELECT invoice_number FROM invoices WHERE id = v_invoice_id),
        'order_number', v_order.order_number,
        'customer_id', v_split.customer_id,
        'total_cents', v_total_cents,
        'split_pct', v_split.total_pct,
        'group_id', v_group_id
      ),
      v_total_cents,
      'Split invoice (' || round(v_split.total_pct, 1) || '%) from order ' || v_order.order_number
    );

    v_invoice_ids := v_invoice_ids || v_invoice_id;
  END LOOP;

  -- Activity feed
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('split_invoices_created',
    array_length(v_invoice_ids, 1) || ' split invoices created from order ' || v_order.order_number,
    auth.uid(), 'order', p_order_id, v_order.customer_id);

  -- Idempotency
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'create_split_invoices_from_order', array_to_string(v_invoice_ids, ','));
  END IF;

  RETURN v_invoice_ids;
END;
$$;
