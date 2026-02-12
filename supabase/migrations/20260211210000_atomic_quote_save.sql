-- ============================================================================
-- S0-3: ATOMIC QUOTE SAVE RPC
-- CRX Manager V1.0
-- Date: 2026-02-11
--
-- Replaces the dangerous delete-all-then-reinsert pattern in QuoteBuilder.tsx
-- with a single atomic database transaction.
--
-- If any step fails, the entire operation rolls back — no data loss possible.
-- ============================================================================

CREATE OR REPLACE FUNCTION save_quote(
  p_quote_id uuid,           -- NULL for new quote, existing ID for edit
  p_quote_payload jsonb,     -- Quote header fields
  p_sections jsonb,          -- Array of { section_name, sort_order, section_notes, items: [...] }
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_quote_id uuid;
  v_is_new boolean := (p_quote_id IS NULL);
  v_section jsonb;
  v_section_id uuid;
  v_item jsonb;
  v_items_to_insert jsonb[];
BEGIN
  -- Verify caller is admin or sales_rep
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_performed_by AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to save quotes';
  END IF;

  IF v_is_new THEN
    -- INSERT new quote
    INSERT INTO quotes (
      quote_number, customer_id, created_by, tier, status,
      commission_split, total_price, total_cost, total_profit,
      total_margin_pct, valid_days, expires_at,
      header_notes, footer_notes, sent_at
    ) VALUES (
      p_quote_payload->>'quote_number',
      (p_quote_payload->>'customer_id')::uuid,
      p_performed_by,
      (p_quote_payload->>'tier')::integer,
      COALESCE(p_quote_payload->>'status', 'draft'),
      CASE WHEN p_quote_payload ? 'commission_split'
        THEN (p_quote_payload->'commission_split')
        ELSE NULL
      END,
      COALESCE((p_quote_payload->>'total_price')::numeric, 0),
      COALESCE((p_quote_payload->>'total_cost')::numeric, 0),
      COALESCE((p_quote_payload->>'total_profit')::numeric, 0),
      COALESCE((p_quote_payload->>'total_margin_pct')::numeric, 0),
      COALESCE((p_quote_payload->>'valid_days')::integer, 30),
      (p_quote_payload->>'expires_at')::timestamptz,
      NULLIF(p_quote_payload->>'header_notes', ''),
      NULLIF(p_quote_payload->>'footer_notes', ''),
      CASE WHEN p_quote_payload->>'sent_at' IS NOT NULL
        THEN (p_quote_payload->>'sent_at')::timestamptz
        ELSE NULL
      END
    ) RETURNING id INTO v_quote_id;
  ELSE
    -- UPDATE existing quote — verify it exists
    v_quote_id := p_quote_id;

    UPDATE quotes SET
      customer_id = COALESCE((p_quote_payload->>'customer_id')::uuid, customer_id),
      tier = COALESCE((p_quote_payload->>'tier')::integer, tier),
      status = COALESCE(p_quote_payload->>'status', status),
      commission_split = CASE WHEN p_quote_payload ? 'commission_split'
        THEN (p_quote_payload->'commission_split')
        ELSE commission_split
      END,
      total_price = COALESCE((p_quote_payload->>'total_price')::numeric, total_price),
      total_cost = COALESCE((p_quote_payload->>'total_cost')::numeric, total_cost),
      total_profit = COALESCE((p_quote_payload->>'total_profit')::numeric, total_profit),
      total_margin_pct = COALESCE((p_quote_payload->>'total_margin_pct')::numeric, total_margin_pct),
      valid_days = COALESCE((p_quote_payload->>'valid_days')::integer, valid_days),
      expires_at = COALESCE((p_quote_payload->>'expires_at')::timestamptz, expires_at),
      header_notes = CASE WHEN p_quote_payload ? 'header_notes'
        THEN NULLIF(p_quote_payload->>'header_notes', '')
        ELSE header_notes
      END,
      footer_notes = CASE WHEN p_quote_payload ? 'footer_notes'
        THEN NULLIF(p_quote_payload->>'footer_notes', '')
        ELSE footer_notes
      END,
      sent_at = CASE WHEN p_quote_payload->>'sent_at' IS NOT NULL
        THEN (p_quote_payload->>'sent_at')::timestamptz
        ELSE sent_at
      END,
      updated_at = now()
    WHERE id = v_quote_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Quote not found: %', v_quote_id;
    END IF;

    -- Delete existing sections and items (CASCADE handles items)
    DELETE FROM quote_sections WHERE quote_id = v_quote_id;
    -- quote_items are auto-deleted via ON DELETE CASCADE from quote_sections
  END IF;

  -- Insert sections and their items
  FOR v_section IN SELECT * FROM jsonb_array_elements(p_sections) LOOP
    INSERT INTO quote_sections (
      quote_id, section_name, sort_order, section_notes
    ) VALUES (
      v_quote_id,
      COALESCE(v_section->>'section_name', ''),
      COALESCE((v_section->>'sort_order')::integer, 0),
      NULLIF(v_section->>'section_notes', '')
    ) RETURNING id INTO v_section_id;

    -- Insert items for this section
    IF v_section ? 'items' AND jsonb_array_length(v_section->'items') > 0 THEN
      INSERT INTO quote_items (
        quote_id, section_id, product_id, sort_order, notes,
        price_per_unit, current_cost, suggested_rate, actual_rate,
        rate_unit, oz_per_acre, price_per_acre, acres,
        total_units_needed, unit_size, profit, total_price, net_margin
      )
      SELECT
        v_quote_id,
        v_section_id,
        (item->>'product_id')::uuid,
        COALESCE((item->>'sort_order')::integer, 0),
        NULLIF(item->>'notes', ''),
        COALESCE((item->>'price_per_unit')::numeric, 0),
        COALESCE((item->>'current_cost')::numeric, 0),
        item->>'suggested_rate',
        (item->>'actual_rate')::numeric,
        item->>'rate_unit',
        (item->>'oz_per_acre')::numeric,
        (item->>'price_per_acre')::numeric,
        (item->>'acres')::numeric,
        (item->>'total_units_needed')::numeric,
        item->>'unit_size',
        COALESCE((item->>'profit')::numeric, 0),
        COALESCE((item->>'total_price')::numeric, 0),
        COALESCE((item->>'net_margin')::numeric, 0)
      FROM jsonb_array_elements(v_section->'items') AS item
      WHERE (item->>'product_id') IS NOT NULL;
    END IF;
  END LOOP;

  -- Log activity
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id
  ) VALUES (
    CASE WHEN v_is_new THEN 'quote_created' ELSE 'quote_updated' END,
    CASE WHEN v_is_new
      THEN 'Quote ' || COALESCE(p_quote_payload->>'quote_number', '') || ' created'
      ELSE 'Quote ' || COALESCE(p_quote_payload->>'quote_number', '') || ' updated'
    END,
    p_performed_by, 'quote', v_quote_id
  );

  RETURN jsonb_build_object('status', 'saved', 'quote_id', v_quote_id);
END;
$$;

GRANT EXECUTE ON FUNCTION save_quote(uuid, jsonb, jsonb, uuid) TO authenticated;
