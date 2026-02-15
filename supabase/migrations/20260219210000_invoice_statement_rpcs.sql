-- ============================================================================
-- INVOICE & STATEMENT RPCs
-- CRX Manager V1.0
-- Date: 2026-02-19
--
-- 1. Rewrite transfer_job_to_invoice() — fix column mismatches, populate
--    new snapshot fields, create invoice_shares from field_billing_defaults,
--    use type-aware invoice numbering
-- 2. New get_detailed_statement_data() — assembles all data needed for
--    detailed statement PDF generation
-- 3. Update generate_batch_statements() — accepts mode/show_shares params
-- ============================================================================

-- ============================================================================
-- 1. REWRITE transfer_job_to_invoice()
-- ============================================================================
-- The original version had column name mismatches with the actual schema
-- (total_amount vs total_amount_cents, product_name vs description, etc.)
-- and didn't populate field/crop/applicator/vehicle context.

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
BEGIN
  -- Lock the job
  SELECT j.* INTO v_job
  FROM jobs j WHERE j.id = p_job_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found: %', p_job_id;
  END IF;

  IF v_job.status != 'completed' THEN
    RAISE EXCEPTION 'Only completed jobs can be transferred to invoice. Current status: %', v_job.status;
  END IF;

  IF v_job.invoice_id IS NOT NULL THEN
    RAISE EXCEPTION 'Job already has an invoice';
  END IF;

  -- Gather field names, crop types, total acres from job_fields
  SELECT
    array_agg(DISTINCT f.field_name ORDER BY f.field_name),
    array_agg(DISTINCT f.crop_type) FILTER (WHERE f.crop_type IS NOT NULL),
    COALESCE(sum(jf.acres_to_treat), v_job.total_acres, 0)
  INTO v_field_names, v_crop_types, v_total_acres
  FROM job_fields jf
  JOIN fields f ON f.id = jf.field_id
  WHERE jf.job_id = p_job_id;

  -- Use first crop type (most jobs apply to one crop)
  IF v_crop_types IS NOT NULL AND array_length(v_crop_types, 1) > 0 THEN
    v_crop_type := v_crop_types[1];
  END IF;

  -- Fallback total_acres from job if not computed from fields
  IF v_total_acres = 0 OR v_total_acres IS NULL THEN
    v_total_acres := COALESCE(v_job.total_acres, 0);
  END IF;

  -- Get applicator name
  IF v_job.applicator_id IS NOT NULL THEN
    SELECT full_name INTO v_applicator_name
    FROM profiles WHERE id = v_job.applicator_id;
  END IF;

  -- Get vehicle name
  IF v_job.vehicle_id IS NOT NULL THEN
    SELECT vehicle_name INTO v_vehicle_name
    FROM vehicles WHERE id = v_job.vehicle_id;
  END IF;

  -- Generate type-aware invoice number
  v_invoice_number := next_invoice_number('field_application');

  -- Calculate total cost
  SELECT COALESCE(sum(jc.quantity * jc.cost_per_unit_cents), 0)
  INTO v_total_cost_cents
  FROM job_chemicals jc
  WHERE jc.job_id = p_job_id;

  -- Create invoice with enriched data
  INSERT INTO invoices (
    invoice_number, customer_id, invoice_type, invoice_date, due_date,
    total_amount_cents, total_cost_cents, status, season, created_by,
    header_notes,
    crop_type, field_names, total_acres,
    applicator_name, vehicle_name, application_date, job_id
  ) VALUES (
    v_invoice_number,
    v_job.customer_id,
    'field_application',
    current_date,
    current_date + interval '30 days',
    COALESCE(v_job.total_price_cents, 0),
    v_total_cost_cents,
    'unposted',
    v_job.season,
    p_performed_by,
    'Auto-generated from job ' || v_job.job_number,
    v_crop_type,
    v_field_names,
    v_total_acres,
    v_applicator_name,
    v_vehicle_name,
    v_job.job_date,
    p_job_id
  )
  RETURNING id INTO v_invoice_id;

  -- Create invoice items from job chemicals with enriched data
  FOR v_chem IN
    SELECT jc.*, p.product_name, p.epa_registration, p.product_form
    FROM job_chemicals jc
    LEFT JOIN products p ON p.id = jc.product_id
    WHERE jc.job_id = p_job_id
    ORDER BY jc.sort_order
  LOOP
    v_item_order := v_item_order + 1;

    -- Compute total applied: rate_per_acre * total_acres
    v_total_applied := NULL;
    IF v_chem.rate_per_acre IS NOT NULL AND v_total_acres > 0 THEN
      v_total_applied := v_chem.rate_per_acre * v_total_acres;
    ELSE
      v_total_applied := v_chem.quantity;
    END IF;

    -- Compute GL/LB conversion
    SELECT * INTO v_conversion
    FROM convert_to_gl_lb(
      v_total_applied,
      COALESCE(v_chem.rate_unit, v_chem.unit),
      v_chem.product_form
    );

    INSERT INTO invoice_items (
      invoice_id, product_id, description,
      quantity, unit_price_cents, extended_cents, cost_cents,
      sort_order, rate_per_acre, acres, unit_size,
      rate_unit, total_applied, total_applied_unit,
      total_applied_gl_lb, gl_lb_unit,
      epa_registration, product_form, is_application_fee
    ) VALUES (
      v_invoice_id,
      v_chem.product_id,
      COALESCE(v_chem.product_name, 'Unknown Product'),
      v_chem.quantity,
      COALESCE(v_chem.price_per_unit_cents, 0),
      COALESCE(v_chem.quantity * v_chem.price_per_unit_cents, 0),
      COALESCE(v_chem.quantity * v_chem.cost_per_unit_cents, 0),
      v_item_order,
      v_chem.rate_per_acre,
      v_total_acres,
      COALESCE(v_chem.rate_unit, v_chem.unit),
      COALESCE(v_chem.rate_unit, v_chem.unit),
      v_total_applied,
      COALESCE(v_chem.rate_unit, v_chem.unit),
      v_conversion.converted_value,
      v_conversion.converted_unit,
      v_chem.epa_registration,
      v_chem.product_form,
      false  -- not an application fee
    );
  END LOOP;

  -- Create invoice_shares from field_billing_defaults
  -- Aggregate billing defaults across all fields in this job
  -- If no billing defaults exist, create a single 100% share for the primary customer
  IF EXISTS (
    SELECT 1 FROM job_fields jf
    JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
    WHERE jf.job_id = p_job_id
  ) THEN
    -- Insert shares from field billing defaults (averaged/aggregated across fields)
    INSERT INTO invoice_shares (
      invoice_id, customer_id, customer_name,
      split_percentage, acres, amount_cents, is_primary, sort_order
    )
    SELECT
      v_invoice_id,
      fbd.customer_id,
      c.farm_name,
      avg(fbd.split_pct),
      sum(COALESCE(jf.acres_to_treat, 0)) * avg(fbd.split_pct) / 100.0,
      (COALESCE(v_job.total_price_cents, 0) * avg(fbd.split_pct) / 100.0)::bigint,
      bool_or(fbd.is_primary),
      row_number() OVER (ORDER BY bool_or(fbd.is_primary) DESC, c.farm_name)
    FROM job_fields jf
    JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
    JOIN customers c ON c.id = fbd.customer_id
    WHERE jf.job_id = p_job_id
    GROUP BY fbd.customer_id, c.farm_name;
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
      'total_amount_cents', v_job.total_price_cents
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
-- 2. NEW RPC: get_detailed_statement_data()
-- ============================================================================
-- Assembles all data needed for both summary and detailed statement PDFs.
-- Returns JSONB with customer info, transactions (with optional embedded
-- product detail), shares, finance charges, and aging buckets.

CREATE OR REPLACE FUNCTION get_detailed_statement_data(
  p_customer_id uuid,
  p_as_of_date  date,
  p_mode        text DEFAULT 'summary'  -- 'summary' or 'detailed'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_customer RECORD;
  v_transactions jsonb;
  v_aging jsonb;
  v_balance bigint := 0;
  v_inv RECORD;
  v_items jsonb;
  v_shares jsonb;
  v_finance_cents bigint;
  v_txn_list jsonb := '[]'::jsonb;
  v_days_aged integer;
  v_description text;
  v_grower_names text[];
BEGIN
  -- Get customer info
  SELECT * INTO v_customer FROM customers WHERE id = p_customer_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer not found: %', p_customer_id;
  END IF;

  -- Loop through posted invoices with balance
  FOR v_inv IN
    SELECT i.*
    FROM invoices i
    WHERE i.customer_id = p_customer_id
      AND i.status = 'posted'
      AND i.balance_cents > 0
      AND i.deleted_at IS NULL
      AND i.invoice_date <= p_as_of_date
    ORDER BY i.invoice_date, i.invoice_number
  LOOP
    v_balance := v_balance + v_inv.balance_cents;
    v_days_aged := p_as_of_date - v_inv.invoice_date;

    -- Build description line
    IF v_inv.invoice_type = 'field_application' AND v_inv.crop_type IS NOT NULL THEN
      v_description := COALESCE(v_inv.crop_type, '')
        || ' - ' || COALESCE(v_inv.total_acres::text, '')
        || ' - ' || COALESCE(array_to_string(v_inv.field_names, ', '), '');
    ELSIF v_inv.invoice_type = 'chemical_sale' THEN
      v_description := 'Chemical Sale: ' || COALESCE(v_inv.header_notes, '');
    ELSE
      v_description := COALESCE(v_inv.header_notes, v_inv.invoice_type);
    END IF;

    -- Get shares
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'customer_name', s.customer_name,
          'split_percentage', s.split_percentage,
          'acres', s.acres,
          'amount_cents', s.amount_cents,
          'is_primary', s.is_primary
        ) ORDER BY s.sort_order
      ),
      '[]'::jsonb
    )
    INTO v_shares
    FROM invoice_shares s
    WHERE s.invoice_id = v_inv.id;

    -- Get grower names for display
    SELECT array_agg(s.customer_name ORDER BY s.sort_order)
    INTO v_grower_names
    FROM invoice_shares s
    WHERE s.invoice_id = v_inv.id;

    -- Get items (only for detailed mode)
    v_items := '[]'::jsonb;
    IF p_mode = 'detailed' THEN
      SELECT COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'product_name', ii.description,
            'epa_registration', ii.epa_registration,
            'rate_per_acre', ii.rate_per_acre,
            'rate_unit', ii.rate_unit,
            'total_applied', ii.total_applied,
            'total_applied_unit', ii.total_applied_unit,
            'total_applied_gl_lb', ii.total_applied_gl_lb,
            'gl_lb_unit', ii.gl_lb_unit,
            'unit_price_cents', ii.unit_price_cents,
            'total_cost_cents', ii.extended_cents,
            'is_application_fee', COALESCE(ii.is_application_fee, false),
            'quantity', ii.quantity,
            'unit_size', ii.unit_size,
            'product_form', ii.product_form
          ) ORDER BY ii.sort_order
        ),
        '[]'::jsonb
      )
      INTO v_items
      FROM invoice_items ii
      WHERE ii.invoice_id = v_inv.id;
    END IF;

    -- Get finance charges associated with this invoice
    SELECT COALESCE(sum(fc.amount_cents), 0)
    INTO v_finance_cents
    FROM finance_charges fc
    WHERE fc.invoice_id = v_inv.id;

    -- Build transaction entry
    v_txn_list := v_txn_list || jsonb_build_object(
      'invoice_number', v_inv.invoice_number,
      'invoice_date', v_inv.invoice_date,
      'due_date', v_inv.due_date,
      'invoice_type', v_inv.invoice_type,
      'status', v_inv.status,
      'days_aged', v_days_aged,
      'description', v_description,
      'crop_type', v_inv.crop_type,
      'field_names', v_inv.field_names,
      'total_acres', v_inv.total_acres,
      'grower_names', v_grower_names,
      'total_amount_cents', v_inv.total_amount_cents,
      'paid_amount_cents', v_inv.paid_amount_cents,
      'prepay_applied_cents', v_inv.prepay_applied_cents,
      'balance_cents', v_inv.balance_cents,
      'items', v_items,
      'shares', v_shares,
      'finance_charge_cents', v_finance_cents,
      'net_due_cents', v_inv.balance_cents + v_finance_cents,
      'price_per_acre', CASE
        WHEN v_inv.total_acres > 0 THEN
          round(v_inv.total_amount_cents / 100.0 / v_inv.total_acres, 2)
        ELSE NULL
      END
    );
  END LOOP;

  -- Compute aging buckets
  SELECT jsonb_build_object(
    'current_cents', COALESCE(sum(CASE WHEN p_as_of_date - i.invoice_date <= 30 THEN i.balance_cents ELSE 0 END), 0),
    'days_30_cents', COALESCE(sum(CASE WHEN p_as_of_date - i.invoice_date BETWEEN 31 AND 60 THEN i.balance_cents ELSE 0 END), 0),
    'days_60_cents', COALESCE(sum(CASE WHEN p_as_of_date - i.invoice_date BETWEEN 61 AND 90 THEN i.balance_cents ELSE 0 END), 0),
    'days_90_cents', COALESCE(sum(CASE WHEN p_as_of_date - i.invoice_date BETWEEN 91 AND 120 THEN i.balance_cents ELSE 0 END), 0),
    'over_90_cents', COALESCE(sum(CASE WHEN p_as_of_date - i.invoice_date > 90 THEN i.balance_cents ELSE 0 END), 0)
  )
  INTO v_aging
  FROM invoices i
  WHERE i.customer_id = p_customer_id
    AND i.status = 'posted'
    AND i.balance_cents > 0
    AND i.deleted_at IS NULL
    AND i.invoice_date <= p_as_of_date;

  RETURN jsonb_build_object(
    'customer', jsonb_build_object(
      'id', v_customer.id,
      'farm_name', v_customer.farm_name,
      'contact_name', v_customer.contact_name,
      'account_number', v_customer.account_number,
      'email', v_customer.email,
      'phone', v_customer.phone,
      'billing_address', v_customer.billing_address,
      'city', v_customer.city,
      'state', v_customer.state,
      'zip', v_customer.zip,
      'payment_terms', v_customer.payment_terms
    ),
    'transactions', v_txn_list,
    'aging', v_aging,
    'outstanding_balance_cents', v_balance,
    'as_of_date', p_as_of_date,
    'mode', p_mode
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_detailed_statement_data(uuid, date, text) TO authenticated;

-- ============================================================================
-- 3. UPDATE generate_batch_statements()
-- ============================================================================
-- Now accepts mode and show_shares parameters. Delegates to
-- get_detailed_statement_data() per customer for enriched data.

CREATE OR REPLACE FUNCTION generate_batch_statements(
  p_as_of_date   date,
  p_performed_by uuid,
  p_mode         text DEFAULT 'summary'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_customers jsonb := '[]'::jsonb;
  v_cust RECORD;
  v_stmt jsonb;
BEGIN
  -- Find all active customers with outstanding balance
  FOR v_cust IN
    SELECT DISTINCT c.id, c.farm_name
    FROM customers c
    INNER JOIN invoices i
      ON i.customer_id = c.id
      AND i.status = 'posted'
      AND i.balance_cents > 0
      AND i.deleted_at IS NULL
      AND i.invoice_date <= p_as_of_date
    WHERE c.is_active = true
    ORDER BY c.farm_name
  LOOP
    v_stmt := get_detailed_statement_data(v_cust.id, p_as_of_date, p_mode);
    v_customers := v_customers || v_stmt;
  END LOOP;

  RETURN v_customers;
END;
$$;

GRANT EXECUTE ON FUNCTION generate_batch_statements(date, uuid, text) TO authenticated;

-- ============================================================================
-- DONE
-- ============================================================================
