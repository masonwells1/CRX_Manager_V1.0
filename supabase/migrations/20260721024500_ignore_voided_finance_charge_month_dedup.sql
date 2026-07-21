-- CodeRabbit follow-up: a voided/cancelled finance-charge invoice is no
-- longer an active monthly assessment and must not block a corrected charge
-- later in the same calendar month. Forward-only re-emission; the applied
-- 20260718174018 migration remains immutable.

DO $preflight$
DECLARE
  v_source text;
BEGIN
  SELECT prosrc INTO v_source
    FROM pg_proc
   WHERE oid = 'public.generate_finance_charges(date,uuid,uuid[],text)'::regprocedure;

  IF md5(v_source) <> '091f8d0123e2b2aa78ee5567ce2c0a51'
     OR NOT (SELECT prosecdef FROM pg_proc
              WHERE oid = 'public.generate_finance_charges(date,uuid,uuid[],text)'::regprocedure)
     OR ('search_path=public, pg_temp' = ANY (
          SELECT unnest(proconfig) FROM pg_proc
           WHERE oid = 'public.generate_finance_charges(date,uuid,uuid[],text)'::regprocedure
        )) IS NOT TRUE
     OR has_function_privilege('anon', 'public.generate_finance_charges(date,uuid,uuid[],text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.generate_finance_charges(date,uuid,uuid[],text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.generate_finance_charges(date,uuid,uuid[],text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PRECONDITION: generate_finance_charges live contract drifted';
  END IF;
  IF to_regprocedure('public._claim_bound_lifecycle_idempotency(text,text,text,text,jsonb)') IS NULL
     OR to_regprocedure('public._bind_completed_lifecycle_idempotency(text,text,text,text,jsonb,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION: bound idempotency helpers are missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.idempotency_keys
     WHERE operation = 'generate_finance_charges'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION: unbound generate_finance_charges key requires reconciliation';
  END IF;

  SELECT prosrc INTO v_source
    FROM pg_proc
   WHERE oid = 'public.preview_finance_charges(date)'::regprocedure;

  IF md5(v_source) <> 'be3e34cb453067ef19c47f28926e96a4'
     OR NOT (SELECT prosecdef FROM pg_proc
              WHERE oid = 'public.preview_finance_charges(date)'::regprocedure)
     OR ('search_path=public, pg_temp' = ANY (
          SELECT unnest(proconfig) FROM pg_proc
           WHERE oid = 'public.preview_finance_charges(date)'::regprocedure
        )) IS NOT TRUE
     OR has_function_privilege('anon', 'public.preview_finance_charges(date)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.preview_finance_charges(date)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.preview_finance_charges(date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PRECONDITION: preview_finance_charges live contract drifted';
  END IF;
END;
$preflight$;

DROP FUNCTION IF EXISTS public.generate_finance_charges(date, uuid);
DROP FUNCTION IF EXISTS public.generate_finance_charges(date, uuid, uuid[]);

CREATE OR REPLACE FUNCTION public.generate_finance_charges(p_as_of_date date, p_performed_by uuid, p_customer_ids uuid[] DEFAULT NULL::uuid[], p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_customer record;
  v_charge_amount bigint;
  v_invoice_id uuid;
  v_inv_num text;
  v_charges jsonb := '[]'::jsonb;
  v_count integer := 0;
  v_skipped integer := 0;
  v_min_balance bigint;
  v_existing jsonb;
  v_result jsonb;
  v_contract CONSTANT text := 'generate_finance_charges_v2';
  v_request jsonb;
  v_fingerprint text;
  v_customer_ids uuid[];
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT is_admin() THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  IF p_as_of_date IS NULL THEN
    RAISE EXCEPTION 'FINANCE_CHARGE_DATE_REQUIRED';
  END IF;
  IF p_as_of_date > (now() AT TIME ZONE 'America/Chicago')::date THEN
    RAISE EXCEPTION 'FUTURE_FINANCE_CHARGE_DATE: finance charges cannot be generated for a future business date';
  END IF;

  IF p_customer_ids IS NOT NULL THEN
    SELECT COALESCE(array_agg(DISTINCT customer_id ORDER BY customer_id), '{}'::uuid[])
      INTO v_customer_ids
      FROM unnest(p_customer_ids) AS selected(customer_id);
  END IF;
  v_request := jsonb_build_object(
    'contract_version', v_contract,
    'actor_id', v_actor,
    'as_of_date', p_as_of_date,
    'customer_ids', to_jsonb(v_customer_ids)
  );
  v_fingerprint := md5(v_request::text);
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public._claim_bound_lifecycle_idempotency(
      p_idempotency_key,
      'generate_finance_charges',
      v_contract,
      v_fingerprint,
      v_request
    );
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  -- H2 fix: key the serialization lock on the MONTH, not the exact as-of date,
  -- so two concurrent runs in the same month (different as-of dates) serialize
  -- and the second sees the first's committed charge — matching the month-level
  -- dedup below. (Keying on the date let them take different locks and both pass
  -- the EXISTS check before either inserted — the double-charge this fixes.)
  PERFORM pg_advisory_xact_lock(hashtext('generate_finance_charges:' || to_char(p_as_of_date, 'YYYY-MM')));
  PERFORM public.check_period_open(p_as_of_date);

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
        AND i.status IN ('posted', 'overdue')
        AND i.balance_cents > 0
        AND i.deleted_at IS NULL
        AND i.invoice_type != 'misc_charge'
        AND i.due_date IS NOT NULL
        AND i.due_date < (p_as_of_date - (COALESCE(c.finance_charge_grace_days, 0) || ' days')::interval)
      WHERE c.finance_charge_rate > 0
        AND c.is_active = true
        AND COALESCE(c.finance_charge_enabled, true) = true
        AND (v_customer_ids IS NULL OR c.id = ANY(v_customer_ids))
      GROUP BY c.id, c.farm_name, c.finance_charge_rate, c.finance_charge_grace_days
      HAVING sum(i.balance_cents) >= v_min_balance
  LOOP
    -- H2 fix: dedup on the CALENDAR MONTH, not the exact as-of date. Two runs
    -- in the same month (different as-of dates) must not both charge the same
    -- overdue balance; a genuinely new month still charges.
    IF EXISTS (
      SELECT 1
        FROM public.finance_charges fc
        INNER JOIN public.invoices charge_invoice
          ON charge_invoice.id = fc.invoice_id
       WHERE fc.customer_id = v_customer.customer_id
         AND date_trunc('month', fc.period_end) = date_trunc('month', p_as_of_date)
         AND charge_invoice.deleted_at IS NULL
         AND charge_invoice.status NOT IN ('voided', 'cancelled')
    ) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    v_charge_amount := ROUND(v_customer.overdue_balance * (v_customer.finance_charge_rate / 100.0 / 12.0));

    IF v_charge_amount > 0 THEN
      v_inv_num := next_invoice_number('misc_charge');

      INSERT INTO public.invoices (
        invoice_number, customer_id, invoice_type, status, invoice_date, due_date,
        total_amount_cents, total_cost_cents,
        header_notes, season, created_by
      ) VALUES (
        -- OVERNIGHT FIX (finding #1): insert as 'draft' — the BEFORE INSERT trigger
        -- rejects any non-draft, non-credit_memo insert. Flipped to 'unposted' below
        -- once the item / finance_charges / audit rows are built. Live literal was 'unposted'.
        v_inv_num, v_customer.customer_id, 'misc_charge', 'draft', p_as_of_date,
        (p_as_of_date + interval '30 days')::date,
        v_charge_amount, 0,
        'Finance charge: ' || v_customer.finance_charge_rate || '% annual on overdue balance of $' ||
        to_char(v_customer.overdue_balance / 100.0, 'FM999,999,990.00') ||
        CASE WHEN v_customer.grace_days > 0
             THEN ' (after ' || v_customer.grace_days || ' day grace period)'
             ELSE '' END,
        CASE WHEN extract(month FROM p_as_of_date) >= 10
             THEN extract(year FROM p_as_of_date)::integer + 1
             ELSE extract(year FROM p_as_of_date)::integer END,
        v_actor
      ) RETURNING id INTO v_invoice_id;

      INSERT INTO public.invoice_items (
        invoice_id, description, quantity, unit_price_cents, extended_cents,
        cost_cents, is_application_fee, sort_order
      ) VALUES (
        v_invoice_id,
        'Finance Charge - ' || v_customer.finance_charge_rate || '% annual rate on overdue balance',
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
        v_actor
      );

      INSERT INTO public.financial_audit_log (
        operation_type,
        entity_type,
        entity_id,
        actor_user_id, total_impact_cents, description
      ) VALUES (
        'finance_charge', 'invoice', v_invoice_id,
        v_actor, v_charge_amount,
        'Finance charge generated for ' || v_customer.farm_name ||
        ': $' || to_char(v_charge_amount / 100.0, 'FM999,999,990.00') ||
        ' at ' || v_customer.finance_charge_rate || '% on $' ||
        to_char(v_customer.overdue_balance / 100.0, 'FM999,999,990.00') || ' overdue'
      );

      -- OVERNIGHT FIX (finding #1): now that the invoice and its child rows are fully
      -- built, flip draft -> unposted (the original intended end state). Allowed by
      -- _enforce_invoice_status_transition (draft -> unposted).
      UPDATE public.invoices SET status = 'unposted' WHERE id = v_invoice_id;

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

  v_result := jsonb_build_object(
    'charges_generated', v_count,
    'skipped_already_charged', v_skipped,
    'details', v_charges
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public._bind_completed_lifecycle_idempotency(
      p_idempotency_key,
      'generate_finance_charges',
      v_contract,
      v_fingerprint,
      v_request,
      v_result
    );
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.generate_finance_charges(date, uuid, uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_finance_charges(date, uuid, uuid[], text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.preview_finance_charges(p_as_of_date date)
RETURNS TABLE(
  customer_id uuid, customer_name text, account_number text,
  overdue_balance_cents bigint, charge_rate numeric, grace_days integer,
  days_overdue integer, charge_amount_cents bigint,
  finance_charge_enabled boolean, open_credit_cents bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_min_balance bigint;
BEGIN
  PERFORM require_admin();
  IF p_as_of_date IS NULL THEN
    RAISE EXCEPTION 'FINANCE_CHARGE_DATE_REQUIRED';
  END IF;
  IF p_as_of_date > (now() AT TIME ZONE 'America/Chicago')::date THEN
    RAISE EXCEPTION 'FUTURE_FINANCE_CHARGE_DATE: finance charges cannot be previewed for a future business date';
  END IF;
  PERFORM public.check_period_open(p_as_of_date);

  SELECT COALESCE(s.setting_value::bigint, 500)
    INTO v_min_balance
    FROM public.app_settings s
   WHERE s.setting_key = 'finance_charge_min_balance_cents';
  IF v_min_balance IS NULL THEN v_min_balance := 500; END IF;

  RETURN QUERY
  SELECT
    c.id,
    c.farm_name::text,
    c.account_number::text,
    agg.overdue_balance_cents,
    c.finance_charge_rate,
    COALESCE(c.finance_charge_grace_days, 0),
    agg.max_days_overdue,
    ROUND(agg.overdue_balance_cents * (c.finance_charge_rate / 100.0 / 12.0))::bigint,
    COALESCE(c.finance_charge_enabled, true),
    COALESCE(cm.credit_cents, 0)::bigint
  FROM public.customers c
  INNER JOIN (
    SELECT i.customer_id,
           COALESCE(sum(i.balance_cents), 0)::bigint AS overdue_balance_cents,
           max((p_as_of_date - i.due_date))::integer AS max_days_overdue
      FROM public.invoices i
      JOIN public.customers cc ON cc.id = i.customer_id
     WHERE i.status IN ('posted', 'overdue')
       AND i.balance_cents > 0
       AND i.deleted_at IS NULL
       AND i.invoice_type != 'misc_charge'
       AND i.due_date IS NOT NULL
       AND i.due_date < (p_as_of_date - (COALESCE(cc.finance_charge_grace_days, 0) || ' days')::interval)
     GROUP BY i.customer_id
  ) agg ON agg.customer_id = c.id
  LEFT JOIN (
    SELECT ci.customer_id, -SUM(ci.balance_cents) AS credit_cents
      FROM public.invoices ci
     WHERE ci.invoice_type = 'credit_memo'
       AND ci.status = 'posted'
       AND ci.balance_cents < 0
       AND ci.deleted_at IS NULL
     GROUP BY ci.customer_id
  ) cm ON cm.customer_id = c.id
  WHERE c.finance_charge_rate > 0
    AND c.is_active = true
    AND COALESCE(c.finance_charge_enabled, true) = true
    AND agg.overdue_balance_cents >= v_min_balance
    AND ROUND(agg.overdue_balance_cents * (c.finance_charge_rate / 100.0 / 12.0))::bigint > 0
    AND NOT EXISTS (
      SELECT 1
        FROM public.finance_charges fc
        INNER JOIN public.invoices charge_invoice
          ON charge_invoice.id = fc.invoice_id
       WHERE fc.customer_id = c.id
         AND date_trunc('month', fc.period_end) = date_trunc('month', p_as_of_date)
         AND charge_invoice.deleted_at IS NULL
         AND charge_invoice.status NOT IN ('voided', 'cancelled')
    )
  ORDER BY c.farm_name;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.preview_finance_charges(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_finance_charges(date) TO authenticated, service_role;


DO $postflight$
DECLARE
  v_source text;
BEGIN
  SELECT prosrc INTO v_source
    FROM pg_proc
   WHERE oid = 'public.generate_finance_charges(date,uuid,uuid[],text)'::regprocedure;

  IF v_source NOT LIKE '%JOIN public.invoices charge_invoice%'
     OR v_source NOT LIKE '%charge_invoice.status NOT IN (''voided'', ''cancelled'')%'
     OR v_source NOT LIKE '%charge_invoice.deleted_at IS NULL%'
     OR v_source NOT LIKE '%_claim_bound_lifecycle_idempotency%'
     OR v_source NOT LIKE '%_bind_completed_lifecycle_idempotency%'
     OR v_source NOT LIKE '%generate_finance_charges_v2%'
     OR NOT (SELECT prosecdef FROM pg_proc
              WHERE oid = 'public.generate_finance_charges(date,uuid,uuid[],text)'::regprocedure)
     OR ('search_path=public, pg_temp' = ANY (
          SELECT unnest(proconfig) FROM pg_proc
           WHERE oid = 'public.generate_finance_charges(date,uuid,uuid[],text)'::regprocedure
        )) IS NOT TRUE
     OR has_function_privilege('anon', 'public.generate_finance_charges(date,uuid,uuid[],text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.generate_finance_charges(date,uuid,uuid[],text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.generate_finance_charges(date,uuid,uuid[],text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT: active finance-charge month dedup contract missing';
  END IF;

  SELECT prosrc INTO v_source
    FROM pg_proc
   WHERE oid = 'public.preview_finance_charges(date)'::regprocedure;

  IF v_source NOT LIKE '%JOIN public.invoices charge_invoice%'
     OR v_source NOT LIKE '%charge_invoice.status NOT IN (''voided'', ''cancelled'')%'
     OR v_source NOT LIKE '%charge_invoice.deleted_at IS NULL%'
     OR NOT (SELECT prosecdef FROM pg_proc
              WHERE oid = 'public.preview_finance_charges(date)'::regprocedure)
     OR ('search_path=public, pg_temp' = ANY (
          SELECT unnest(proconfig) FROM pg_proc
           WHERE oid = 'public.preview_finance_charges(date)'::regprocedure
        )) IS NOT TRUE
     OR has_function_privilege('anon', 'public.preview_finance_charges(date)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.preview_finance_charges(date)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.preview_finance_charges(date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT: finance-charge preview parity contract missing';
  END IF;
END;
$postflight$;
