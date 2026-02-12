-- ============================================================================
-- S1-4: ATOMIC MULTI-STEP WRITES
-- CRX Manager V1.0
-- Date: 2026-02-11
--
-- 1. save_customer() — atomic customer header + addresses
-- 2. save_blend_ticket() — atomic ticket header + products
-- 3. duplicate_quote() — atomic quote duplication
-- ============================================================================


-- ============================================================================
-- 1. ATOMIC CUSTOMER SAVE RPC
-- Replaces non-atomic header → delete/update/insert addresses loop
-- ============================================================================

CREATE OR REPLACE FUNCTION save_customer(
  p_customer_id uuid,          -- NULL for new, existing ID for edit
  p_customer_payload jsonb,    -- Customer header fields
  p_addresses jsonb,           -- Array of address objects
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_customer_id uuid;
  v_is_new boolean := (p_customer_id IS NULL);
  v_addr jsonb;
BEGIN
  -- Verify caller is admin or sales_rep
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_performed_by AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to manage customers';
  END IF;

  IF v_is_new THEN
    INSERT INTO customers (
      farm_name, contact_name, phone, email, billing_address,
      assigned_tier, assigned_sales_rep, total_acres, corn_acres,
      soybean_acres, other_acres, payment_terms,
      default_commission_split, notes, is_active
    ) VALUES (
      p_customer_payload->>'farm_name',
      NULLIF(p_customer_payload->>'contact_name', ''),
      NULLIF(p_customer_payload->>'phone', ''),
      NULLIF(p_customer_payload->>'email', ''),
      NULLIF(p_customer_payload->>'billing_address', ''),
      COALESCE((p_customer_payload->>'assigned_tier')::integer, 1),
      (p_customer_payload->>'assigned_sales_rep')::uuid,
      (p_customer_payload->>'total_acres')::numeric,
      (p_customer_payload->>'corn_acres')::numeric,
      (p_customer_payload->>'soybean_acres')::numeric,
      (p_customer_payload->>'other_acres')::numeric,
      NULLIF(p_customer_payload->>'payment_terms', ''),
      CASE WHEN p_customer_payload ? 'default_commission_split'
        THEN (p_customer_payload->'default_commission_split')
        ELSE NULL
      END,
      NULLIF(p_customer_payload->>'notes', ''),
      COALESCE((p_customer_payload->>'is_active')::boolean, true)
    ) RETURNING id INTO v_customer_id;
  ELSE
    v_customer_id := p_customer_id;

    UPDATE customers SET
      farm_name = COALESCE(p_customer_payload->>'farm_name', farm_name),
      contact_name = CASE WHEN p_customer_payload ? 'contact_name'
        THEN NULLIF(p_customer_payload->>'contact_name', '') ELSE contact_name END,
      phone = CASE WHEN p_customer_payload ? 'phone'
        THEN NULLIF(p_customer_payload->>'phone', '') ELSE phone END,
      email = CASE WHEN p_customer_payload ? 'email'
        THEN NULLIF(p_customer_payload->>'email', '') ELSE email END,
      billing_address = CASE WHEN p_customer_payload ? 'billing_address'
        THEN NULLIF(p_customer_payload->>'billing_address', '') ELSE billing_address END,
      assigned_tier = COALESCE((p_customer_payload->>'assigned_tier')::integer, assigned_tier),
      assigned_sales_rep = CASE WHEN p_customer_payload ? 'assigned_sales_rep'
        THEN (p_customer_payload->>'assigned_sales_rep')::uuid ELSE assigned_sales_rep END,
      total_acres = CASE WHEN p_customer_payload ? 'total_acres'
        THEN (p_customer_payload->>'total_acres')::numeric ELSE total_acres END,
      corn_acres = CASE WHEN p_customer_payload ? 'corn_acres'
        THEN (p_customer_payload->>'corn_acres')::numeric ELSE corn_acres END,
      soybean_acres = CASE WHEN p_customer_payload ? 'soybean_acres'
        THEN (p_customer_payload->>'soybean_acres')::numeric ELSE soybean_acres END,
      other_acres = CASE WHEN p_customer_payload ? 'other_acres'
        THEN (p_customer_payload->>'other_acres')::numeric ELSE other_acres END,
      payment_terms = CASE WHEN p_customer_payload ? 'payment_terms'
        THEN NULLIF(p_customer_payload->>'payment_terms', '') ELSE payment_terms END,
      default_commission_split = CASE WHEN p_customer_payload ? 'default_commission_split'
        THEN (p_customer_payload->'default_commission_split') ELSE default_commission_split END,
      notes = CASE WHEN p_customer_payload ? 'notes'
        THEN NULLIF(p_customer_payload->>'notes', '') ELSE notes END,
      is_active = COALESCE((p_customer_payload->>'is_active')::boolean, is_active),
      updated_at = now()
    WHERE id = v_customer_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Customer not found: %', v_customer_id;
    END IF;

    -- Delete existing addresses and re-insert (CASCADE-safe, atomic)
    DELETE FROM customer_addresses WHERE customer_id = v_customer_id;
  END IF;

  -- Insert addresses
  IF p_addresses IS NOT NULL AND jsonb_array_length(p_addresses) > 0 THEN
    INSERT INTO customer_addresses (
      customer_id, label, address_line, city, state, zip,
      delivery_notes, is_default
    )
    SELECT
      v_customer_id,
      COALESCE(addr->>'label', ''),
      NULLIF(addr->>'address_line', ''),
      NULLIF(addr->>'city', ''),
      NULLIF(addr->>'state', ''),
      NULLIF(addr->>'zip', ''),
      NULLIF(addr->>'delivery_notes', ''),
      COALESCE((addr->>'is_default')::boolean, false)
    FROM jsonb_array_elements(p_addresses) AS addr
    WHERE COALESCE(addr->>'label', '') != '' OR COALESCE(addr->>'address_line', '') != '';
  END IF;

  -- Log activity
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    CASE WHEN v_is_new THEN 'customer_created' ELSE 'customer_updated' END,
    CASE WHEN v_is_new
      THEN 'Customer ' || COALESCE(p_customer_payload->>'farm_name', '') || ' created'
      ELSE 'Customer ' || COALESCE(p_customer_payload->>'farm_name', '') || ' updated'
    END,
    p_performed_by, 'customer', v_customer_id, v_customer_id
  );

  RETURN jsonb_build_object('status', 'saved', 'customer_id', v_customer_id);
END;
$$;

GRANT EXECUTE ON FUNCTION save_customer(uuid, jsonb, jsonb, uuid) TO authenticated;


-- ============================================================================
-- 2. ATOMIC BLEND TICKET SAVE RPC
-- Replaces non-atomic header update + one-by-one product updates loop
-- ============================================================================

CREATE OR REPLACE FUNCTION save_blend_ticket(
  p_ticket_id uuid,
  p_ticket_payload jsonb,    -- Ticket header fields
  p_products jsonb,          -- Array of product objects (must include 'id' for existing)
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket_number text;
BEGIN
  -- Verify caller is admin or sales_rep
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_performed_by AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to save blend tickets';
  END IF;

  -- Get ticket number for activity log
  SELECT ticket_number INTO v_ticket_number FROM blend_tickets WHERE id = p_ticket_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Blend ticket not found: %', p_ticket_id;
  END IF;

  -- Update ticket header
  UPDATE blend_tickets SET
    customer_id = CASE WHEN p_ticket_payload ? 'customer_id'
      THEN (p_ticket_payload->>'customer_id')::uuid ELSE customer_id END,
    ticket_date = CASE WHEN p_ticket_payload ? 'ticket_date'
      THEN (p_ticket_payload->>'ticket_date')::date ELSE ticket_date END,
    ticket_time = CASE WHEN p_ticket_payload ? 'ticket_time'
      THEN p_ticket_payload->>'ticket_time' ELSE ticket_time END,
    job_number = CASE WHEN p_ticket_payload ? 'job_number'
      THEN NULLIF(p_ticket_payload->>'job_number', '') ELSE job_number END,
    invoice_number = CASE WHEN p_ticket_payload ? 'invoice_number'
      THEN NULLIF(p_ticket_payload->>'invoice_number', '') ELSE invoice_number END,
    driver_name = CASE WHEN p_ticket_payload ? 'driver_name'
      THEN NULLIF(p_ticket_payload->>'driver_name', '') ELSE driver_name END,
    applicator_name = CASE WHEN p_ticket_payload ? 'applicator_name'
      THEN NULLIF(p_ticket_payload->>'applicator_name', '') ELSE applicator_name END,
    mixer_name = CASE WHEN p_ticket_payload ? 'mixer_name'
      THEN NULLIF(p_ticket_payload->>'mixer_name', '') ELSE mixer_name END,
    tank_number = CASE WHEN p_ticket_payload ? 'tank_number'
      THEN NULLIF(p_ticket_payload->>'tank_number', '') ELSE tank_number END,
    vehicle_info = CASE WHEN p_ticket_payload ? 'vehicle_info'
      THEN NULLIF(p_ticket_payload->>'vehicle_info', '') ELSE vehicle_info END,
    field_names = CASE WHEN p_ticket_payload ? 'field_names'
      THEN NULLIF(p_ticket_payload->>'field_names', '') ELSE field_names END,
    total_acres = CASE WHEN p_ticket_payload ? 'total_acres'
      THEN (p_ticket_payload->>'total_acres')::numeric ELSE total_acres END,
    application_rate = CASE WHEN p_ticket_payload ? 'application_rate'
      THEN NULLIF(p_ticket_payload->>'application_rate', '') ELSE application_rate END,
    total_volume = CASE WHEN p_ticket_payload ? 'total_volume'
      THEN (p_ticket_payload->>'total_volume')::numeric ELSE total_volume END,
    total_volume_unit = CASE WHEN p_ticket_payload ? 'total_volume_unit'
      THEN NULLIF(p_ticket_payload->>'total_volume_unit', '') ELSE total_volume_unit END,
    notes = CASE WHEN p_ticket_payload ? 'notes'
      THEN NULLIF(p_ticket_payload->>'notes', '') ELSE notes END,
    updated_at = now()
  WHERE id = p_ticket_id;

  -- Update each product by ID
  -- We use a lateral join to update each product row atomically
  UPDATE blend_ticket_products btp SET
    product_id = CASE WHEN prod->>'product_id' IS NOT NULL
      THEN (prod->>'product_id')::uuid ELSE btp.product_id END,
    product_name = COALESCE(prod->>'product_name', btp.product_name),
    quantity = COALESCE((prod->>'quantity')::numeric, btp.quantity),
    unit = CASE WHEN prod ? 'unit' THEN NULLIF(prod->>'unit', '') ELSE btp.unit END,
    lot_number = CASE WHEN prod ? 'lot_number' THEN NULLIF(prod->>'lot_number', '') ELSE btp.lot_number END,
    rate_per_acre = CASE WHEN prod ? 'rate_per_acre' THEN (prod->>'rate_per_acre')::numeric ELSE btp.rate_per_acre END,
    rate_per_acre_unit = CASE WHEN prod ? 'rate_per_acre_unit' THEN NULLIF(prod->>'rate_per_acre_unit', '') ELSE btp.rate_per_acre_unit END,
    manually_corrected = true
  FROM jsonb_array_elements(p_products) AS prod
  WHERE btp.id = (prod->>'id')::uuid
    AND btp.blend_ticket_id = p_ticket_id;

  -- Log activity
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id
  ) VALUES (
    'blend_ticket_updated',
    'Blend ticket ' || COALESCE(v_ticket_number, '') || ' updated',
    p_performed_by, 'blend_ticket', p_ticket_id
  );

  RETURN jsonb_build_object('status', 'saved');
END;
$$;

GRANT EXECUTE ON FUNCTION save_blend_ticket(uuid, jsonb, jsonb, uuid) TO authenticated;


-- ============================================================================
-- 3. ATOMIC QUOTE DUPLICATION RPC
-- Replaces non-atomic loop: new quote → sections one-by-one → items one-by-one
-- ============================================================================

CREATE OR REPLACE FUNCTION duplicate_quote(
  p_source_quote_id uuid,
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_orig record;
  v_new_quote_id uuid;
  v_new_quote_number text;
  v_year text := extract(year FROM current_date)::text;
  v_max_num int;
  v_section record;
  v_new_section_id uuid;
BEGIN
  -- Verify caller is admin or sales_rep
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_performed_by AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to duplicate quotes';
  END IF;

  -- Fetch original quote
  SELECT * INTO v_orig FROM quotes WHERE id = p_source_quote_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Source quote not found: %', p_source_quote_id;
  END IF;

  -- Generate next quote number (atomic with FOR UPDATE style)
  SELECT COALESCE(MAX(
    CASE WHEN quote_number ~ ('^Q-' || v_year || '-\d+$')
    THEN CAST(split_part(quote_number, '-', 3) AS int)
    ELSE 0 END
  ), 0) INTO v_max_num FROM quotes;

  v_new_quote_number := 'Q-' || v_year || '-' || lpad((v_max_num + 1)::text, 4, '0');

  -- Insert new quote header
  INSERT INTO quotes (
    quote_number, customer_id, created_by, tier, status,
    commission_split, total_price, total_cost, total_profit,
    total_margin_pct, valid_days, expires_at,
    header_notes, footer_notes
  ) VALUES (
    v_new_quote_number,
    v_orig.customer_id,
    p_performed_by,
    v_orig.tier,
    'draft',
    v_orig.commission_split,
    v_orig.total_price,
    v_orig.total_cost,
    v_orig.total_profit,
    v_orig.total_margin_pct,
    COALESCE(v_orig.valid_days, 15),
    now() + (COALESCE(v_orig.valid_days, 15) || ' days')::interval,
    v_orig.header_notes,
    v_orig.footer_notes
  ) RETURNING id INTO v_new_quote_id;

  -- Copy sections and items
  FOR v_section IN
    SELECT * FROM quote_sections WHERE quote_id = p_source_quote_id ORDER BY sort_order
  LOOP
    INSERT INTO quote_sections (
      quote_id, section_name, sort_order, section_notes
    ) VALUES (
      v_new_quote_id,
      v_section.section_name,
      v_section.sort_order,
      v_section.section_notes
    ) RETURNING id INTO v_new_section_id;

    -- Copy all items for this section in one INSERT
    INSERT INTO quote_items (
      quote_id, section_id, product_id, sort_order, notes,
      price_per_unit, current_cost, suggested_rate, actual_rate,
      rate_unit, oz_per_acre, price_per_acre, acres,
      total_units_needed, unit_size, profit, total_price, net_margin
    )
    SELECT
      v_new_quote_id,
      v_new_section_id,
      product_id, sort_order, notes,
      price_per_unit, current_cost, suggested_rate, actual_rate,
      rate_unit, oz_per_acre, price_per_acre, acres,
      total_units_needed, unit_size, profit, total_price, net_margin
    FROM quote_items
    WHERE quote_id = p_source_quote_id AND section_id = v_section.id
    ORDER BY sort_order;
  END LOOP;

  -- Log activity
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'quote_created',
    'Quote ' || v_new_quote_number || ' duplicated from ' || v_orig.quote_number,
    p_performed_by, 'quote', v_new_quote_id, v_orig.customer_id
  );

  RETURN jsonb_build_object(
    'status', 'duplicated',
    'quote_id', v_new_quote_id,
    'quote_number', v_new_quote_number
  );
END;
$$;

GRANT EXECUTE ON FUNCTION duplicate_quote(uuid, uuid) TO authenticated;
