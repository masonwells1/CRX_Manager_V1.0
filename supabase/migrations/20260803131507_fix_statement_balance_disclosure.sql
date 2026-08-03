-- Section 2 statement consistency fixes.
--
-- 1. Include overdue-only customers in generate_batch_statements.
-- 2. Keep linked finance-charge metadata informational: the misc_charge
--    invoice balance already contains that charge, so net_due_cents must not
--    add it a second time.
-- 3. Preserve the settled gross-AR convention while disclosing unapplied
--    credit memos and the resulting net account position.
--
-- LOCAL ONLY until the governed migration-review/apply path completes.

DO $preflight$
DECLARE
  v_batch_oid oid := to_regprocedure('public.generate_batch_statements(date,uuid,text,text)');
  v_detail_oid oid := to_regprocedure('public.get_detailed_statement_data(uuid,date,text)');
BEGIN
  IF v_batch_oid IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: generate_batch_statements(date,uuid,text,text) is missing';
  END IF;
  IF v_detail_oid IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: get_detailed_statement_data(uuid,date,text) is missing';
  END IF;

  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'generate_batch_statements') <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: unexpected generate_batch_statements overload count';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'get_detailed_statement_data') <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: unexpected get_detailed_statement_data overload count';
  END IF;

  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = v_batch_oid)
       <> 'bd7544b6df565a7f24c909f6c45bdd94' THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: generate_batch_statements drifted from reviewed live source';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = v_detail_oid)
       <> 'fbb023d78bc3ba89732eda9081c0d72f' THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: get_detailed_statement_data drifted from reviewed live source';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.invoices
    WHERE status IN ('posted', 'paid', 'overdue', 'voided')
      AND posted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: financial-status invoice is missing posted_at';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.invoices'::regclass
      AND conname = 'invoices_financial_status_requires_posted_at'
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: invoices_financial_status_requires_posted_at already exists';
  END IF;
  IF to_regprocedure('public.statement_invoice_was_posted_as_of(uuid,timestamp with time zone,date)') IS NOT NULL
     OR EXISTS (
       SELECT 1
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = 'statement_invoice_was_posted_as_of'
     ) THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: statement_invoice_was_posted_as_of already exists';
  END IF;
END;
$preflight$;

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_financial_status_requires_posted_at
  CHECK (status NOT IN ('posted', 'paid', 'overdue', 'voided') OR posted_at IS NOT NULL)
  NOT VALID;

ALTER TABLE public.invoices
  VALIDATE CONSTRAINT invoices_financial_status_requires_posted_at;

-- Reconstruct whether an invoice was posted at the end of a CRX business day.
-- Re-posting overwrites invoices.posted_at, while unposting clears it, so the
-- current header alone is not historical evidence. The append-only financial
-- audit ledger supplies each posting interval. A narrow fallback covers legacy
-- rows whose original post event predates complete audit coverage; a later
-- unpost preserves that original posted_at in old_values.
CREATE FUNCTION public.statement_invoice_was_posted_as_of(
  p_invoice_id uuid,
  p_current_posted_at timestamptz,
  p_as_of_date date
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_latest_at timestamptz;
  v_latest_operation text;
BEGIN
  SELECT max(fal.created_at)
  INTO v_latest_at
  FROM public.financial_audit_log fal
  WHERE fal.entity_type = 'invoice'
    AND fal.entity_id = p_invoice_id
    AND fal.operation_type IN ('invoice_posted', 'invoice_unposted')
    AND (fal.created_at AT TIME ZONE 'America/Chicago')::date <= p_as_of_date;

  IF v_latest_at IS NOT NULL THEN
    IF (
      SELECT count(DISTINCT fal.operation_type)
      FROM public.financial_audit_log fal
      WHERE fal.entity_type = 'invoice'
        AND fal.entity_id = p_invoice_id
        AND fal.operation_type IN ('invoice_posted', 'invoice_unposted')
        AND fal.created_at = v_latest_at
    ) > 1 THEN
      RAISE EXCEPTION 'HISTORICAL_POSTING_RECONSTRUCTION_UNAVAILABLE: posting lifecycle events share the same audit timestamp';
    END IF;

    SELECT fal.operation_type
    INTO v_latest_operation
    FROM public.financial_audit_log fal
    WHERE fal.entity_type = 'invoice'
      AND fal.entity_id = p_invoice_id
      AND fal.operation_type IN ('invoice_posted', 'invoice_unposted')
      AND fal.created_at = v_latest_at
    LIMIT 1;

    RETURN v_latest_operation = 'invoice_posted';
  END IF;

  RETURN COALESCE(
    (p_current_posted_at AT TIME ZONE 'America/Chicago')::date <= p_as_of_date,
    false
  ) OR EXISTS (
    SELECT 1
    FROM public.financial_audit_log fal
    WHERE fal.entity_type = 'invoice'
      AND fal.entity_id = p_invoice_id
      AND fal.operation_type = 'invoice_unposted'
      AND (fal.created_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
      AND fal.old_values->>'posted_at' IS NOT NULL
      AND (((fal.old_values->>'posted_at')::timestamptz) AT TIME ZONE 'America/Chicago')::date <= p_as_of_date
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.statement_invoice_was_posted_as_of(uuid, timestamptz, date)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_detailed_statement_data(
  p_customer_id uuid,
  p_as_of_date date,
  p_mode text DEFAULT 'summary'::text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_customer RECORD;
  v_aging jsonb;
  v_balance bigint := 0;
  v_open_credit_cents bigint := 0;
  v_inv RECORD;
  v_items jsonb;
  v_shares jsonb;
  v_finance_cents bigint;
  v_txn_list jsonb := '[]'::jsonb;
  v_days_aged integer;
  v_description text;
  v_grower_names text[];
BEGIN
  PERFORM require_admin();
  SELECT * INTO v_customer FROM customers WHERE id = p_customer_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer not found: %', p_customer_id;
  END IF;

  -- Generic void_invoice deliberately zeroes the mutable money columns. Its
  -- audit snapshot is not a complete event ledger for every possible change
  -- between the cutoff and the void, so emitting a guessed historical balance
  -- would be unsafe. Credit-memo unapply is different: it preserves the memo's
  -- face amount and reverses applications in the immutable application ledger.
  IF EXISTS (
    SELECT 1
    FROM invoices i
    WHERE i.customer_id = p_customer_id
      AND public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date)
      AND i.invoice_date <= p_as_of_date
      AND (i.voided_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
      AND EXISTS (
        SELECT 1
        FROM financial_audit_log fal
        WHERE fal.entity_type = 'invoice'
          AND fal.entity_id = i.id
          AND fal.operation_type = 'invoice_voided'
      )
  ) THEN
    RAISE EXCEPTION 'HISTORICAL_VOID_RECONSTRUCTION_UNAVAILABLE: a later generic invoice void prevents a trustworthy statement at this cutoff';
  END IF;

  -- An invoice unposted after the cutoff becomes editable again.  The audit
  -- ledger records its posting interval but not every subsequent header or
  -- line-item edit, so today's mutable row cannot prove its former contents.
  IF EXISTS (
    SELECT 1
    FROM invoices i
    WHERE i.customer_id = p_customer_id
      AND public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date)
      AND i.invoice_date <= p_as_of_date
      AND EXISTS (
        SELECT 1
        FROM financial_audit_log fal
        WHERE fal.entity_type = 'invoice'
          AND fal.entity_id = i.id
          AND fal.operation_type = 'invoice_unposted'
          AND (fal.created_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
      )
  ) THEN
    RAISE EXCEPTION 'HISTORICAL_UNPOST_RECONSTRUCTION_UNAVAILABLE: a later invoice unpost prevents a trustworthy statement at this cutoff';
  END IF;

  -- The generated balance contains today's credit_applied_cents. Replace that
  -- one lever with applications active at the cutoff so a later application or
  -- reversal changes neither side of a regenerated historical statement.
  FOR v_inv IN
    SELECT i.*,
      (
        i.balance_cents
        + i.credit_applied_cents
        - credit_at_cutoff.applied_cents
      )::bigint AS statement_balance_cents
    FROM invoices i
    CROSS JOIN LATERAL (
      SELECT COALESCE(SUM(cma.amount_cents), 0)::bigint AS applied_cents
      FROM credit_memo_applications cma
      WHERE cma.target_invoice_id = i.id
        AND (cma.applied_at AT TIME ZONE 'America/Chicago')::date <= p_as_of_date
        AND (cma.reversed_at IS NULL OR (cma.reversed_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
    ) credit_at_cutoff
    WHERE i.customer_id = p_customer_id
      AND i.invoice_type <> 'credit_memo'
      AND public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date)
      AND (i.voided_at IS NULL OR (i.voided_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
      AND (i.deleted_at IS NULL OR (i.deleted_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
      AND i.invoice_date <= p_as_of_date
      AND (
        i.balance_cents
        + i.credit_applied_cents
        - credit_at_cutoff.applied_cents
      ) > 0
    ORDER BY i.invoice_date, i.invoice_number
  LOOP
    v_balance := v_balance + v_inv.statement_balance_cents;
    v_days_aged := p_as_of_date - v_inv.invoice_date;

    IF v_inv.invoice_type = 'field_application' AND v_inv.crop_type IS NOT NULL THEN
      v_description := COALESCE(v_inv.crop_type, '')
        || ' - ' || COALESCE(v_inv.total_acres::text, '')
        || ' - ' || COALESCE(array_to_string(v_inv.field_names, ', '), '');
    ELSIF v_inv.invoice_type = 'chemical_sale' THEN
      v_description := 'Chemical Sale: ' || COALESCE(v_inv.header_notes, '');
    ELSE
      v_description := COALESCE(v_inv.header_notes, v_inv.invoice_type);
    END IF;

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

    SELECT array_agg(s.customer_name ORDER BY s.sort_order)
    INTO v_grower_names
    FROM invoice_shares s
    WHERE s.invoice_id = v_inv.id;

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

    SELECT COALESCE(sum(fc.amount_cents), 0)
    INTO v_finance_cents
    FROM finance_charges fc
    WHERE fc.invoice_id = v_inv.id;

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
      'balance_cents', v_inv.statement_balance_cents,
      'items', v_items,
      'shares', v_shares,
      'finance_charge_cents', v_finance_cents,
      'net_due_cents', v_inv.statement_balance_cents,
      'price_per_acre', CASE
        WHEN v_inv.total_acres > 0 THEN
          round(v_inv.total_amount_cents / 100.0 / v_inv.total_acres, 2)
        ELSE NULL
      END
    );
  END LOOP;

  WITH statement_invoices AS (
    SELECT i.*,
      (
        i.balance_cents
        + i.credit_applied_cents
        - credit_at_cutoff.applied_cents
      )::bigint AS statement_balance_cents
    FROM invoices i
    CROSS JOIN LATERAL (
      SELECT COALESCE(SUM(cma.amount_cents), 0)::bigint AS applied_cents
      FROM credit_memo_applications cma
      WHERE cma.target_invoice_id = i.id
        AND (cma.applied_at AT TIME ZONE 'America/Chicago')::date <= p_as_of_date
        AND (cma.reversed_at IS NULL OR (cma.reversed_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
    ) credit_at_cutoff
    WHERE i.customer_id = p_customer_id
      AND i.invoice_type <> 'credit_memo'
      AND public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date)
      AND (i.voided_at IS NULL OR (i.voided_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
      AND (i.deleted_at IS NULL OR (i.deleted_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
      AND i.invoice_date <= p_as_of_date
  )
  SELECT jsonb_build_object(
    'current_cents', COALESCE(sum(CASE WHEN p_as_of_date - COALESCE(i.due_date, i.invoice_date) <= 30 THEN i.statement_balance_cents ELSE 0 END), 0),
    'days_30_cents', COALESCE(sum(CASE WHEN p_as_of_date - COALESCE(i.due_date, i.invoice_date) BETWEEN 31 AND 60 THEN i.statement_balance_cents ELSE 0 END), 0),
    'days_60_cents', COALESCE(sum(CASE WHEN p_as_of_date - COALESCE(i.due_date, i.invoice_date) BETWEEN 61 AND 90 THEN i.statement_balance_cents ELSE 0 END), 0),
    'days_90_cents', COALESCE(sum(CASE WHEN p_as_of_date - COALESCE(i.due_date, i.invoice_date) BETWEEN 91 AND 120 THEN i.statement_balance_cents ELSE 0 END), 0),
    'over_120_cents', COALESCE(sum(CASE WHEN p_as_of_date - COALESCE(i.due_date, i.invoice_date) > 120 THEN i.statement_balance_cents ELSE 0 END), 0)
  )
  INTO v_aging
  FROM statement_invoices i
  WHERE i.statement_balance_cents > 0;

  -- `balance_cents` is the memo's *current* generated balance.  A statement
  -- regenerated for an earlier date must instead replay the immutable credit
  -- application ledger as it stood on that date: applications made later do
  -- not reduce the historical credit, while an application reversed later was
  -- still consuming credit at the cutoff.
  SELECT COALESCE(SUM(
    GREATEST(-ci.total_amount_cents - COALESCE((
      SELECT SUM(cma.amount_cents)
      FROM credit_memo_applications cma
      WHERE cma.credit_memo_id = ci.id
        AND (cma.applied_at AT TIME ZONE 'America/Chicago')::date <= p_as_of_date
        AND (cma.reversed_at IS NULL OR (cma.reversed_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
    ), 0), 0::bigint)
  ), 0)::bigint
  INTO v_open_credit_cents
  FROM invoices ci
  WHERE ci.customer_id = p_customer_id
    AND ci.invoice_type = 'credit_memo'
    AND public.statement_invoice_was_posted_as_of(ci.id, ci.posted_at, p_as_of_date)
    AND (ci.voided_at IS NULL OR (ci.voided_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
    AND (ci.deleted_at IS NULL OR (ci.deleted_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
    AND ci.invoice_date <= p_as_of_date;

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
    'open_credit_cents', v_open_credit_cents,
    'net_account_position_cents', v_balance - v_open_credit_cents,
    'as_of_date', p_as_of_date,
    'mode', p_mode
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.generate_batch_statements(
  p_as_of_date date,
  p_performed_by uuid,
  p_mode text DEFAULT 'summary'::text,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_customers jsonb := '[]'::jsonb;
  v_cust RECORD;
  v_stmt jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  -- Authorize before the selector so an authenticated non-admin cannot use an
  -- empty/non-empty response to infer whether qualifying receivables exist.
  PERFORM public.require_admin();

  -- Fail the whole batch instead of silently omitting a customer whose later
  -- generic void destroyed the mutable amount columns.
  IF EXISTS (
    SELECT 1
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    WHERE c.is_active = true
      AND public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date)
      AND i.invoice_date <= p_as_of_date
      AND (i.voided_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
      AND EXISTS (
        SELECT 1
        FROM financial_audit_log fal
        WHERE fal.entity_type = 'invoice'
          AND fal.entity_id = i.id
          AND fal.operation_type = 'invoice_voided'
      )
  ) THEN
    RAISE EXCEPTION 'HISTORICAL_VOID_RECONSTRUCTION_UNAVAILABLE: a later generic invoice void prevents a trustworthy statement batch at this cutoff';
  END IF;

  -- Keep batch generation consistent with detail generation: a later unpost
  -- reopens an invoice for edits that the posting audit cannot reconstruct.
  IF EXISTS (
    SELECT 1
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    WHERE c.is_active = true
      AND public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date)
      AND i.invoice_date <= p_as_of_date
      AND EXISTS (
        SELECT 1
        FROM financial_audit_log fal
        WHERE fal.entity_type = 'invoice'
          AND fal.entity_id = i.id
          AND fal.operation_type = 'invoice_unposted'
          AND (fal.created_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
      )
  ) THEN
    RAISE EXCEPTION 'HISTORICAL_UNPOST_RECONSTRUCTION_UNAVAILABLE: a later invoice unpost prevents a trustworthy statement batch at this cutoff';
  END IF;

  FOR v_cust IN
    SELECT c.id, c.farm_name
    FROM customers c
    WHERE c.is_active = true
      AND EXISTS (
        SELECT 1
        FROM invoices i
        CROSS JOIN LATERAL (
          SELECT COALESCE(SUM(cma.amount_cents), 0)::bigint AS applied_cents
          FROM credit_memo_applications cma
          WHERE cma.target_invoice_id = i.id
            AND (cma.applied_at AT TIME ZONE 'America/Chicago')::date <= p_as_of_date
            AND (cma.reversed_at IS NULL OR (cma.reversed_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
        ) credit_at_cutoff
        WHERE i.customer_id = c.id
          AND i.invoice_type <> 'credit_memo'
          AND public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date)
          AND (i.voided_at IS NULL OR (i.voided_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
          AND (i.deleted_at IS NULL OR (i.deleted_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
          AND i.invoice_date <= p_as_of_date
          AND (
            i.balance_cents
            + i.credit_applied_cents
            - credit_at_cutoff.applied_cents
          ) > 0
      )
    ORDER BY c.farm_name
  LOOP
    v_stmt := get_detailed_statement_data(v_cust.id, p_as_of_date, p_mode);
    v_customers := v_customers || v_stmt;
  END LOOP;

  RETURN v_customers;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_detailed_statement_data(uuid, date, text)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.generate_batch_statements(date, uuid, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_detailed_statement_data(uuid, date, text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.generate_batch_statements(date, uuid, text, text)
  TO authenticated, service_role;

DO $postflight$
DECLARE
  v_batch_def text := (
    SELECT prosrc
    FROM pg_proc
    WHERE oid = to_regprocedure('public.generate_batch_statements(date,uuid,text,text)')
  );
  v_detail_def text := (
    SELECT prosrc
    FROM pg_proc
    WHERE oid = to_regprocedure('public.get_detailed_statement_data(uuid,date,text)')
  );
  v_posted_at_constraint_validated boolean := (
    SELECT convalidated
    FROM pg_constraint
    WHERE conrelid = 'public.invoices'::regclass
      AND conname = 'invoices_financial_status_requires_posted_at'
  );
  v_posted_as_of_oid oid := to_regprocedure(
    'public.statement_invoice_was_posted_as_of(uuid,timestamp with time zone,date)'
  );
  v_posted_as_of_def text := (
    SELECT prosrc
    FROM pg_proc
    WHERE oid = to_regprocedure(
      'public.statement_invoice_was_posted_as_of(uuid,timestamp with time zone,date)'
    )
  );
BEGIN
  IF v_batch_def NOT LIKE '%public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date)%'
     OR v_batch_def NOT LIKE '%i.voided_at IS NULL OR (i.voided_at AT TIME ZONE ''America/Chicago'')::date > p_as_of_date%'
     OR v_batch_def NOT LIKE '%i.deleted_at IS NULL OR (i.deleted_at AT TIME ZONE ''America/Chicago'')::date > p_as_of_date%'
     OR v_batch_def NOT LIKE '%i.balance_cents%+ i.credit_applied_cents%- credit_at_cutoff.applied_cents%'
     OR v_batch_def NOT LIKE '%cma.target_invoice_id = i.id%'
     OR v_batch_def NOT LIKE '%(cma.applied_at AT TIME ZONE ''America/Chicago'')::date <= p_as_of_date%'
     OR v_batch_def NOT LIKE '%cma.reversed_at IS NULL OR (cma.reversed_at AT TIME ZONE ''America/Chicago'')::date > p_as_of_date%' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: historical-credit-aware batch selector is missing';
  END IF;
  IF v_batch_def NOT LIKE '%p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor%'
     OR v_batch_def NOT LIKE '%RAISE EXCEPTION ''ACTOR_MISMATCH''%' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: batch actor binding is missing';
  END IF;
  IF v_batch_def NOT LIKE '%PERFORM public.require_admin();%' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: batch admin authorization is missing';
  END IF;
  IF v_batch_def NOT LIKE '%HISTORICAL_VOID_RECONSTRUCTION_UNAVAILABLE%'
     OR v_batch_def NOT LIKE '%fal.operation_type = ''invoice_voided''%'
     OR v_batch_def NOT LIKE '%HISTORICAL_UNPOST_RECONSTRUCTION_UNAVAILABLE%'
     OR v_batch_def NOT LIKE '%fal.operation_type = ''invoice_unposted''%' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: batch historical-reconstruction fail-closed guards are missing';
  END IF;
  IF v_batch_def LIKE '%posted_at::date%'
     OR v_batch_def LIKE '%voided_at::date%'
     OR v_batch_def LIKE '%deleted_at::date%'
     OR v_batch_def LIKE '%applied_at::date%'
     OR v_batch_def LIKE '%reversed_at::date%' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: batch contains a session-timezone date cast';
  END IF;
  IF v_detail_def LIKE '%v_inv.balance_cents + v_finance_cents%' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: finance charge is still double-counted';
  END IF;
  IF v_detail_def NOT LIKE '%''net_due_cents'', v_inv.statement_balance_cents%' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: net_due_cents is not the as-of invoice balance';
  END IF;
  IF v_detail_def NOT LIKE '%public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date)%'
     OR v_detail_def NOT LIKE '%i.voided_at IS NULL OR (i.voided_at AT TIME ZONE ''America/Chicago'')::date > p_as_of_date%'
     OR v_detail_def NOT LIKE '%i.deleted_at IS NULL OR (i.deleted_at AT TIME ZONE ''America/Chicago'')::date > p_as_of_date%'
     OR v_detail_def NOT LIKE '%i.balance_cents%+ i.credit_applied_cents%- credit_at_cutoff.applied_cents%'
     OR v_detail_def NOT LIKE '%cma.target_invoice_id = i.id%'
     OR v_detail_def NOT LIKE '%(cma.applied_at AT TIME ZONE ''America/Chicago'')::date <= p_as_of_date%'
     OR v_detail_def NOT LIKE '%cma.reversed_at IS NULL OR (cma.reversed_at AT TIME ZONE ''America/Chicago'')::date > p_as_of_date%' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: historical target-invoice credit replay is missing';
  END IF;
  IF v_detail_def NOT LIKE '%GREATEST(-ci.total_amount_cents - COALESCE(%'
     OR v_detail_def NOT LIKE '%public.statement_invoice_was_posted_as_of(ci.id, ci.posted_at, p_as_of_date)%'
     OR v_detail_def NOT LIKE '%ci.voided_at IS NULL OR (ci.voided_at AT TIME ZONE ''America/Chicago'')::date > p_as_of_date%'
     OR v_detail_def NOT LIKE '%ci.deleted_at IS NULL OR (ci.deleted_at AT TIME ZONE ''America/Chicago'')::date > p_as_of_date%'
     OR v_detail_def NOT LIKE '%cma.credit_memo_id = ci.id%'
     OR v_detail_def NOT LIKE '%(cma.applied_at AT TIME ZONE ''America/Chicago'')::date <= p_as_of_date%'
     OR v_detail_def NOT LIKE '%cma.reversed_at IS NULL OR (cma.reversed_at AT TIME ZONE ''America/Chicago'')::date > p_as_of_date%' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: historical open-credit replay is missing';
  END IF;
  IF v_detail_def NOT LIKE '%''open_credit_cents'', v_open_credit_cents%'
     OR v_detail_def NOT LIKE '%''net_account_position_cents'', v_balance - v_open_credit_cents%' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: account-position disclosure fields are missing';
  END IF;
  IF v_detail_def NOT LIKE '%HISTORICAL_VOID_RECONSTRUCTION_UNAVAILABLE%'
     OR v_detail_def NOT LIKE '%fal.operation_type = ''invoice_voided''%'
     OR v_detail_def NOT LIKE '%HISTORICAL_UNPOST_RECONSTRUCTION_UNAVAILABLE%'
     OR v_detail_def NOT LIKE '%fal.operation_type = ''invoice_unposted''%' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: detail historical-reconstruction fail-closed guards are missing';
  END IF;
  IF v_detail_def LIKE '%posted_at::date%'
     OR v_detail_def LIKE '%voided_at::date%'
     OR v_detail_def LIKE '%deleted_at::date%'
     OR v_detail_def LIKE '%applied_at::date%'
     OR v_detail_def LIKE '%reversed_at::date%' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: detail contains a session-timezone date cast';
  END IF;
  IF v_posted_at_constraint_validated IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: financial-status posted_at constraint is missing or unvalidated';
  END IF;
  IF v_posted_as_of_oid IS NULL
     OR v_posted_as_of_def NOT LIKE '%fal.operation_type IN (''invoice_posted'', ''invoice_unposted'')%'
     OR v_posted_as_of_def NOT LIKE '%(fal.created_at AT TIME ZONE ''America/Chicago'')::date <= p_as_of_date%'
     OR v_posted_as_of_def NOT LIKE '%fal.old_values->>''posted_at''%'
     OR v_posted_as_of_def NOT LIKE '%HISTORICAL_POSTING_RECONSTRUCTION_UNAVAILABLE%'
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_posted_as_of_oid)
     OR NOT ('search_path=public, pg_temp' = ANY(
       COALESCE((SELECT proconfig FROM pg_proc WHERE oid = v_posted_as_of_oid), ARRAY[]::text[])
     ))
     OR has_function_privilege('anon', v_posted_as_of_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_posted_as_of_oid, 'EXECUTE')
     OR has_function_privilege('service_role', v_posted_as_of_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: historical posting helper is missing or exposed';
  END IF;
  IF has_function_privilege('anon', 'public.get_detailed_statement_data(uuid,date,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.generate_batch_statements(date,uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: anon can execute statement RPCs';
  END IF;
END;
$postflight$;
