-- STATUS: NOT APPLIED. PR #652 PHASE 1; original/applied migrations are untouched.
-- Install a fail-fast shared cutover barrier BEFORE changing generic field creation.
-- This phase preserves the original below-cost, key-only receipt and delegated writer
-- behavior, including retries of already committed invoices. Legacy receipts are NOT
-- actor/intent-bound; do not manufacture bindings or return them as authorized matches.
-- Apply this phase as its own COMMITTED migration. Phase 2 drains shared holders,
-- refuses old open/prepared transactions and any still-valid generic receipts, and
-- only then refuses NEW generic field invoices. Never bundle the phases in one transaction.
-- READ COMMITTED is required during this transitional wrapper: its separate catalog
-- lookup must see the current body, not a repeatable-read snapshot of this V1 marker.
-- No rows, money math, dates, source creators, signature, owner or ACL change.
-- ORDERING: strict. No ahead-of-pending marker. The previous marker's reason was obsolete
-- (the 20260905 candidates were restamped above this file) and it additionally waved through
-- both 20260908140000_number_generators_year_chicago (PR #726, UNAPPLIED) and this PR's own
-- 20260908190000 season guard, either of which stepping over would strand it. Apply every
-- older pending migration first, in ascending order.
-- idempotency-body-check: exempt This sole wrapper retains its real check_idempotency
-- call and delegates unchanged key-only lookup/receipt semantics to the private writer.

CREATE TEMP TABLE generic_field_cutover_phase1_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id,
       to_regprocedure('public.save_invoice(jsonb,jsonb,text)')::oid AS function_oid;

DO $preflight$
DECLARE v_oid oid := to_regprocedure('public.save_invoice(jsonb,jsonb,text)');
BEGIN
  IF to_regclass('pg_temp.generic_field_cutover_phase1_tx') IS NULL THEN
    RAISE EXCEPTION 'GENERIC_FIELD_CUTOVER_NOT_IN_TRANSACTION: apply phase 1 in one transaction';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.generic_field_cutover_phase1_tx)
        IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'GENERIC_FIELD_CUTOVER_NOT_IN_TRANSACTION: apply phase 1 in one transaction';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'save_invoice') <> 1
     OR (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
        AND NOT p.proisstrict AND p.prorettype = 'uuid'::regtype AND NOT p.proretset
        AND NOT p.proleakproof AND p.proparallel = 'u'
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        AND pg_get_function_arguments(p.oid) =
          'p_invoice jsonb, p_items jsonb DEFAULT ''[]''::jsonb, p_idempotency_key text DEFAULT NULL::text'
        AND md5(p.prosrc) IN ('9a34478d405a1a3b8233cabcdfb39691', '82c68c993dcff32eabd7b70c70f11527')
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
  IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(20260912, 652) THEN
    RAISE EXCEPTION
      'GENERIC_FIELD_CUTOVER_IN_PROGRESS: no invoice was changed; retry in a moment'
      USING ERRCODE = 'serialization_failure';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'GENERIC_FIELD_CUTOVER_ISOLATION: retry in a new READ COMMITTED transaction'
      USING ERRCODE = 'serialization_failure';
  END IF;
  -- A cached V1 call resuming after phase 2 must fail before lookup or mutation.
  IF (SELECT position('GENERIC_FIELD_CUTOVER_BODY_V1' IN p.prosrc) > 0
      FROM pg_catalog.pg_proc p
      WHERE p.oid = 'public.save_invoice(jsonb,jsonb,text)'::regprocedure) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'GENERIC_FIELD_CUTOVER_STALE_CALL: no invoice was changed; retry in a new request'
      USING ERRCODE = 'serialization_failure';
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
  IF to_regclass('pg_temp.generic_field_cutover_phase1_tx') IS NULL THEN
    RAISE EXCEPTION 'GENERIC_FIELD_CUTOVER_NOT_IN_TRANSACTION: phase 1 transaction was not preserved';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.generic_field_cutover_phase1_tx)
        IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'GENERIC_FIELD_CUTOVER_NOT_IN_TRANSACTION: phase 1 transaction was not preserved';
  END IF;
  IF v_oid IS DISTINCT FROM (SELECT function_oid FROM pg_temp.generic_field_cutover_phase1_tx) THEN
    RAISE EXCEPTION 'POSTFLIGHT_GENERIC_FIELD_CREATION_IDENTITY: phase 1 must preserve the original function OID';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'save_invoice') <> 1
     OR (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
        AND NOT p.proisstrict AND p.prorettype = 'uuid'::regtype AND NOT p.proretset
        AND NOT p.proleakproof AND p.proparallel = 'u'
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        AND pg_get_function_arguments(p.oid) =
          'p_invoice jsonb, p_items jsonb DEFAULT ''[]''::jsonb, p_idempotency_key text DEFAULT NULL::text'
        AND md5(p.prosrc) = '82c68c993dcff32eabd7b70c70f11527'
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[]
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
        AND has_function_privilege('service_role', p.oid, 'EXECUTE')
        FROM pg_proc p WHERE p.oid = v_oid) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'POSTFLIGHT_GENERIC_FIELD_CREATION_CONTRACT: public save_invoice body, signature or access posture drifted';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: phase 1 barrier installed; existing generic creation and committed retries unchanged';
END
$postflight$;
