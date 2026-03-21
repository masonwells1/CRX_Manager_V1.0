-- Fix save_customer to handle addresses referenced by deliveries
-- Previously: DELETE all addresses then re-insert (fails when deliveries reference addresses)
-- Now: Upsert existing addresses, insert new ones, delete only unreferenced ones

CREATE OR REPLACE FUNCTION save_customer(
  p_customer_id uuid,
  p_customer_payload jsonb,
  p_addresses jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_customer_id uuid;
  v_is_new boolean := (p_customer_id IS NULL);
  v_addr jsonb;
  v_incoming_ids uuid[];
BEGIN
  -- P0-001 FIX: Derive actor from JWT, reject spoofing
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by <> v_actor THEN
    RAISE EXCEPTION 'Actor mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to manage customers';
  END IF;

  IF v_is_new THEN
    INSERT INTO customers (
      farm_name, contact_name, phone, email, billing_address,
      assigned_tier, assigned_sales_rep, total_acres, corn_acres,
      soybean_acres, other_acres, payment_terms,
      default_commission_split, notes, is_active,
      parent_customer_id, credit_limit_cents,
      finance_charge_rate, finance_charge_enabled, finance_charge_grace_days
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
      COALESCE((p_customer_payload->>'is_active')::boolean, true),
      (p_customer_payload->>'parent_customer_id')::uuid,
      COALESCE((p_customer_payload->>'credit_limit_cents')::bigint, 0),
      COALESCE((p_customer_payload->>'finance_charge_rate')::numeric, 0),
      COALESCE((p_customer_payload->>'finance_charge_enabled')::boolean, true),
      COALESCE((p_customer_payload->>'finance_charge_grace_days')::integer, 0)
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
      assigned_tier = CASE WHEN p_customer_payload ? 'assigned_tier'
        THEN COALESCE((p_customer_payload->>'assigned_tier')::integer, 1) ELSE assigned_tier END,
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
      parent_customer_id = CASE WHEN p_customer_payload ? 'parent_customer_id'
        THEN (p_customer_payload->>'parent_customer_id')::uuid ELSE parent_customer_id END,
      credit_limit_cents = CASE WHEN p_customer_payload ? 'credit_limit_cents'
        THEN COALESCE((p_customer_payload->>'credit_limit_cents')::bigint, 0) ELSE credit_limit_cents END,
      finance_charge_rate = CASE WHEN p_customer_payload ? 'finance_charge_rate'
        THEN COALESCE((p_customer_payload->>'finance_charge_rate')::numeric, 0) ELSE finance_charge_rate END,
      finance_charge_enabled = CASE WHEN p_customer_payload ? 'finance_charge_enabled'
        THEN COALESCE((p_customer_payload->>'finance_charge_enabled')::boolean, true) ELSE finance_charge_enabled END,
      finance_charge_grace_days = CASE WHEN p_customer_payload ? 'finance_charge_grace_days'
        THEN COALESCE((p_customer_payload->>'finance_charge_grace_days')::integer, 0) ELSE finance_charge_grace_days END,
      updated_at = now()
    WHERE id = v_customer_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Customer not found: %', v_customer_id;
    END IF;

    -- Instead of DELETE-all, use smart upsert approach:
    -- 1. Update existing addresses that have an id
    -- 2. Insert new addresses (no id)
    -- 3. Delete only addresses that were removed AND are not referenced by deliveries

    -- Collect incoming address IDs (existing addresses being kept)
    SELECT array_agg((addr->>'id')::uuid)
    INTO v_incoming_ids
    FROM jsonb_array_elements(COALESCE(p_addresses, '[]'::jsonb)) AS addr
    WHERE addr->>'id' IS NOT NULL;

    -- Delete addresses that are NOT in the incoming list AND NOT referenced by deliveries
    DELETE FROM customer_addresses ca
    WHERE ca.customer_id = v_customer_id
      AND (v_incoming_ids IS NULL OR ca.id != ALL(v_incoming_ids))
      AND NOT EXISTS (
        SELECT 1 FROM deliveries d WHERE d.delivery_address_id = ca.id
      );
  END IF;

  -- Upsert addresses: update existing (by id), insert new (no id)
  IF p_addresses IS NOT NULL AND jsonb_array_length(p_addresses) > 0 THEN
    -- Update existing addresses
    UPDATE customer_addresses ca SET
      label = COALESCE(addr->>'label', ''),
      address_line = NULLIF(addr->>'address_line', ''),
      city = NULLIF(addr->>'city', ''),
      state = NULLIF(addr->>'state', ''),
      zip = NULLIF(addr->>'zip', ''),
      delivery_notes = NULLIF(addr->>'delivery_notes', ''),
      is_default = COALESCE((addr->>'is_default')::boolean, false)
    FROM jsonb_array_elements(p_addresses) AS addr
    WHERE ca.id = (addr->>'id')::uuid
      AND ca.customer_id = v_customer_id;

    -- Insert new addresses (those without an id)
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
    WHERE addr->>'id' IS NULL
      AND (COALESCE(addr->>'label', '') != '' OR COALESCE(addr->>'address_line', '') != '');
  END IF;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    CASE WHEN v_is_new THEN 'customer_created' ELSE 'customer_updated' END,
    CASE WHEN v_is_new
      THEN 'Customer ' || COALESCE(p_customer_payload->>'farm_name', '') || ' created'
      ELSE 'Customer ' || COALESCE(p_customer_payload->>'farm_name', '') || ' updated'
    END,
    v_actor, 'customer', v_customer_id, v_customer_id
  );

  RETURN jsonb_build_object('status', 'saved', 'customer_id', v_customer_id);
END;
$$;

GRANT EXECUTE ON FUNCTION save_customer(uuid, jsonb, jsonb, uuid, text) TO authenticated;
