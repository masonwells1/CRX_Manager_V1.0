-- Vendor-bill accounting-period close follow-up: fail closed unless the
-- internal month-lock helper retains its private SECURITY INVOKER boundary.
--
-- This validation-only migration changes no schema or business rows. The
-- original 20260730114102 migration revoked every API role, but its in-file
-- postflight proved only caller-owner EXECUTE. This additive postflight makes
-- the helper's own ACL an apply-time release gate without editing applied SQL.

SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $vendor_bill_month_lock_helper_acl_postflight$
DECLARE
  v_helper_oid oid;
  v_owner_oid oid;
  v_owner_name text;
  v_security_definer boolean;
  v_search_path_settings text[];
  v_caller_name text;
  v_caller_count integer;
  v_caller_owner_name text;
  v_caller_security_definer boolean;
BEGIN
  SELECT p.oid, p.proowner, owner_role.rolname, p.prosecdef,
         ARRAY(
           SELECT config
             FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS config
            WHERE config LIKE 'search_path=%'
         )
    INTO v_helper_oid, v_owner_oid, v_owner_name, v_security_definer, v_search_path_settings
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = p.proowner
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = '_lock_accounting_months'
     AND pg_catalog.pg_get_function_identity_arguments(p.oid) =
       'p_dates date[], p_exclusive boolean';

  IF v_helper_oid IS NULL
     OR (
       SELECT count(*)
         FROM pg_catalog.pg_proc AS p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname = '_lock_accounting_months'
     ) <> 1 THEN
    RAISE EXCEPTION
      'VENDOR_BILL_MONTH_LOCK_HELPER_SIGNATURE_DRIFT: expected exactly public._lock_accounting_months(date[],boolean)';
  END IF;

  IF v_owner_name IS DISTINCT FROM 'postgres' THEN
    RAISE EXCEPTION
      'VENDOR_BILL_MONTH_LOCK_HELPER_TRUSTED_OWNER_DRIFT: helper owner must be postgres, found %',
      COALESCE(v_owner_name, '<missing>');
  END IF;

  IF v_security_definer
     OR v_search_path_settings IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[] THEN
    RAISE EXCEPTION
      'VENDOR_BILL_MONTH_LOCK_HELPER_SECURITY_DRIFT: helper must remain SECURITY INVOKER with search_path=public, pg_temp';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS p
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
      ) AS acl
     WHERE p.oid = v_helper_oid
       AND acl.privilege_type = 'EXECUTE'
       AND acl.grantee <> v_owner_oid
  ) THEN
    RAISE EXCEPTION
      'VENDOR_BILL_MONTH_LOCK_HELPER_ACL_DRIFT: only postgres may hold EXECUTE';
  END IF;

  IF NOT pg_catalog.has_function_privilege(v_owner_oid, v_helper_oid, 'EXECUTE') THEN
    RAISE EXCEPTION
      'VENDOR_BILL_MONTH_LOCK_HELPER_OWNER_DRIFT: helper owner must retain EXECUTE';
  END IF;

  FOREACH v_caller_name IN ARRAY ARRAY[
    'create_vendor_bill',
    'update_vendor_bill',
    'close_accounting_period'
  ] LOOP
    SELECT count(*), min(owner_role.rolname), bool_and(p.prosecdef)
      INTO v_caller_count, v_caller_owner_name, v_caller_security_definer
      FROM pg_catalog.pg_proc AS p
      JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = p.proowner
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname = v_caller_name;

    IF v_caller_count <> 1
       OR v_caller_owner_name IS DISTINCT FROM 'postgres'
       OR v_caller_security_definer IS DISTINCT FROM true THEN
      RAISE EXCEPTION
        'VENDOR_BILL_MONTH_LOCK_CALLER_TRUSTED_OWNER_DRIFT: public.% must be exactly one postgres-owned SECURITY DEFINER function',
        v_caller_name;
    END IF;
  END LOOP;
END;
$vendor_bill_month_lock_helper_acl_postflight$;
