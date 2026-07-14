-- Keep the admin-only batch prepay workspace boundary enforced in PostgreSQL.
-- The UI route is admin-only; this gate prevents lower-privileged callers
-- from invoking this batch wrapper directly. apply_prepay_to_invoice retains
-- its existing active admin/sales_rep contract for single allocations.

CREATE OR REPLACE FUNCTION public.batch_apply_prepayments(
  p_allocations     jsonb,
  p_performed_by    uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_alloc            jsonb;
  v_invoice_id       uuid;
  v_invoice_date     date;
  v_result_id        uuid;
  v_result_ids       uuid[] := ARRAY[]::uuid[];
  v_total_applied    bigint := 0;
  v_count            integer := 0;
  v_cached_result    jsonb;
  v_result           jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required'
      USING ERRCODE = '42501';
  END IF;

  -- Idempotency replay
  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'batch_apply_prepayments');
    IF v_cached_result IS NOT NULL THEN
      RETURN v_cached_result;
    END IF;
  END IF;

  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations)
  LOOP
    v_invoice_id := (v_alloc->>'invoice_id')::uuid;

    -- P3-4 FIX: look up the invoice's date and enforce period-close on it.
    -- This runs BEFORE the inner apply_prepay_to_invoice call, which itself
    -- only checks CURRENT_DATE.
    SELECT invoice_date INTO v_invoice_date
      FROM invoices
     WHERE id = v_invoice_id;
    IF v_invoice_date IS NULL THEN
      RAISE EXCEPTION 'Invoice not found for prepay allocation: %', v_invoice_id;
    END IF;
    PERFORM check_period_open(v_invoice_date);

    v_result_id := apply_prepay_to_invoice(
      (v_alloc->>'prepay_credit_id')::uuid,
      v_invoice_id,
      (v_alloc->>'amount_cents')::bigint
    );
    v_result_ids := array_append(v_result_ids, v_result_id);
    v_total_applied := v_total_applied + (v_alloc->>'amount_cents')::bigint;
    v_count := v_count + 1;
  END LOOP;

  v_result := jsonb_build_object(
    'success', true,
    'applied_count', v_count,
    'total_applied_cents', v_total_applied,
    'application_ids', to_jsonb(v_result_ids)
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'batch_apply_prepayments', v_result);
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.batch_apply_prepayments(jsonb, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.batch_apply_prepayments(jsonb, uuid, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.batch_apply_prepayments(jsonb, uuid, text) IS
  'Admin-only atomic batch application of prepay credits to invoices. Enforces check_period_open per-invoice before mutating. Any invoice in a closed period raises and rolls back the entire batch.';

DO $$
DECLARE
  v_source text;
  v_overload_count integer;
  v_security_definer boolean;
  v_config text[];
BEGIN
  SELECT p.prosrc, p.prosecdef, p.proconfig
    INTO v_source, v_security_definer, v_config
    FROM pg_proc p
   WHERE p.oid = 'public.batch_apply_prepayments(jsonb,uuid,text)'::regprocedure;

  IF v_source !~* 'IF\s+NOT\s+(public\.)?is_admin\s*\(\s*\)' THEN
    RAISE EXCEPTION 'batch_apply_prepayments is missing its active-admin gate';
  END IF;

  IF NOT v_security_definer
     OR NOT coalesce(v_config, ARRAY[]::text[]) @> ARRAY['search_path=public, pg_temp'] THEN
    RAISE EXCEPTION
      'batch_apply_prepayments must be SECURITY DEFINER with public, pg_temp search_path';
  END IF;

  IF has_function_privilege('anon', 'public.batch_apply_prepayments(jsonb,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.batch_apply_prepayments(jsonb,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.batch_apply_prepayments(jsonb,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'batch_apply_prepayments grants are not converged';
  END IF;

  SELECT count(*)
    INTO v_overload_count
    FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname = 'batch_apply_prepayments';

  IF v_overload_count <> 1 THEN
    RAISE EXCEPTION
      'Expected one batch_apply_prepayments overload, found %',
      v_overload_count;
  END IF;
END;
$$;
