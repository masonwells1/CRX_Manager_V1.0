-- Close SECURITY DEFINER scope gaps in invoice saving and customer statements.
-- The existing, proven business implementations stay intact behind non-callable
-- internal names. Public wrappers authorize the active actor and customer scope
-- before the internal functions can inspect an idempotency cache or financial data.

DO $guard$
BEGIN
  IF to_regprocedure('public.save_invoice(jsonb,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION 'Expected save_invoice(jsonb,jsonb,text)';
  END IF;
  IF to_regprocedure('public._save_invoice_scoped_impl(jsonb,jsonb,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'Internal save_invoice implementation already exists';
  END IF;
  IF to_regprocedure('public.get_customer_statement(uuid,date,date)') IS NULL THEN
    RAISE EXCEPTION 'Expected get_customer_statement(uuid,date,date)';
  END IF;
  IF to_regprocedure('public._get_customer_statement_scoped_impl(uuid,date,date)') IS NOT NULL THEN
    RAISE EXCEPTION 'Internal customer statement implementation already exists';
  END IF;
END
$guard$;

ALTER FUNCTION public.save_invoice(jsonb, jsonb, text)
  RENAME TO _save_invoice_scoped_impl;

REVOKE ALL ON FUNCTION public._save_invoice_scoped_impl(jsonb, jsonb, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.save_invoice(
  p_invoice jsonb,
  p_items jsonb DEFAULT '[]'::jsonb,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_invoice_id uuid := NULLIF(p_invoice->>'id', '')::uuid;
  v_existing_customer_id uuid;
  v_requested_customer_id uuid := NULLIF(p_invoice->>'customer_id', '')::uuid;
  v_target_customer_id uuid;
  v_requested_salesman_id uuid := NULLIF(p_invoice->>'salesman_id', '')::uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;

  SELECT role
    INTO v_actor_role
    FROM public.profiles
   WHERE id = v_actor
     AND is_active = true;

  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF v_invoice_id IS NOT NULL THEN
    SELECT customer_id
      INTO v_existing_customer_id
      FROM public.invoices
     WHERE id = v_invoice_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'INVOICE_NOT_FOUND';
    END IF;
  END IF;

  v_target_customer_id := COALESCE(v_requested_customer_id, v_existing_customer_id);

  IF v_target_customer_id IS NULL THEN
    RAISE EXCEPTION 'CUSTOMER_REQUIRED';
  END IF;

  IF v_actor_role = 'sales_rep' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.customers
       WHERE id = v_target_customer_id
         AND assigned_sales_rep = v_actor
    ) THEN
      RAISE EXCEPTION 'CUSTOMER_SCOPE_DENIED';
    END IF;

    -- A sales rep cannot transfer invoice ownership to another rep through the
    -- SECURITY DEFINER writer. Omitted salesman_id remains backward-compatible.
    IF v_requested_salesman_id IS NOT NULL
       AND v_requested_salesman_id IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'SALESMAN_SCOPE_DENIED';
    END IF;
  END IF;

  RETURN public._save_invoice_scoped_impl(
    p_invoice,
    p_items,
    p_idempotency_key
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.save_invoice(jsonb, jsonb, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_invoice(jsonb, jsonb, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public._save_invoice_scoped_impl(jsonb, jsonb, text)
  IS 'Internal invoice writer. Direct execution is revoked; use public.save_invoice so active-role and customer scope checks run before replay lookup.';
COMMENT ON FUNCTION public.save_invoice(jsonb, jsonb, text)
  IS 'Saves an invoice for an active admin or for an active sales rep assigned to the invoice customer.';

ALTER FUNCTION public.get_customer_statement(uuid, date, date)
  RENAME TO _get_customer_statement_scoped_impl;

REVOKE ALL ON FUNCTION public._get_customer_statement_scoped_impl(uuid, date, date)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.get_customer_statement(
  p_customer_id uuid,
  p_start_date date DEFAULT ((CURRENT_DATE - '90 days'::interval))::date,
  p_end_date date DEFAULT CURRENT_DATE
)
RETURNS TABLE(
  transaction_date date,
  transaction_type text,
  reference_number text,
  description text,
  amount_cents bigint,
  running_balance bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;

  SELECT role
    INTO v_actor_role
    FROM public.profiles
   WHERE id = v_actor
     AND is_active = true;

  IF v_actor_role = 'sales_rep' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.customers
       WHERE id = p_customer_id
         AND assigned_sales_rep = v_actor
    ) THEN
      RAISE EXCEPTION 'CUSTOMER_SCOPE_DENIED';
    END IF;
  ELSIF v_actor_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  RETURN QUERY
  SELECT *
    FROM public._get_customer_statement_scoped_impl(
      p_customer_id,
      p_start_date,
      p_end_date
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_customer_statement(uuid, date, date)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_customer_statement(uuid, date, date)
  TO authenticated, service_role;

COMMENT ON FUNCTION public._get_customer_statement_scoped_impl(uuid, date, date)
  IS 'Internal customer statement reader. Direct execution is revoked; use public.get_customer_statement so customer scope is checked first.';
COMMENT ON FUNCTION public.get_customer_statement(uuid, date, date)
  IS 'Returns a customer statement to an active admin or the active sales rep assigned to that customer.';

DO $verify$
DECLARE
  v_config text[];
BEGIN
  SELECT proconfig
    INTO v_config
    FROM pg_proc
   WHERE oid = 'public.save_invoice(jsonb,jsonb,text)'::regprocedure;
  IF v_config IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN
    RAISE EXCEPTION 'save_invoice must keep fixed public, pg_temp search_path';
  END IF;

  IF has_function_privilege('anon', 'public.save_invoice(jsonb,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._save_invoice_scoped_impl(jsonb,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._get_customer_statement_scoped_impl(uuid,date,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Financial scope helper grants are too broad';
  END IF;
END
$verify$;
