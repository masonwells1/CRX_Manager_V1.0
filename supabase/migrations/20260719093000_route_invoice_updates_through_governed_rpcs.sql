-- Split-invoice provenance cannot be complete while Data API roles can update
-- arbitrary invoice header columns outside the owner-context business RPCs.
-- Repo callers already route invoice mutations through save/post/payment/void/
-- cancellation RPCs, so close the remaining direct UPDATE lane atomically.

LOCK TABLE public.invoices IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_save_count integer;
  v_save_secdef boolean;
  v_save_config text[];
BEGIN
  IF NOT has_table_privilege('authenticated', 'public.invoices', 'UPDATE')
     OR NOT has_table_privilege('service_role', 'public.invoices', 'UPDATE') THEN
    RAISE EXCEPTION 'INVOICE_UPDATE_GRANT_BASELINE_DRIFT';
  END IF;

  SELECT count(*)
    INTO v_save_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'save_invoice'
     AND pg_get_function_identity_arguments(p.oid) =
           'p_invoice jsonb, p_items jsonb, p_idempotency_key text';

  SELECT p.prosecdef, p.proconfig
    INTO v_save_secdef, v_save_config
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.save_invoice(jsonb,jsonb,text)');

  IF v_save_count <> 1
     OR v_save_secdef IS DISTINCT FROM true
     OR NOT (COALESCE(v_save_config, ARRAY[]::text[]) @>
             ARRAY['search_path=public, pg_temp'])
     OR NOT has_function_privilege(
              'authenticated',
              'public.save_invoice(jsonb,jsonb,text)',
              'EXECUTE'
            )
     OR NOT has_function_privilege(
              'service_role',
              'public.save_invoice(jsonb,jsonb,text)',
              'EXECUTE'
            )
     OR has_function_privilege(
          'anon',
          'public.save_invoice(jsonb,jsonb,text)',
          'EXECUTE'
        ) THEN
    RAISE EXCEPTION 'GOVERNED_SAVE_INVOICE_BASELINE_DRIFT';
  END IF;
END;
$preflight$;

-- caller-analysis: the repository has no direct invoices UPDATE writer; all
-- browser and service workflows use owner-context RPCs that retain EXECUTE.
REVOKE UPDATE ON TABLE public.invoices
  FROM PUBLIC, anon, authenticated, service_role;

DO $postflight$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role']
  LOOP
    IF has_table_privilege(role_name, 'public.invoices', 'UPDATE') THEN
      RAISE EXCEPTION 'DIRECT_INVOICE_UPDATE_REMAINS_GRANTED: %', role_name;
    END IF;
  END LOOP;

  IF NOT has_function_privilege(
           'authenticated',
           'public.save_invoice(jsonb,jsonb,text)',
           'EXECUTE'
         )
     OR NOT has_function_privilege(
              'service_role',
              'public.save_invoice(jsonb,jsonb,text)',
              'EXECUTE'
            )
     OR has_function_privilege(
          'anon',
          'public.save_invoice(jsonb,jsonb,text)',
          'EXECUTE'
        ) THEN
    RAISE EXCEPTION 'GOVERNED_SAVE_INVOICE_POSTFLIGHT_DRIFT';
  END IF;
END;
$postflight$;
