-- Restrict the quote-version restore owner implementation to its governed wrappers.
--
-- STATUS: NOT APPLIED
-- LOCAL CANDIDATE.
-- Permission-only: this migration changes no function body, table row, RPC
-- signature, or browser contract.
--
-- The public restore_quote_version wrapper already calls check_idempotency()
-- before it delegates, and the idempotency-key INSERT trigger independently
-- rejects cross-operation key reuse. The internal owner implementation still
-- granted EXECUTE directly to service_role, however, which let that role skip
-- both the public wrapper's operation check and the below-cost wrapper. Keep the
-- implementation private to postgres so every application path must enter
-- through the governed wrapper chain. Supabase apply_migration owns the outer
-- transaction, so the ACL change, postcondition, and ledger stamp remain atomic.
-- Do not add BEGIN/COMMIT here: an inner COMMIT can split those three outcomes.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
DECLARE
  v_owner_impl regprocedure := to_regprocedure(
    'public._restore_quote_version_owner_impl(uuid,uuid,uuid,text)'
  );
  v_below_cost_impl regprocedure := to_regprocedure(
    'public._restore_quote_version_below_cost_impl_20260810(uuid,uuid,uuid,text,bigint)'
  );
  v_public_wrapper regprocedure := to_regprocedure(
    'public.restore_quote_version(uuid,uuid,uuid,text,bigint,text)'
  );
  v_check_idempotency regprocedure := to_regprocedure(
    'public.check_idempotency(text,text)'
  );
  v_insert_guard regprocedure := to_regprocedure(
    'public._guard_idempotency_key_insert()'
  );
  v_owner_body text;
  v_owner_acl aclitem[];
  v_owner_secdef boolean;
  v_owner_config text[];
  v_check_body text;
BEGIN
  IF v_owner_impl IS NULL
     OR v_below_cost_impl IS NULL
     OR v_public_wrapper IS NULL
     OR v_check_idempotency IS NULL
     OR v_insert_guard IS NULL THEN
    RAISE EXCEPTION 'RESTORE_OWNER_ACL_DRIFT: expected wrapper chain is incomplete';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(ARRAY['anon', 'authenticated', 'service_role', 'postgres']) AS r(role_name)
    WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.role_name)
  ) THEN
    RAISE EXCEPTION 'RESTORE_OWNER_ACL_DRIFT: expected database roles are missing';
  END IF;

  SELECT p.prosrc, p.proacl, p.prosecdef, p.proconfig
  INTO v_owner_body, v_owner_acl, v_owner_secdef, v_owner_config
  FROM pg_proc p
  WHERE p.oid = v_owner_impl;

  IF md5(v_owner_body) <> 'd8408e3b19b536f1210e51da3970272e'
     OR NOT v_owner_secdef
     OR v_owner_config IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[] THEN
    RAISE EXCEPTION 'RESTORE_OWNER_ACL_DRIFT: owner implementation changed';
  END IF;

  IF NOT has_function_privilege('service_role', v_owner_impl, 'EXECUTE')
     OR has_function_privilege('anon', v_owner_impl, 'EXECUTE')
     OR has_function_privilege('authenticated', v_owner_impl, 'EXECUTE')
     OR NOT has_function_privilege('postgres', v_owner_impl, 'EXECUTE') THEN
    RAISE EXCEPTION 'RESTORE_OWNER_ACL_DRIFT: owner implementation ACL changed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM aclexplode(COALESCE(v_owner_acl, acldefault('f', 'postgres'::regrole))) a
    WHERE a.grantee = 0
      AND a.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'RESTORE_OWNER_ACL_DRIFT: PUBLIC can execute owner implementation';
  END IF;

  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = v_below_cost_impl)
       <> 'd533d681ebc6ceb94338cd6f77220d71'
     OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = v_public_wrapper)
       <> '4fe0225d760b58b88a6874afe75b758a' THEN
    RAISE EXCEPTION 'RESTORE_OWNER_ACL_DRIFT: governed restore wrapper changed';
  END IF;

  SELECT p.prosrc INTO v_check_body
  FROM pg_proc p
  WHERE p.oid = v_check_idempotency;

  IF v_check_body !~ 'pg_advisory_xact_lock'
     OR v_check_body !~ 'IDEMPOTENCY_CROSS_OP_KEY_REUSE'
     OR v_check_body !~ 'v_existing.operation IS DISTINCT FROM p_operation' THEN
    RAISE EXCEPTION 'RESTORE_OWNER_ACL_DRIFT: cross-operation idempotency guard changed';
  END IF;

  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = v_insert_guard)
       <> '712235d2f7d428c885044af57f9fce13'
     OR NOT EXISTS (
       SELECT 1
       FROM pg_trigger t
       WHERE t.tgrelid = 'public.idempotency_keys'::regclass
         AND t.tgname = 'guard_idempotency_key_insert'
         AND t.tgfoid = v_insert_guard
         AND t.tgenabled IN ('O', 'A')
         AND NOT t.tgisinternal
     ) THEN
    RAISE EXCEPTION 'RESTORE_OWNER_ACL_DRIFT: idempotency INSERT guard changed';
  END IF;

  IF has_function_privilege('anon', v_public_wrapper, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_public_wrapper, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_public_wrapper, 'EXECUTE')
     OR has_function_privilege('anon', v_below_cost_impl, 'EXECUTE')
     OR has_function_privilege('authenticated', v_below_cost_impl, 'EXECUTE')
     OR has_function_privilege('service_role', v_below_cost_impl, 'EXECUTE') THEN
    RAISE EXCEPTION 'RESTORE_OWNER_ACL_DRIFT: governed wrapper ACL changed';
  END IF;
END;
$preflight$;

REVOKE ALL ON FUNCTION public._restore_quote_version_owner_impl(uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._restore_quote_version_owner_impl(uuid, uuid, uuid, text)
  TO postgres;

DO $postflight$
DECLARE
  v_owner_impl regprocedure := to_regprocedure(
    'public._restore_quote_version_owner_impl(uuid,uuid,uuid,text)'
  );
  v_below_cost_impl regprocedure := to_regprocedure(
    'public._restore_quote_version_below_cost_impl_20260810(uuid,uuid,uuid,text,bigint)'
  );
  v_public_wrapper regprocedure := to_regprocedure(
    'public.restore_quote_version(uuid,uuid,uuid,text,bigint,text)'
  );
  v_owner_acl aclitem[];
BEGIN
  SELECT p.proacl INTO v_owner_acl
  FROM pg_proc p
  WHERE p.oid = v_owner_impl;

  IF has_function_privilege('anon', v_owner_impl, 'EXECUTE')
     OR has_function_privilege('authenticated', v_owner_impl, 'EXECUTE')
     OR has_function_privilege('service_role', v_owner_impl, 'EXECUTE')
     OR NOT has_function_privilege('postgres', v_owner_impl, 'EXECUTE')
     OR EXISTS (
       SELECT 1
       FROM aclexplode(COALESCE(v_owner_acl, acldefault('f', 'postgres'::regrole))) a
       WHERE a.grantee = 0
         AND a.privilege_type = 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'RESTORE_OWNER_ACL_POSTCONDITION_FAILED: owner implementation is still exposed';
  END IF;

  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = v_owner_impl)
       <> 'd8408e3b19b536f1210e51da3970272e'
     OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = v_below_cost_impl)
       <> 'd533d681ebc6ceb94338cd6f77220d71'
     OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = v_public_wrapper)
       <> '4fe0225d760b58b88a6874afe75b758a'
     OR has_function_privilege('anon', v_public_wrapper, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_public_wrapper, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_public_wrapper, 'EXECUTE')
     OR has_function_privilege('anon', v_below_cost_impl, 'EXECUTE')
     OR has_function_privilege('authenticated', v_below_cost_impl, 'EXECUTE')
     OR has_function_privilege('service_role', v_below_cost_impl, 'EXECUTE') THEN
    RAISE EXCEPTION 'RESTORE_OWNER_ACL_POSTCONDITION_FAILED: wrapper chain changed';
  END IF;
END;
$postflight$;
