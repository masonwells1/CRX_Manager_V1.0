-- ============================================================================
-- AUDIT FINANCIAL FIXES
-- Migration: 20260311000001_audit_financial_fixes.sql
--
-- Fixes 6 critical bugs found during financial audit:
--
-- Bug 1: allocate_payment season calculation uses month >= 7 (July)
--         instead of month >= 10 (October). Season is Oct 1 - Sep 30.
--
-- Bug 2: allocate_payment never calls check_period_open() before modifying
--         invoice paid_amount_cents / status. Add period guard per invoice.
--
-- Bug 3: save_customer (20260317200000) lost commission split validation
--         that was present in 20260312200000. Restore it.
--
-- Bug 4: transfer_job_to_invoice allows 'scheduled' jobs to be invoiced.
--         Only 'completed' jobs should be invoiceable.
--
-- Bug 5: post_invoice has no auth.uid() check — any caller with the
--         function signature can post. Add authentication + role guard.
--
-- Bug 6: confirm_delivery has no auth.uid() check. Add authentication +
--         role guard (admin, sales_rep, driver).
-- ============================================================================


-- ============================================================================
-- BUG 1 + BUG 2: Fix allocate_payment
-- - Season calculation: month >= 10 (October), not >= 7 (July)
-- - Add check_period_open() call for each invoice being allocated to
-- Source: 20260316200001_fix_allocate_payment_missing_columns.sql
-- ============================================================================

CREATE OR REPLACE FUNCTION allocate_payment(
  p_customer_id uuid,
  p_total_cents bigint,
  p_payment_method text,
  p_reference_number text DEFAULT NULL,
  p_check_number text DEFAULT NULL,
  p_payment_date date DEFAULT CURRENT_DATE,
  p_notes text DEFAULT NULL,
  p_allocations jsonb DEFAULT '[]'::jsonb,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_cached_result jsonb;
  v_alloc jsonb;
  v_inv record;
  v_alloc_cents bigint;
  v_sum_allocated bigint := 0;
  v_set_id uuid;
  v_current_season integer;
  v_prepay_cents bigint;
  v_result jsonb;
  v_allocation_count integer := 0;
  v_next_version integer;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'allocate_payment');
    IF v_cached_result IS NOT NULL THEN
      RETURN v_cached_result;
    END IF;
  END IF;

  -- Verify caller
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to allocate payments';
  END IF;

  IF p_total_cents <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be positive';
  END IF;

  -- BUG 1 FIX: Season runs Oct 1 - Sep 30 (month >= 10, not >= 7)
  v_current_season := CASE WHEN extract(month FROM CURRENT_DATE) >= 10
    THEN extract(year FROM CURRENT_DATE)::integer + 1
    ELSE extract(year FROM CURRENT_DATE)::integer END;

  -- Calculate next version to avoid unique constraint violation
  SELECT COALESCE(MAX(version), 0) + 1 INTO v_next_version
  FROM allocation_sets
  WHERE entity_type = 'payment' AND entity_id = p_customer_id;

  -- Create allocation set
  INSERT INTO allocation_sets (
    entity_type, entity_id, version,
    customer_id, total_payment_cents, payment_method,
    reference_number, check_number, payment_date,
    notes, season, created_by
  ) VALUES (
    'payment', p_customer_id, v_next_version,
    p_customer_id, p_total_cents, p_payment_method,
    p_reference_number, p_check_number, p_payment_date,
    p_notes, v_current_season, v_actor
  ) RETURNING id INTO v_set_id;

  -- Process allocations
  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations)
  LOOP
    v_alloc_cents := (v_alloc->>'amount_cents')::bigint;
    IF v_alloc_cents <= 0 THEN CONTINUE; END IF;

    SELECT * INTO v_inv FROM invoices
    WHERE id = (v_alloc->>'invoice_id')::uuid
      AND customer_id = p_customer_id
      AND status IN ('posted', 'overdue')
      AND deleted_at IS NULL
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invoice % not found or not eligible for payment', (v_alloc->>'invoice_id');
    END IF;

    IF v_alloc_cents > v_inv.balance_cents THEN
      RAISE EXCEPTION 'Allocation ($%) exceeds balance ($%) on invoice %',
        v_alloc_cents, v_inv.balance_cents, v_inv.invoice_number;
    END IF;

    -- BUG 2 FIX: Enforce accounting period before modifying invoice
    PERFORM check_period_open(v_inv.invoice_date);

    -- Insert line allocation
    INSERT INTO invoice_line_allocations (
      allocation_set_id, invoice_id, amount_cents,
      bill_to_customer_id, split_percentage
    ) VALUES (
      v_set_id, v_inv.id, v_alloc_cents,
      p_customer_id, 100
    );

    -- Update invoice paid_amount_cents
    UPDATE invoices SET
      paid_amount_cents = paid_amount_cents + v_alloc_cents,
      status = CASE
        WHEN (total_amount_cents - (paid_amount_cents + v_alloc_cents) - prepay_applied_cents - write_off_cents) <= 0
        THEN 'paid'
        ELSE status
      END,
      updated_at = now()
    WHERE id = v_inv.id;

    v_sum_allocated := v_sum_allocated + v_alloc_cents;
    v_allocation_count := v_allocation_count + 1;
  END LOOP;

  -- Update allocation set total
  UPDATE allocation_sets SET
    total_allocated_cents = v_sum_allocated,
    updated_at = now()
  WHERE id = v_set_id;

  -- Handle overpayment -> prepay credit
  v_prepay_cents := p_total_cents - v_sum_allocated;
  IF v_prepay_cents > 0 THEN
    INSERT INTO prepay_credits (
      customer_id, season, original_amount_cents, balance_cents,
      source_type, source_reference, created_by
    ) VALUES (
      p_customer_id, v_current_season, v_prepay_cents, v_prepay_cents,
      'overpayment', 'From payment ' || COALESCE(p_reference_number, p_check_number, v_set_id::text),
      v_actor
    );

    UPDATE customers SET
      prepay_balance_cents = COALESCE(prepay_balance_cents, 0) + v_prepay_cents,
      updated_at = now()
    WHERE id = p_customer_id;
  END IF;

  -- Log activity
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'payment_allocated',
    'Payment of $' || (p_total_cents / 100.0)::text || ' allocated (' || v_allocation_count || ' invoices)',
    v_actor, 'allocation_set', v_set_id, p_customer_id
  );

  v_result := jsonb_build_object(
    'success', true,
    'allocation_set_id', v_set_id,
    'total_allocated_cents', v_sum_allocated,
    'prepay_created_cents', v_prepay_cents,
    'invoices_paid', v_allocation_count
  );

  -- Save idempotency result
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'allocate_payment', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION allocate_payment(uuid, bigint, text, text, text, date, text, jsonb, uuid, text) TO authenticated;


-- ============================================================================
-- BUG 3: Restore commission split validation to save_customer
-- The 20260317200000 rewrite added auth.uid() enforcement but dropped
-- the commission split validation that existed in 20260312200000.
-- Source: 20260317200000_security_audit_auth_uid_enforcement.sql L1162
-- ============================================================================

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
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_customer_id uuid;
  v_is_new boolean := (p_customer_id IS NULL);
  v_addr jsonb;
  v_split_sum numeric;
  v_split record;
BEGIN
  -- P0-001: Derive actor from JWT, reject spoofing
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

  -- BUG 3 FIX: Validate commission split sums to 100%
  IF p_customer_payload ? 'default_commission_split' AND p_customer_payload->'default_commission_split' ? 'splits' THEN
    v_split_sum := 0;
    FOR v_split IN SELECT * FROM jsonb_array_elements(p_customer_payload->'default_commission_split'->'splits')
    LOOP
      v_split_sum := v_split_sum + (v_split.value->>'percentage')::numeric;
    END LOOP;
    IF v_split_sum != 100 THEN
      RAISE EXCEPTION 'Commission splits must sum to exactly 100%% (got %)', v_split_sum;
    END IF;
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

    DELETE FROM customer_addresses WHERE customer_id = v_customer_id;
  END IF;

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


-- ============================================================================
-- BUG 4: Fix transfer_job_to_invoice — only allow completed jobs
-- The guard allowed both 'completed' and 'scheduled' jobs. Only completed
-- jobs should be invoiceable.
-- Source: 20260305200000_audit_safety_fixes.sql L1366
-- ============================================================================

CREATE OR REPLACE FUNCTION transfer_job_to_invoice(
  p_job_id uuid,
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job RECORD;
  v_invoice_id uuid;
  v_invoice_number text;
  v_chem RECORD;
  v_item_order integer := 0;
  v_field_names text[];
  v_crop_types text[];
  v_crop_type text;
  v_total_acres numeric := 0;
  v_applicator_name text;
  v_vehicle_name text;
  v_field RECORD;
  v_billing RECORD;
  v_total_cost_cents bigint := 0;
  v_conversion RECORD;
  v_total_applied numeric;
  v_share RECORD;
  v_share_total bigint := 0;
  v_has_price_override boolean := false;
BEGIN
  -- Lock the job
  SELECT j.* INTO v_job
  FROM jobs j WHERE j.id = p_job_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found: %', p_job_id;
  END IF;
  IF v_job.status = 'invoiced' THEN
    RAISE EXCEPTION 'Job already invoiced';
  END IF;

  -- BUG 4 FIX: Only completed jobs can be invoiced (removed 'scheduled')
  IF v_job.status != 'completed' THEN
    RAISE EXCEPTION 'Job must be completed to invoice (status: %)', v_job.status;
  END IF;

  -- Gather field context
  FOR v_field IN
    SELECT jf.field_id, jf.acres_to_treat,
           f.field_name, f.crop_type AS f_crop_type
    FROM job_fields jf
    JOIN fields f ON f.id = jf.field_id
    WHERE jf.job_id = p_job_id
    ORDER BY f.field_name
  LOOP
    v_field_names := array_append(v_field_names, v_field.field_name);
    v_total_acres := v_total_acres + COALESCE(v_field.acres_to_treat, 0);
    IF v_field.f_crop_type IS NOT NULL THEN
      v_crop_types := array_append(v_crop_types, v_field.f_crop_type);
    END IF;
  END LOOP;

  -- Determine dominant crop type
  IF v_crop_types IS NOT NULL AND array_length(v_crop_types, 1) > 0 THEN
    SELECT mode() WITHIN GROUP (ORDER BY unnest) INTO v_crop_type
    FROM unnest(v_crop_types);
  END IF;

  -- Applicator name
  IF v_job.applicator_id IS NOT NULL THEN
    SELECT p.full_name INTO v_applicator_name
    FROM profiles p WHERE p.id = v_job.applicator_id;
  END IF;

  -- Vehicle name
  IF v_job.vehicle_id IS NOT NULL THEN
    SELECT v.name INTO v_vehicle_name
    FROM vehicles v WHERE v.id = v_job.vehicle_id;
  END IF;

  -- Generate invoice number (field_application type -> INV-YYYY-NNNN)
  PERFORM pg_advisory_xact_lock(hashtext('invoice_number'));
  SELECT 'INV-' || to_char(CURRENT_DATE, 'YYYY') || '-' ||
         lpad((COALESCE(MAX(regexp_replace(invoice_number, '^INV-\d{4}-', '')::integer), 0) + 1)::text, 4, '0')
    INTO v_invoice_number
    FROM invoices
   WHERE invoice_number LIKE 'INV-' || to_char(CURRENT_DATE, 'YYYY') || '-%';

  INSERT INTO invoices (
    invoice_number, customer_id, invoice_type, status,
    invoice_date, due_date,
    total_amount_cents, total_cost_cents,
    paid_amount_cents, prepay_applied_cents,
    field_names, crop_type, total_acres,
    applicator_name, vehicle_name,
    application_date, header_notes,
    season, created_by, job_id
  ) VALUES (
    v_invoice_number, v_job.customer_id, 'field_application', 'unposted',
    CURRENT_DATE, (CURRENT_DATE + interval '30 days')::date,
    COALESCE(v_job.total_price_cents, 0), 0,
    0, 0,
    v_field_names, v_crop_type, v_total_acres,
    v_applicator_name, v_vehicle_name,
    v_job.scheduled_date, v_job.notes,
    CASE WHEN extract(month FROM CURRENT_DATE) >= 10
         THEN extract(year FROM CURRENT_DATE)::integer + 1
         ELSE extract(year FROM CURRENT_DATE)::integer END,
    p_performed_by, p_job_id
  ) RETURNING id INTO v_invoice_id;

  -- Create line items from job chemicals
  FOR v_chem IN
    SELECT jc.product_id, jc.rate_per_acre, jc.total_cost_cents AS chem_cost,
           jc.total_price_cents AS chem_price,
           p.product_name, p.unit_size, p.epa_registration, p.product_form,
           COALESCE(jc.rate_unit, p.unit_size) AS rate_unit
    FROM job_chemicals jc
    JOIN products p ON p.id = jc.product_id
    WHERE jc.job_id = p_job_id
    ORDER BY p.product_name
  LOOP
    v_item_order := v_item_order + 1;
    v_total_cost_cents := v_total_cost_cents + COALESCE(v_chem.chem_cost, 0);

    -- Calculate total applied: rate_per_acre x total_acres
    v_total_applied := CASE
      WHEN v_chem.rate_per_acre IS NOT NULL AND v_total_acres > 0
      THEN v_chem.rate_per_acre * v_total_acres
      ELSE NULL
    END;

    -- Convert to GL/LB
    v_conversion := NULL;
    IF v_total_applied IS NOT NULL AND v_chem.rate_unit IS NOT NULL THEN
      SELECT * INTO v_conversion
      FROM convert_to_gl_lb(v_total_applied, v_chem.rate_unit, v_chem.product_form);
    END IF;

    INSERT INTO invoice_items (
      invoice_id, product_id, description, quantity,
      unit_size, unit_price_cents, extended_cents,
      cost_cents, sort_order, acres,
      rate_per_acre, rate_unit,
      total_applied, total_applied_unit,
      total_applied_gl_lb, gl_lb_unit,
      epa_registration, product_form,
      is_application_fee
    ) VALUES (
      v_invoice_id, v_chem.product_id, v_chem.product_name, 1,
      v_chem.unit_size, COALESCE(v_chem.chem_price, 0), COALESCE(v_chem.chem_price, 0),
      COALESCE(v_chem.chem_cost, 0), v_item_order, v_total_acres,
      v_chem.rate_per_acre, v_chem.rate_unit,
      v_total_applied,
      COALESCE(v_chem.rate_unit, v_chem.unit_size),
      v_conversion.converted_value,
      v_conversion.converted_unit,
      v_chem.epa_registration,
      v_chem.product_form,
      false  -- not an application fee
    );
  END LOOP;

  -- Update total_cost_cents
  UPDATE invoices SET total_cost_cents = v_total_cost_cents WHERE id = v_invoice_id;

  -- Create invoice_shares with per-grower pricing support
  IF EXISTS (
    SELECT 1 FROM job_fields jf
    JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
    WHERE jf.job_id = p_job_id
  ) THEN
    -- Check if any grower has a price override
    SELECT EXISTS (
      SELECT 1 FROM job_fields jf
      JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
      WHERE jf.job_id = p_job_id
        AND fbd.price_override_cents IS NOT NULL
    ) INTO v_has_price_override;

    -- Acreage-weighted split_pct instead of simple avg()
    FOR v_share IN
      SELECT
        fbd.customer_id,
        c.farm_name,
        CASE WHEN sum(COALESCE(jf.acres_to_treat, 0)) > 0
          THEN sum(fbd.split_pct * COALESCE(jf.acres_to_treat, 0)) / sum(COALESCE(jf.acres_to_treat, 0))
          ELSE avg(fbd.split_pct)
        END AS avg_split_pct,
        sum(COALESCE(jf.acres_to_treat, 0)) *
          CASE WHEN sum(COALESCE(jf.acres_to_treat, 0)) > 0
            THEN sum(fbd.split_pct * COALESCE(jf.acres_to_treat, 0)) / sum(COALESCE(jf.acres_to_treat, 0))
            ELSE avg(fbd.split_pct)
          END / 100.0 AS share_acres,
        bool_or(fbd.is_primary) AS is_primary,
        CASE
          WHEN count(DISTINCT fbd.price_override_cents) = 1
               AND min(fbd.price_override_cents) IS NOT NULL
          THEN min(fbd.price_override_cents)
          ELSE NULL
        END AS price_override_cents,
        max(fbd.pricing_note) AS pricing_note,
        row_number() OVER (ORDER BY bool_or(fbd.is_primary) DESC, c.farm_name) AS sort_ord
      FROM job_fields jf
      JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
      JOIN customers c ON c.id = fbd.customer_id
      WHERE jf.job_id = p_job_id
      GROUP BY fbd.customer_id, c.farm_name
    LOOP
      DECLARE
        v_amount bigint;
        v_ppa bigint;  -- price_per_acre_cents for this share
      BEGIN
        IF v_share.price_override_cents IS NOT NULL THEN
          -- Independent per-grower pricing: price x acres
          v_amount := (v_share.price_override_cents * v_share.share_acres)::bigint;
          v_ppa := v_share.price_override_cents;
        ELSE
          -- Percentage-based split of job total (existing behavior)
          v_amount := (COALESCE(v_job.total_price_cents, 0) * v_share.avg_split_pct / 100.0)::bigint;
          v_ppa := NULL;
        END IF;

        INSERT INTO invoice_shares (
          invoice_id, customer_id, customer_name,
          split_percentage, acres, amount_cents,
          is_primary, sort_order,
          price_per_acre_cents, pricing_note
        ) VALUES (
          v_invoice_id, v_share.customer_id, v_share.farm_name,
          v_share.avg_split_pct, v_share.share_acres, v_amount,
          v_share.is_primary, v_share.sort_ord,
          v_ppa, v_share.pricing_note
        );

        v_share_total := v_share_total + v_amount;
      END;
    END LOOP;

    -- When ANY grower has a price override, the invoice total must reflect
    -- actual pricing (sum of share amounts), not the job's calculated total
    IF v_has_price_override THEN
      UPDATE invoices SET
        total_amount_cents = v_share_total
      WHERE id = v_invoice_id;
    END IF;

  ELSE
    -- No billing defaults: 100% to primary customer
    INSERT INTO invoice_shares (
      invoice_id, customer_id, customer_name,
      split_percentage, acres, amount_cents, is_primary, sort_order
    )
    SELECT
      v_invoice_id,
      v_job.customer_id,
      c.farm_name,
      100.0,
      v_total_acres,
      COALESCE(v_job.total_price_cents, 0),
      true,
      1
    FROM customers c WHERE c.id = v_job.customer_id;
  END IF;

  -- Update job
  UPDATE jobs SET
    status = 'invoiced',
    invoice_id = v_invoice_id
  WHERE id = p_job_id;

  -- Link application record to invoice
  UPDATE application_records SET
    invoice_id = v_invoice_id
  WHERE source_type = 'job' AND source_id = p_job_id;

  -- Log activity
  INSERT INTO activity_log (action, entity_type, entity_id, performed_by, details)
  VALUES (
    'transfer_to_invoice', 'job', p_job_id, p_performed_by,
    jsonb_build_object(
      'job_number', v_job.job_number,
      'invoice_id', v_invoice_id,
      'invoice_number', v_invoice_number,
      'total_amount_cents', CASE WHEN v_has_price_override THEN v_share_total ELSE v_job.total_price_cents END
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'job_id', p_job_id,
    'invoice_id', v_invoice_id,
    'invoice_number', v_invoice_number
  );
END;
$$;

GRANT EXECUTE ON FUNCTION transfer_job_to_invoice(uuid, uuid) TO authenticated;


-- ============================================================================
-- BUG 5: Add auth check to post_invoice
-- The function had no auth.uid() verification — any caller could post.
-- Source: 20260312200000_business_logic_audit_fixes.sql L249
-- ============================================================================

CREATE OR REPLACE FUNCTION post_invoice(p_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv record;
BEGIN
  -- BUG 5 FIX: Require authentication and proper role
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'Not authorized to post invoices';
  END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found: %', p_invoice_id;
  END IF;

  -- Enforce accounting period
  PERFORM check_period_open(v_inv.invoice_date);

  IF v_inv.status NOT IN ('draft', 'unposted') THEN
    RAISE EXCEPTION 'Cannot post invoice with status: %', v_inv.status;
  END IF;

  SET LOCAL app.admin_override = 'true';

  UPDATE invoices SET
    status = 'posted',
    posted_by = auth.uid(),
    posted_at = now(),
    updated_at = now()
  WHERE id = p_invoice_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'invoice_posted', 'invoice', p_invoice_id,
    (SELECT role FROM profiles WHERE id = auth.uid()),
    jsonb_build_object('status', v_inv.status),
    jsonb_build_object('status', 'posted', 'posted_at', now()::text),
    v_inv.total_amount_cents,
    'Posted ' || v_inv.invoice_number || ' for $' || (v_inv.total_amount_cents / 100.0)::numeric(12,2)
  );

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_posted',
    'Posted invoice ' || v_inv.invoice_number || ' — $' || (v_inv.total_amount_cents / 100.0)::numeric(12,2),
    auth.uid(), 'invoice', p_invoice_id, v_inv.customer_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION post_invoice(uuid) TO authenticated;


-- ============================================================================
-- BUG 6: Add auth check to confirm_delivery
-- The function had no auth.uid() verification.
-- Source: 20260228300000_critical_prelaunch_fixes.sql L569
-- ============================================================================

CREATE OR REPLACE FUNCTION confirm_delivery(p_delivery_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_delivery record;
BEGIN
  -- BUG 6 FIX: Require authentication and proper role
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales_rep', 'driver')) THEN
    RAISE EXCEPTION 'Not authorized to confirm deliveries';
  END IF;

  SELECT * INTO v_delivery FROM deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery not found'; END IF;
  IF v_delivery.status != 'scheduled' THEN
    RAISE EXCEPTION 'Delivery must be scheduled to confirm (current: %)', v_delivery.status;
  END IF;

  SET LOCAL app.admin_override = 'true';
  UPDATE deliveries SET status = 'in_progress', updated_at = now() WHERE id = p_delivery_id;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('delivery_confirmed', 'Delivery ' || v_delivery.delivery_number || ' confirmed (in progress)', auth.uid(), 'delivery', p_delivery_id, v_delivery.customer_id);
END;
$$;

GRANT EXECUTE ON FUNCTION confirm_delivery(uuid) TO authenticated;
