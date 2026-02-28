-- Phase 0: Audit remediation quick fixes
-- Fix #4: Finance charge non-compounding — exclude misc_charge invoices from overdue balance
-- Fix #5: Billing split concurrency lock — FOR UPDATE on field_billing_defaults

-- ============================================================================
-- FIX #4a: generate_finance_charges() compounds interest by including prior
-- finance charge invoices (invoice_type = 'misc_charge') in overdue balance.
-- FIX: Exclude misc_charge invoices from the overdue balance calculation.
-- Source: 20260315200001_accounting_and_integrity_fixes.sql line 429
-- Change: Added "AND i.invoice_type != 'misc_charge'" to the invoice JOIN
-- ============================================================================

CREATE OR REPLACE FUNCTION public.generate_finance_charges(
  p_as_of_date    date,
  p_performed_by  uuid,
  p_customer_ids  uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_customer record;
  v_charge_amount bigint;
  v_invoice_id uuid;
  v_inv_num text;
  v_charges jsonb := '[]'::jsonb;
  v_count integer := 0;
  v_skipped integer := 0;
  v_min_balance bigint;
BEGIN
  -- FIX #13: Enforce accounting period
  PERFORM public.check_period_open(p_as_of_date);

  -- Read minimum balance threshold
  SELECT COALESCE(s.setting_value::bigint, 500)
    INTO v_min_balance
    FROM public.app_settings s
   WHERE s.setting_key = 'finance_charge_min_balance_cents';

  IF v_min_balance IS NULL THEN
    v_min_balance := 500;
  END IF;

  FOR v_customer IN
    SELECT c.id AS customer_id, c.farm_name, c.finance_charge_rate,
           COALESCE(c.finance_charge_grace_days, 0) AS grace_days,
           COALESCE(sum(i.balance_cents), 0) AS overdue_balance
      FROM public.customers c
      INNER JOIN public.invoices i
        ON i.customer_id = c.id
        AND i.status = 'posted'
        AND i.balance_cents > 0
        AND i.deleted_at IS NULL
        AND i.invoice_type != 'misc_charge'  -- FIX #4: exclude prior finance charges
        AND i.due_date IS NOT NULL
        AND i.due_date < (p_as_of_date - (COALESCE(c.finance_charge_grace_days, 0) || ' days')::interval)
      WHERE c.finance_charge_rate > 0
        AND c.is_active = true
        AND COALESCE(c.finance_charge_enabled, true) = true
        AND (p_customer_ids IS NULL OR c.id = ANY(p_customer_ids))
      GROUP BY c.id, c.farm_name, c.finance_charge_rate, c.finance_charge_grace_days
      HAVING sum(i.balance_cents) >= v_min_balance
  LOOP
    -- Idempotency guard — skip if already charged for this period
    IF EXISTS (
      SELECT 1 FROM public.finance_charges
      WHERE customer_id = v_customer.customer_id
        AND period_end = p_as_of_date
    ) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    -- Monthly rate = annual rate / 12
    v_charge_amount := ROUND(v_customer.overdue_balance * (v_customer.finance_charge_rate / 100.0 / 12.0));

    IF v_charge_amount > 0 THEN
      -- Generate invoice number
      PERFORM pg_advisory_xact_lock(hashtext('invoice_number'));
      SELECT 'FC-' || to_char(CURRENT_DATE, 'YYYY') || '-' ||
             lpad((COALESCE(MAX(regexp_replace(invoice_number, '^FC-\d{4}-', '')::integer), 0) + 1)::text, 4, '0')
        INTO v_inv_num
        FROM public.invoices
       WHERE invoice_number LIKE 'FC-' || to_char(CURRENT_DATE, 'YYYY') || '-%';

      INSERT INTO public.invoices (
        invoice_number, customer_id, invoice_type, status, invoice_date, due_date,
        total_amount_cents, total_cost_cents,
        header_notes, season, created_by
      ) VALUES (
        v_inv_num, v_customer.customer_id, 'misc_charge', 'unposted', p_as_of_date,
        (p_as_of_date + interval '30 days')::date,
        v_charge_amount, 0,
        'Finance charge: ' || v_customer.finance_charge_rate || '% annual on overdue balance of $' ||
        to_char(v_customer.overdue_balance / 100.0, 'FM999,999,990.00') ||
        CASE WHEN v_customer.grace_days > 0
             THEN ' (after ' || v_customer.grace_days || ' day grace period)'
             ELSE '' END,
        CASE WHEN extract(month FROM p_as_of_date) >= 7
             THEN extract(year FROM p_as_of_date)::integer + 1
             ELSE extract(year FROM p_as_of_date)::integer END,
        p_performed_by
      ) RETURNING id INTO v_invoice_id;

      INSERT INTO public.invoice_items (
        invoice_id, description, quantity, unit_price_cents, extended_cents,
        cost_cents, is_application_fee, sort_order
      ) VALUES (
        v_invoice_id,
        'Finance Charge — ' || v_customer.finance_charge_rate || '% annual rate on overdue balance',
        1, v_charge_amount, v_charge_amount,
        0, false, 1
      );

      INSERT INTO public.finance_charges (
        customer_id, invoice_id, amount_cents, charge_rate,
        base_amount_cents, period_start, period_end, created_by
      ) VALUES (
        v_customer.customer_id, v_invoice_id, v_charge_amount,
        v_customer.finance_charge_rate, v_customer.overdue_balance,
        (p_as_of_date - interval '30 days')::date, p_as_of_date,
        p_performed_by
      );

      -- Audit log
      INSERT INTO public.financial_audit_log (
        operation_type, entity_type, entity_id,
        actor_user_id, total_impact_cents, description
      ) VALUES (
        'finance_charge', 'invoice', v_invoice_id,
        p_performed_by, v_charge_amount,
        'Finance charge generated for ' || v_customer.farm_name ||
        ': $' || to_char(v_charge_amount / 100.0, 'FM999,999,990.00') ||
        ' at ' || v_customer.finance_charge_rate || '% on $' ||
        to_char(v_customer.overdue_balance / 100.0, 'FM999,999,990.00') || ' overdue'
      );

      v_count := v_count + 1;
      v_charges := v_charges || jsonb_build_object(
        'customer', v_customer.farm_name,
        'base_balance_cents', v_customer.overdue_balance,
        'charge_cents', v_charge_amount,
        'rate', v_customer.finance_charge_rate,
        'invoice_number', v_inv_num,
        'grace_days', v_customer.grace_days
      );
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'charges_generated', v_count,
    'skipped_already_charged', v_skipped,
    'details', v_charges
  );
END;
$$;


-- ============================================================================
-- FIX #4b: preview_finance_charges() has the same compounding bug.
-- FIX: Exclude misc_charge invoices from the overdue balance subquery.
-- Source: 20260220200000_finance_charge_intelligence.sql line 22
-- Change: Added "AND i.invoice_type != 'misc_charge'" to the invoice WHERE
-- ============================================================================

CREATE OR REPLACE FUNCTION public.preview_finance_charges(
  p_as_of_date date
)
RETURNS TABLE(
  customer_id        uuid,
  customer_name      text,
  account_number     text,
  overdue_balance_cents bigint,
  charge_rate        numeric,
  grace_days         integer,
  days_overdue       integer,
  charge_amount_cents bigint,
  finance_charge_enabled boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STABLE
AS $$
DECLARE
  v_min_balance bigint;
BEGIN
  -- Read minimum balance threshold from app_settings
  SELECT COALESCE(s.setting_value::bigint, 500)
    INTO v_min_balance
    FROM public.app_settings s
   WHERE s.setting_key = 'finance_charge_min_balance_cents';

  IF v_min_balance IS NULL THEN
    v_min_balance := 500;
  END IF;

  RETURN QUERY
  SELECT
    c.id AS customer_id,
    c.farm_name::text AS customer_name,
    c.account_number::text AS account_number,
    agg.overdue_balance_cents,
    c.finance_charge_rate AS charge_rate,
    COALESCE(c.finance_charge_grace_days, 0) AS grace_days,
    agg.max_days_overdue AS days_overdue,
    ROUND(agg.overdue_balance_cents * (c.finance_charge_rate / 100.0 / 12.0))::bigint AS charge_amount_cents,
    COALESCE(c.finance_charge_enabled, true) AS finance_charge_enabled
  FROM public.customers c
  INNER JOIN (
    SELECT
      i.customer_id,
      COALESCE(sum(i.balance_cents), 0)::bigint AS overdue_balance_cents,
      max((p_as_of_date - i.due_date))::integer AS max_days_overdue
    FROM public.invoices i
    WHERE i.status = 'posted'
      AND i.balance_cents > 0
      AND i.deleted_at IS NULL
      AND i.invoice_type != 'misc_charge'  -- FIX #4b: exclude prior finance charges
      AND i.due_date IS NOT NULL
      AND i.due_date < p_as_of_date
    GROUP BY i.customer_id
  ) agg ON agg.customer_id = c.id
  WHERE c.finance_charge_rate > 0
    AND c.is_active = true
    AND COALESCE(c.finance_charge_enabled, true) = true
    AND agg.overdue_balance_cents >= v_min_balance
    AND agg.max_days_overdue > COALESCE(c.finance_charge_grace_days, 0)
    AND ROUND(agg.overdue_balance_cents * (c.finance_charge_rate / 100.0 / 12.0))::bigint > 0
  ORDER BY c.farm_name;
END;
$$;


-- ============================================================================
-- FIX #5: transfer_job_to_invoice() reads field_billing_defaults without
-- FOR UPDATE. Concurrent edits can corrupt split percentages.
-- FIX: Add FOR UPDATE lock on field_billing_defaults rows before reading splits.
-- Source: 20260305200000_audit_safety_fixes.sql line 1366
-- Change: Added PERFORM ... FOR UPDATE OF fbd before the billing split block
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

  -- Generate invoice number (field_application type -> INV-YYYY-NNNN)
  PERFORM pg_advisory_xact_lock(hashtext('invoice_number'));
  SELECT 'INV-' || to_char(CURRENT_DATE, 'YYYY') || '-' ||
         lpad((COALESCE(MAX(regexp_replace(invoice_number, '^INV-\d{4}-', '')::integer), 0) + 1)::text, 4, '0')
    INTO v_invoice_number
    FROM invoices
   WHERE invoice_number LIKE 'INV-' || to_char(CURRENT_DATE, 'YYYY') || '-%';

  -- F2 FIX: Removed balance_cents from INSERT column list (it is now GENERATED)
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

  -- FIX #5: Lock field_billing_defaults rows for this job to prevent concurrent corruption
  -- FOR UPDATE OF fbd locks only the billing defaults rows, not job_fields
  PERFORM 1 FROM job_fields jf
    JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
    WHERE jf.job_id = p_job_id
    FOR UPDATE OF fbd;

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

    -- F13 FIX: Use acreage-weighted split_pct instead of simple avg()
    -- For multi-field jobs where fields have different split percentages,
    -- the weighted average correctly accounts for field size differences.
    FOR v_share IN
      SELECT
        fbd.customer_id,
        c.farm_name,
        -- Weighted average: sum(pct * acres) / sum(acres) for this customer
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
    -- F2 FIX: Removed balance_cents = v_share_total (now GENERATED)
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
