-- Sprint 14: Grower Share Transparency
-- Adds per-grower price override to field_billing_defaults and invoice_shares.
-- When a grower has price_override_cents set, their invoice share amount is
-- calculated as price × acres instead of percentage of total.
-- Rewrites transfer_job_to_invoice() share logic and updates
-- get_detailed_statement_data() to include pricing fields.
-- Also updates save_field() to persist new billing default columns.

-- ─── Add per-grower pricing to field_billing_defaults ────────────────────────

ALTER TABLE public.field_billing_defaults
  ADD COLUMN IF NOT EXISTS price_override_cents bigint,
  ADD COLUMN IF NOT EXISTS pricing_note text;

-- ─── Add per-share pricing to invoice_shares ─────────────────────────────────

ALTER TABLE public.invoice_shares
  ADD COLUMN IF NOT EXISTS price_per_acre_cents bigint,
  ADD COLUMN IF NOT EXISTS pricing_note text;

-- ─── Update save_field() to persist new columns ─────────────────────────────

CREATE OR REPLACE FUNCTION save_field(
  p_field_id uuid,
  p_field_payload jsonb,
  p_billing_defaults jsonb DEFAULT '[]'::jsonb,
  p_performed_by uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_field_id uuid;
  v_total_pct numeric;
BEGIN
  -- Validate billing splits total 100%
  IF jsonb_array_length(p_billing_defaults) > 0 THEN
    SELECT COALESCE(SUM((elem->>'split_pct')::numeric), 0) INTO v_total_pct
    FROM jsonb_array_elements(p_billing_defaults) AS elem;

    IF ABS(v_total_pct - 100) > 0.01 THEN
      RAISE EXCEPTION 'Billing splits must total 100%% (got %.2f%%)', v_total_pct;
    END IF;
  END IF;

  IF p_field_id IS NULL THEN
    -- Create new field
    INSERT INTO fields (
      customer_id, field_name, legal_description, county, state,
      total_acres, fsa_farm_number, fsa_tract_number, fsa_field_number,
      crop_type, soil_type, irrigation, notes, is_active
    )
    SELECT
      (p_field_payload->>'customer_id')::uuid,
      p_field_payload->>'field_name',
      p_field_payload->>'legal_description',
      p_field_payload->>'county',
      COALESCE(p_field_payload->>'state', 'IL'),
      (p_field_payload->>'total_acres')::numeric,
      p_field_payload->>'fsa_farm_number',
      p_field_payload->>'fsa_tract_number',
      p_field_payload->>'fsa_field_number',
      p_field_payload->>'crop_type',
      p_field_payload->>'soil_type',
      COALESCE((p_field_payload->>'irrigation')::boolean, false),
      p_field_payload->>'notes',
      COALESCE((p_field_payload->>'is_active')::boolean, true)
    RETURNING id INTO v_field_id;
  ELSE
    -- Update existing field
    UPDATE fields SET
      customer_id = (p_field_payload->>'customer_id')::uuid,
      field_name = p_field_payload->>'field_name',
      legal_description = p_field_payload->>'legal_description',
      county = p_field_payload->>'county',
      state = COALESCE(p_field_payload->>'state', 'IL'),
      total_acres = (p_field_payload->>'total_acres')::numeric,
      fsa_farm_number = p_field_payload->>'fsa_farm_number',
      fsa_tract_number = p_field_payload->>'fsa_tract_number',
      fsa_field_number = p_field_payload->>'fsa_field_number',
      crop_type = p_field_payload->>'crop_type',
      soil_type = p_field_payload->>'soil_type',
      irrigation = COALESCE((p_field_payload->>'irrigation')::boolean, false),
      notes = p_field_payload->>'notes',
      is_active = COALESCE((p_field_payload->>'is_active')::boolean, true)
    WHERE id = p_field_id;

    v_field_id := p_field_id;
  END IF;

  -- Replace billing defaults (delete-then-insert pattern)
  DELETE FROM field_billing_defaults WHERE field_id = v_field_id;

  IF jsonb_array_length(p_billing_defaults) > 0 THEN
    INSERT INTO field_billing_defaults (
      field_id, customer_id, split_pct, is_primary, notes,
      price_override_cents, pricing_note
    )
    SELECT
      v_field_id,
      (elem->>'customer_id')::uuid,
      (elem->>'split_pct')::numeric,
      COALESCE((elem->>'is_primary')::boolean, false),
      elem->>'notes',
      (elem->>'price_override_cents')::bigint,
      elem->>'pricing_note'
    FROM jsonb_array_elements(p_billing_defaults) AS elem;
  END IF;

  -- Log activity
  IF p_performed_by IS NOT NULL THEN
    INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
    VALUES ('field_saved', 'Field saved: ' || (p_field_payload->>'field_name'), p_performed_by, 'field', v_field_id);
  END IF;

  RETURN v_field_id;
END;
$$;

GRANT EXECUTE ON FUNCTION save_field(uuid, jsonb, jsonb, uuid) TO authenticated;

-- ─── Rewrite transfer_job_to_invoice() share calculation ─────────────────────
-- Now supports per-grower price override:
--   IF price_override_cents IS NOT NULL:
--     amount_cents = price_override_cents × share_acres
--   ELSE:
--     amount_cents = total_price × split_pct / 100 (existing behavior)
-- When ANY grower has a price override, the invoice total becomes the SUM of
-- all share amounts instead of the job's calculated total.

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
  IF v_job.status NOT IN ('completed', 'scheduled') THEN
    RAISE EXCEPTION 'Job must be completed or scheduled to invoice (status: %)', v_job.status;
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

  -- Generate invoice number (field_application type → INV-YYYY-NNNN)
  PERFORM pg_advisory_xact_lock(hashtext('invoice_number'));
  SELECT 'INV-' || to_char(CURRENT_DATE, 'YYYY') || '-' ||
         lpad((COALESCE(MAX(regexp_replace(invoice_number, '^INV-\d{4}-', '')::integer), 0) + 1)::text, 4, '0')
    INTO v_invoice_number
    FROM invoices
   WHERE invoice_number LIKE 'INV-' || to_char(CURRENT_DATE, 'YYYY') || '-%';

  -- Create the invoice
  INSERT INTO invoices (
    invoice_number, customer_id, invoice_type, status,
    invoice_date, due_date,
    total_amount_cents, total_cost_cents, balance_cents,
    paid_amount_cents, prepay_applied_cents,
    field_names, crop_type, total_acres,
    applicator_name, vehicle_name,
    application_date, header_notes,
    season, created_by, job_id
  ) VALUES (
    v_invoice_number, v_job.customer_id, 'field_application', 'unposted',
    CURRENT_DATE, (CURRENT_DATE + interval '30 days')::date,
    COALESCE(v_job.total_price_cents, 0), 0, COALESCE(v_job.total_price_cents, 0),
    0, 0,
    v_field_names, v_crop_type, v_total_acres,
    v_applicator_name, v_vehicle_name,
    v_job.scheduled_date, v_job.notes,
    CASE WHEN extract(month FROM CURRENT_DATE) >= 7
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

    -- Calculate total applied: rate_per_acre × total_acres
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

  -- ─── Create invoice_shares with per-grower pricing support ────────────────
  -- If any grower has a price_override_cents in field_billing_defaults,
  -- their share amount = price_override_cents × their allocated acres.
  -- For growers WITHOUT override, standard pct-based split applies.
  -- When overrides exist, invoice total = SUM(all share amounts).

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

    -- Insert shares from field billing defaults
    FOR v_share IN
      SELECT
        fbd.customer_id,
        c.farm_name,
        avg(fbd.split_pct) AS avg_split_pct,
        sum(COALESCE(jf.acres_to_treat, 0)) * avg(fbd.split_pct) / 100.0 AS share_acres,
        bool_or(fbd.is_primary) AS is_primary,
        -- If ALL rows for this customer have the same price_override, use it;
        -- otherwise fall back to percentage-based
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
          -- Independent per-grower pricing: price × acres
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
        total_amount_cents = v_share_total,
        balance_cents = v_share_total
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

-- ─── Update get_detailed_statement_data() to include pricing fields ──────────
-- Adds price_per_acre_cents and pricing_note to shares JSON.
-- Filters shares to only show the requesting customer's own share pricing
-- (other growers' pricing is private).

CREATE OR REPLACE FUNCTION get_detailed_statement_data(
  p_customer_id uuid,
  p_as_of_date  date,
  p_mode        text DEFAULT 'summary'
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

    -- Get shares (include pricing fields, but only show pricing for the
    -- requesting customer — other growers' pricing is private)
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'customer_name', s.customer_name,
          'split_percentage', s.split_percentage,
          'acres', s.acres,
          'amount_cents', s.amount_cents,
          'is_primary', s.is_primary,
          'price_per_acre_cents', CASE
            WHEN s.customer_id = p_customer_id THEN s.price_per_acre_cents
            ELSE NULL
          END,
          'pricing_note', CASE
            WHEN s.customer_id = p_customer_id THEN s.pricing_note
            ELSE NULL
          END
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
