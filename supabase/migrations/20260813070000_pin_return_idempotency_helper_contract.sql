-- Forward-only closeout for the shared helper contract used by all six return
-- idempotency wrappers. The already-applied 20260812130145 migration is
-- immutable, so this migration fails closed unless the helper it depended on
-- is still the exact reviewed implementation and catalog shape.
--
-- This changes no business rows and no function body. The sibling durable
-- return-credit-intent-binding predicate keeps checking the same contract after
-- apply so later drift cannot silently weaken actor/payload binding.
-- Apply-time ledger preflight: Supabase MCP list_migrations read on 2026-08-12
-- immediately before the governed apply attempt returned live high-water
-- 20260812212323, strictly below this file's 20260813070000 timestamp. The
-- companion migration-history row is added in the same branch change.

DO $assert_helper_contract$
DECLARE
  v_helper regprocedure := to_regprocedure('public.check_idempotency_intent(text,text,uuid,text)');
  v_expected_sha256 constant text := '71b8a6a0b53f2234a0808b1270eaa06b3c8bf0e7d2523fc429c88e5c479407c8';
BEGIN
  IF (SELECT count(*) FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname = 'check_idempotency_intent') <> 1 THEN
    RAISE EXCEPTION 'check_idempotency_intent must have exactly one public overload';
  END IF;

  IF v_helper IS NULL OR NOT EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid = v_helper
       AND encode(sha256(convert_to(replace(p.prosrc, E'\r\n', E'\n'), 'UTF8')), 'hex') = v_expected_sha256
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef
       AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'check_idempotency_intent exact body/owner/security/search_path/grant contract drifted';
  END IF;
END
$assert_helper_contract$;
