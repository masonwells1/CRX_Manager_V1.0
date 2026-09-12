-- STATUS: NOT APPLIED. PR #652 follow-up; original/applied migrations are untouched.
-- Generic save_invoice must not CREATE field-application invoices. It can accept an
-- arbitrary supplied season and bypass the dedicated creation/pricing workflow; the
-- existing filed-season UPDATE guard then prevents normal correction of that disagreement.
-- Dedicated field-app, job-transfer and blend-ticket creators remain unchanged, including
-- their deliberate source-season behavior. Existing generic field-invoice edits still work.
-- Reemit only the read-only-inspected live public wrapper with one early refusal; retain
-- original below-cost authorization and idempotency calls/delegation, signature, owner,
-- search_path and ACL. No rows, money math, source dates, or other invoice types change.
-- ordering-guard: ahead-of-pending Older unapplied commission/invoice-number candidates
-- already sort below live's authored high-water 20260908120000, verified read-only September
-- 12. They require their own forward renumber; this independent guard does not apply them.
-- idempotency-body-check: exempt This sole wrapper retains its real check_idempotency
-- call and delegates lookup/receipt/intent enforcement to the unchanged private writer.

DO $preflight$
DECLARE v_oid oid := to_regprocedure('public.save_invoice(jsonb,jsonb,text)');
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'save_invoice') <> 1
     OR (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
        AND NOT p.proisstrict AND p.prorettype = 'uuid'::regtype AND NOT p.proretset
        AND NOT p.proleakproof AND p.proparallel = 'u'
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        AND pg_get_function_arguments(p.oid) =
          'p_invoice jsonb, p_items jsonb DEFAULT ''[]''::jsonb, p_idempotency_key text DEFAULT NULL::text'
        AND md5(p.prosrc) IN ('9a34478d405a1a3b8233cabcdfb39691', 'cb932dc51a680442affde5aeba2eaee3')
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[]
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
        AND has_function_privilege('service_role', p.oid, 'EXECUTE')
        FROM pg_proc p WHERE p.oid = v_oid) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PREFLIGHT_GENERIC_FIELD_CREATION_DRIFT: expected the exact reviewed original or replay public save_invoice contract';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.save_invoice(
  p_invoice jsonb,
  p_items jsonb DEFAULT '[]'::jsonb,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NULLIF(p_invoice->>'id', '') IS NULL AND p_invoice->>'invoice_type' = 'field_application' THEN
    RAISE EXCEPTION
      'FIELD_APPLICATION_VIA_SAVE_INVOICE_NOT_ALLOWED: create field invoices through the field-application, job-transfer or blend-ticket workflow'
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM public._begin_below_cost_money_write('save_invoice', NULL, p_items);
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.check_idempotency(p_idempotency_key, 'save_invoice');
  END IF;
  RETURN public._save_invoice_below_cost_impl_20260810(p_invoice, p_items, p_idempotency_key);
END;
$function$;

-- CREATE OR REPLACE preserves the live OID, dependencies, postgres owner and exact ACL.
-- Fail before replacement if that access posture drifted; do not silently repair outside scope.
DO $postflight$
DECLARE v_oid oid := to_regprocedure('public.save_invoice(jsonb,jsonb,text)');
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'save_invoice') <> 1
     OR (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
        AND NOT p.proisstrict AND p.prorettype = 'uuid'::regtype AND NOT p.proretset
        AND NOT p.proleakproof AND p.proparallel = 'u'
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        AND pg_get_function_arguments(p.oid) =
          'p_invoice jsonb, p_items jsonb DEFAULT ''[]''::jsonb, p_idempotency_key text DEFAULT NULL::text'
        AND md5(p.prosrc) = 'cb932dc51a680442affde5aeba2eaee3'
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[]
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
        AND has_function_privilege('service_role', p.oid, 'EXECUTE')
        FROM pg_proc p WHERE p.oid = v_oid) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'POSTFLIGHT_GENERIC_FIELD_CREATION_CONTRACT: public save_invoice body, signature or access posture drifted';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: generic NEW field-invoice creation refused; dedicated creators, existing edits, below-cost and idempotency paths retained';
END
$postflight$;
