-- ═══════════════════════════════════════════════════════════════════════════
-- Season Calendar Change: July 1 – June 30  →  October 1 – September 30
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Season N runs from Oct 1 of year (N-1) through Sep 30 of year N.
-- Season 2026 = Oct 1, 2025 – Sep 30, 2026  (end-year naming preserved).
--
-- Three sections:
--   A. Centralized helper functions (compute_season, season_start_date, season_end_date)
--   B. Data migration — recompute season on all 13 tables
--   C. Rewrite 8 RPCs to use the new helpers
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── SECTION A: Centralized Helper Functions ────────────────────────────

-- compute_season(date) → integer
-- The canonical season computation. All RPCs delegate here.
CREATE OR REPLACE FUNCTION compute_season(p_date date)
RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT CASE WHEN extract(month FROM p_date) >= 10
  THEN extract(year FROM p_date)::integer + 1
  ELSE extract(year FROM p_date)::integer END; $$;

-- season_start_date(season) → date   (Oct 1 of season - 1)
CREATE OR REPLACE FUNCTION season_start_date(p_season integer)
RETURNS date
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT make_date(p_season - 1, 10, 1); $$;

-- season_end_date(season) → date     (Sep 30 of season)
CREATE OR REPLACE FUNCTION season_end_date(p_season integer)
RETURNS date
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT make_date(p_season, 9, 30); $$;

-- current_season() — rewrite the existing DEFAULT function
-- Used as DEFAULT on invoices.season and prepay_credits.season columns.
CREATE OR REPLACE FUNCTION current_season()
RETURNS integer
LANGUAGE sql STABLE
AS $$ SELECT compute_season(CURRENT_DATE); $$;


-- ─── SECTION B: Data Migration — Recompute season on all 13 tables ──────

UPDATE allocation_sets    SET season = compute_season(COALESCE(payment_date, created_at::date))   WHERE season IS NOT NULL;
UPDATE application_records SET season = compute_season(COALESCE(application_date, created_at::date)) WHERE season IS NOT NULL;
UPDATE blend_tickets      SET season = compute_season(COALESCE(ticket_date, created_at::date))    WHERE season IS NOT NULL;
UPDATE commission_payments SET season = compute_season(COALESCE(payment_date, created_at::date))  WHERE season IS NOT NULL;
UPDATE commissions        SET season = compute_season(COALESCE(order_date, created_at::date))     WHERE season IS NOT NULL;
UPDATE deliveries         SET season = compute_season(COALESCE(scheduled_date, created_at::date)) WHERE season IS NOT NULL;
UPDATE invoices           SET season = compute_season(COALESCE(invoice_date, created_at::date))   WHERE season IS NOT NULL;
UPDATE jobs               SET season = compute_season(COALESCE(job_date, created_at::date))       WHERE season IS NOT NULL;
UPDATE orders             SET season = compute_season(COALESCE(order_date, created_at::date))     WHERE season IS NOT NULL;
UPDATE payments           SET season = compute_season(COALESCE(payment_date, created_at::date))   WHERE season IS NOT NULL;
UPDATE prepay_credits     SET season = compute_season(created_at::date)                           WHERE season IS NOT NULL;
UPDATE quotes             SET season = compute_season(created_at::date)                           WHERE season IS NOT NULL;
UPDATE rebate_programs    SET season = compute_season(COALESCE(start_date, created_at::date))     WHERE season IS NOT NULL;


-- ─── SECTION C: Rewrite RPCs to use compute_season() ────────────────────

-- ── C1: allocate_payment ─────────────────────────────────────────────────

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

  -- Determine season (Oct 1 = start of new season)
  v_current_season := compute_season(CURRENT_DATE);

  -- Create allocation set
  INSERT INTO allocation_sets (
    entity_type, entity_id,
    customer_id, total_payment_cents, payment_method,
    reference_number, check_number, payment_date,
    notes, season, created_by
  ) VALUES (
    'payment', p_customer_id,
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

    INSERT INTO invoice_line_allocations (
      allocation_set_id, invoice_id, amount_cents
    ) VALUES (
      v_set_id, v_inv.id, v_alloc_cents
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

  -- Handle overpayment → prepay credit
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


-- ── C2: create_commission_payment ────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_commission_payment(
  p_commission_ids uuid[],
  p_payment_method text,
  p_reference      text,
  p_payment_date   date,
  p_notes          text,
  p_performed_by   uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_payment_id   uuid;
  v_payment_num  text;
  v_total        numeric := 0;
  v_recipient_id uuid;
  v_commission   record;
  v_season       integer;
  v_payment_dt   date;
BEGIN
  v_payment_dt := COALESCE(p_payment_date, CURRENT_DATE);

  -- Enforce accounting period
  PERFORM public.check_period_open(v_payment_dt);

  -- Validate at least one commission
  IF array_length(p_commission_ids, 1) IS NULL OR array_length(p_commission_ids, 1) = 0 THEN
    RAISE EXCEPTION 'No commissions selected for payment';
  END IF;

  -- Lock commissions FOR UPDATE to prevent double-pay
  SELECT DISTINCT c.recipient_user_id
    INTO v_recipient_id
    FROM public.commissions c
   WHERE c.id = ANY(p_commission_ids)
     AND c.status != 'paid'
     FOR UPDATE;

  IF v_recipient_id IS NULL THEN
    RAISE EXCEPTION 'No unpaid commissions found for the given IDs';
  END IF;

  IF (SELECT count(DISTINCT c.recipient_user_id)
      FROM public.commissions c
      WHERE c.id = ANY(p_commission_ids) AND c.status != 'paid') > 1 THEN
    RAISE EXCEPTION 'All commissions in a payment must belong to the same recipient';
  END IF;

  -- Calculate total
  SELECT sum(c.commission_amount)
    INTO v_total
    FROM public.commissions c
   WHERE c.id = ANY(p_commission_ids)
     AND c.status != 'paid';

  -- Season uses end-year convention
  -- Oct 2025 → season 2026 (the 2025-2026 season ending Sep 2026)
  v_season := compute_season(v_payment_dt);

  -- Generate payment number
  v_payment_num := public.next_commission_payment_number();

  -- Create the payment
  INSERT INTO public.commission_payments (
    payment_number, recipient_id, total_amount, status,
    payment_method, reference_number, payment_date, notes, season, created_by
  ) VALUES (
    v_payment_num, v_recipient_id, v_total, 'unposted',
    p_payment_method, p_reference, v_payment_dt,
    p_notes, v_season, p_performed_by
  ) RETURNING id INTO v_payment_id;

  -- Create line items
  FOR v_commission IN
    SELECT c.id, c.commission_amount
      FROM public.commissions c
     WHERE c.id = ANY(p_commission_ids)
       AND c.status != 'paid'
  LOOP
    INSERT INTO public.commission_payment_items (
      commission_payment_id, commission_id, amount
    ) VALUES (
      v_payment_id, v_commission.id, v_commission.commission_amount
    );
  END LOOP;

  -- Mark commissions as paid
  UPDATE public.commissions
     SET status = 'paid', updated_at = now()
   WHERE id = ANY(p_commission_ids)
     AND status != 'paid';

  -- Financial audit log
  INSERT INTO public.financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, total_impact_cents, description
  ) VALUES (
    'commission_payment_created', 'commission_payment', v_payment_id,
    p_performed_by, (v_total * 100)::bigint,
    'Commission payment ' || v_payment_num || ' created for $' ||
    to_char(v_total, 'FM999,999,990.00') || ' to ' ||
    (SELECT full_name FROM public.profiles WHERE id = v_recipient_id)
  );

  RETURN v_payment_id;
END;
$$;


-- ── C3: generate_finance_charges ─────────────────────────────────────────

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
  -- Enforce accounting period
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
        compute_season(p_as_of_date),
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


-- ── C4: get_receiving_summary ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_receiving_summary()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
  v_today date := current_date;
  v_week_start date := date_trunc('week', current_date)::date;
  v_year_start date := season_start_date(compute_season(current_date));
BEGIN
  -- Verify caller is admin or sales_rep
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = (select auth.uid()) AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT jsonb_build_object(
    'expected_today', (
      SELECT count(*) FROM purchase_orders
      WHERE status IN ('submitted', 'partially_received')
        AND expected_delivery_date = v_today
    ),
    'pending_receipt', (
      SELECT count(*) FROM purchase_orders
      WHERE status IN ('submitted', 'partially_received')
    ),
    'received_this_week', (
      SELECT count(DISTINCT rr.id) FROM receiving_records rr
      WHERE rr.received_at::date >= v_week_start
    ),
    'items_received_ytd', (
      SELECT COALESCE(sum(rr.quantity_received), 0) FROM receiving_records rr
      WHERE rr.received_at::date >= v_year_start
    ),
    'damaged_this_week', (
      SELECT count(*) FROM receiving_records rr
      WHERE rr.received_at::date >= v_week_start
        AND rr.condition <> 'good'
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;


-- ── C5: transfer_job_to_invoice ──────────────────────────────────────────
-- Only the season-related INSERT line changes. Full function rewritten
-- to use compute_season(CURRENT_DATE) instead of inline CASE.

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
    compute_season(CURRENT_DATE),
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

    -- F13 FIX: Use acreage-weighted split_pct instead of simple avg()
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


-- ── C6: get_customer_year_end_summary ────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_customer_year_end_summary(
  p_customer_id uuid,
  p_season      integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cust            record;
  v_season_start    date;
  v_season_end      date;
  v_financial       jsonb;
  v_product_usage   jsonb;
  v_acreage         jsonb;
  v_invoices        jsonb;
  v_shares          jsonb;
  v_prior_season    jsonb;
BEGIN
  -- ── Customer info ──
  SELECT * INTO v_cust FROM customers WHERE id = p_customer_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer not found: %', p_customer_id;
  END IF;

  -- Season dates: Oct 1 (season-1) through Sep 30 (season)
  v_season_start := season_start_date(p_season);
  v_season_end   := season_end_date(p_season);

  -- ── Financial summary ──
  SELECT jsonb_build_object(
    'total_invoiced_cents', COALESCE(SUM(total_amount_cents), 0),
    'total_paid_cents', COALESCE(SUM(paid_amount_cents), 0),
    'prepay_applied_cents', COALESCE(SUM(prepay_applied_cents), 0),
    'outstanding_balance_cents', COALESCE(SUM(balance_cents), 0),
    'invoice_count', COUNT(*)
  )
  INTO v_financial
  FROM invoices
  WHERE customer_id = p_customer_id
    AND season = p_season
    AND status IN ('posted', 'voided')
    AND deleted_at IS NULL;

  -- ── Product usage by category ──
  SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb ORDER BY t.category, t.product_name), '[]'::jsonb)
  INTO v_product_usage
  FROM (
    SELECT
      COALESCE(p.category, 'Uncategorized') AS category,
      COALESCE(p.product_name, ii.description) AS product_name,
      p.epa_registration,
      SUM(ii.quantity) AS total_quantity,
      MAX(ii.unit_size) AS unit_size,
      CASE WHEN SUM(COALESCE(ii.acres, 0)) > 0
        THEN ROUND(AVG(ii.rate_per_acre)::numeric, 2)
        ELSE NULL
      END AS avg_rate_per_acre,
      MAX(ii.rate_unit) AS rate_unit,
      SUM(COALESCE(ii.acres, 0)) AS total_acres_treated,
      SUM(ii.extended_cents) AS total_cost_cents,
      SUM(COALESCE(ii.total_applied, 0)) AS total_applied,
      MAX(ii.total_applied_unit) AS total_applied_unit,
      SUM(COALESCE(ii.total_applied_gl_lb, 0)) AS total_applied_gl_lb,
      MAX(ii.gl_lb_unit) AS gl_lb_unit,
      ii.is_application_fee
    FROM invoice_items ii
    JOIN invoices i ON i.id = ii.invoice_id
    LEFT JOIN products p ON p.id = ii.product_id
    WHERE i.customer_id = p_customer_id
      AND i.season = p_season
      AND i.status = 'posted'
      AND i.deleted_at IS NULL
    GROUP BY COALESCE(p.category, 'Uncategorized'),
             COALESCE(p.product_name, ii.description),
             p.epa_registration,
             ii.is_application_fee
  ) t;

  -- ── Acreage summary ──
  SELECT jsonb_build_object(
    'total_acres', COALESCE(SUM(i.total_acres), 0),
    'by_crop', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'crop_type', sub.crop_type,
        'acres', sub.total_acres
      ) ORDER BY sub.total_acres DESC)
      FROM (
        SELECT COALESCE(crop_type, 'Unknown') AS crop_type,
               SUM(total_acres) AS total_acres
        FROM invoices
        WHERE customer_id = p_customer_id
          AND season = p_season
          AND invoice_type = 'field_application'
          AND status = 'posted'
          AND deleted_at IS NULL
          AND total_acres IS NOT NULL
        GROUP BY COALESCE(crop_type, 'Unknown')
      ) sub
    ), '[]'::jsonb)
  )
  INTO v_acreage
  FROM invoices i
  WHERE i.customer_id = p_customer_id
    AND i.season = p_season
    AND i.invoice_type = 'field_application'
    AND i.status = 'posted'
    AND i.deleted_at IS NULL;

  -- ── Invoice history ──
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'invoice_number', i.invoice_number,
    'invoice_date', i.invoice_date,
    'invoice_type', i.invoice_type,
    'field_names', i.field_names,
    'total_acres', i.total_acres,
    'crop_type', i.crop_type,
    'total_amount_cents', i.total_amount_cents,
    'balance_cents', i.balance_cents,
    'status', i.status
  ) ORDER BY i.invoice_date, i.created_at), '[]'::jsonb)
  INTO v_invoices
  FROM invoices i
  WHERE i.customer_id = p_customer_id
    AND i.season = p_season
    AND i.status IN ('posted', 'voided')
    AND i.deleted_at IS NULL;

  -- ── Grower shares ──
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'invoice_number', i.invoice_number,
    'field_names', i.field_names,
    'share_customer_name', s.customer_name,
    'split_percentage', s.split_percentage,
    'acres', s.acres,
    'amount_cents', s.amount_cents,
    'price_per_acre_cents', s.price_per_acre_cents,
    'pricing_note', s.pricing_note
  ) ORDER BY i.invoice_date, s.sort_order), '[]'::jsonb)
  INTO v_shares
  FROM invoice_shares s
  JOIN invoices i ON i.id = s.invoice_id
  WHERE i.customer_id = p_customer_id
    AND i.season = p_season
    AND i.status = 'posted'
    AND i.deleted_at IS NULL;

  -- ── Prior season comparison ──
  SELECT CASE
    WHEN COUNT(*) > 0 THEN
      jsonb_build_object(
        'total_invoiced_cents', COALESCE(SUM(total_amount_cents), 0),
        'total_paid_cents', COALESCE(SUM(paid_amount_cents), 0),
        'invoice_count', COUNT(*),
        'total_acres', COALESCE((
          SELECT SUM(total_acres)
          FROM invoices
          WHERE customer_id = p_customer_id
            AND season = p_season - 1
            AND invoice_type = 'field_application'
            AND status IN ('posted', 'voided')
            AND deleted_at IS NULL
        ), 0)
      )
    ELSE NULL
  END
  INTO v_prior_season
  FROM invoices
  WHERE customer_id = p_customer_id
    AND season = p_season - 1
    AND status IN ('posted', 'voided')
    AND deleted_at IS NULL;

  -- ── Build and return ──
  RETURN jsonb_build_object(
    'customer', jsonb_build_object(
      'id', v_cust.id,
      'farm_name', v_cust.farm_name,
      'contact_name', v_cust.contact_name,
      'account_number', v_cust.account_number,
      'email', v_cust.email,
      'phone', v_cust.phone,
      'billing_address', v_cust.billing_address,
      'city', v_cust.city,
      'state', v_cust.state,
      'zip', v_cust.zip,
      'assigned_tier', v_cust.assigned_tier,
      'payment_terms', v_cust.payment_terms
    ),
    'season', p_season,
    'season_start', v_season_start,
    'season_end', v_season_end,
    'financial', v_financial,
    'product_usage', v_product_usage,
    'acreage', v_acreage,
    'invoices', v_invoices,
    'shares', v_shares,
    'prior_season', v_prior_season
  );
END;
$$;


-- ── C7: get_season_comparison ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_season_comparison(
  p_season_a integer,
  p_season_b integer
)
RETURNS TABLE (
  metric        text,
  season_a_val  numeric,
  season_b_val  numeric,
  change_pct    numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE
  v_a_start date;
  v_a_end date;
  v_b_start date;
  v_b_end date;
  v_a_revenue numeric;
  v_b_revenue numeric;
  v_a_profit numeric;
  v_b_profit numeric;
  v_a_orders int;
  v_b_orders int;
  v_a_customers int;
  v_b_customers int;
BEGIN
  -- Season = Oct 1 of (year-1) to Sep 30 of year
  v_a_start := season_start_date(p_season_a);
  v_a_end   := season_end_date(p_season_a);
  v_b_start := season_start_date(p_season_b);
  v_b_end   := season_end_date(p_season_b);

  -- Season A
  SELECT COALESCE(SUM(total_price), 0), COALESCE(SUM(total_profit), 0), COUNT(*), COUNT(DISTINCT customer_id)
  INTO v_a_revenue, v_a_profit, v_a_orders, v_a_customers
  FROM orders
  WHERE order_date BETWEEN v_a_start AND v_a_end
    AND status <> 'cancelled';

  -- Season B
  SELECT COALESCE(SUM(total_price), 0), COALESCE(SUM(total_profit), 0), COUNT(*), COUNT(DISTINCT customer_id)
  INTO v_b_revenue, v_b_profit, v_b_orders, v_b_customers
  FROM orders
  WHERE order_date BETWEEN v_b_start AND v_b_end
    AND status <> 'cancelled';

  RETURN QUERY VALUES
    ('Revenue'::text, v_a_revenue, v_b_revenue,
      CASE WHEN v_b_revenue > 0 THEN ROUND((v_a_revenue - v_b_revenue) / v_b_revenue * 100, 1) ELSE NULL END),
    ('Profit'::text, v_a_profit, v_b_profit,
      CASE WHEN v_b_profit > 0 THEN ROUND((v_a_profit - v_b_profit) / v_b_profit * 100, 1) ELSE NULL END),
    ('Orders'::text, v_a_orders::numeric, v_b_orders::numeric,
      CASE WHEN v_b_orders > 0 THEN ROUND((v_a_orders - v_b_orders)::numeric / v_b_orders * 100, 1) ELSE NULL END),
    ('Active Customers'::text, v_a_customers::numeric, v_b_customers::numeric,
      CASE WHEN v_b_customers > 0 THEN ROUND((v_a_customers - v_b_customers)::numeric / v_b_customers * 100, 1) ELSE NULL END);
END;
$$;
