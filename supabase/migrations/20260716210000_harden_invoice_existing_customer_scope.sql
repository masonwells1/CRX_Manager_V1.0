-- Close the remaining save_invoice reassignment bypass found by the final
-- Sonnet 5 review. On an edit, a sales rep must be assigned to both the
-- invoice's stored customer and the requested customer before the internal
-- writer can inspect idempotency state or mutate the row.

DO $guard$
BEGIN
  IF to_regprocedure('public.save_invoice(jsonb,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION 'Expected save_invoice(jsonb,jsonb,text)';
  END IF;
  IF to_regprocedure('public._save_invoice_scoped_impl(jsonb,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION 'Expected _save_invoice_scoped_impl(jsonb,jsonb,text)';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.save_invoice(
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
     WHERE id = v_invoice_id
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'INVOICE_NOT_FOUND';
    END IF;
  END IF;

  v_target_customer_id := COALESCE(v_requested_customer_id, v_existing_customer_id);

  IF v_target_customer_id IS NULL THEN
    RAISE EXCEPTION 'CUSTOMER_REQUIRED';
  END IF;

  IF v_actor_role = 'sales_rep' THEN
    -- Authorize the stored owner independently from the requested target. The
    -- row lock prevents an ownership change between this check and the update.
    IF v_existing_customer_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
           FROM public.customers
          WHERE id = v_existing_customer_id
            AND assigned_sales_rep = v_actor
       ) THEN
      RAISE EXCEPTION 'CUSTOMER_SCOPE_DENIED';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM public.customers
       WHERE id = v_target_customer_id
         AND assigned_sales_rep = v_actor
    ) THEN
      RAISE EXCEPTION 'CUSTOMER_SCOPE_DENIED';
    END IF;

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
REVOKE ALL ON FUNCTION public._save_invoice_scoped_impl(jsonb, jsonb, text)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.save_invoice(jsonb, jsonb, text)
  IS 'Saves an invoice for an active admin or for an active sales rep assigned to both the stored and requested customer.';

DO $verify$
DECLARE
  v_config text[];
  v_source text;
BEGIN
  SELECT proconfig, prosrc
    INTO v_config, v_source
    FROM pg_proc
   WHERE oid = 'public.save_invoice(jsonb,jsonb,text)'::regprocedure;

  IF v_config IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN
    RAISE EXCEPTION 'save_invoice must keep fixed public, pg_temp search_path';
  END IF;
  IF v_source NOT LIKE '%id = v_existing_customer_id%'
     OR v_source NOT LIKE '%FOR UPDATE%'
     OR v_source NOT LIKE '%id = v_target_customer_id%' THEN
    RAISE EXCEPTION 'save_invoice must authorize stored and requested customers under row lock';
  END IF;
  IF has_function_privilege('anon', 'public.save_invoice(jsonb,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._save_invoice_scoped_impl(jsonb,jsonb,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Invoice scope helper grants are too broad';
  END IF;
END
$verify$;
