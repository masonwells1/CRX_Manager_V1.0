-- 20260908190000_field_app_invoice_cross_season_edit_guard.sql
-- STATUS: NOT APPLIED
--
-- ordering-guard: ahead-of-pending The unapplied 20260905 commission and invoice-number
-- candidates already sort below live's authored high-water 20260908120000 (verified read-only
-- on 2026-09-12) and require their own forward renumber before apply. This PR #599 follow-up is independent and does not make
-- those older candidates any less applicable than they already are.
--
-- Field-application invoices keep the season they were filed under. A date edit may
-- move within that season, but it may not cross the October 1 boundary: doing so would
-- leave the header date in one year-end season while application-service pricing and
-- reporting continue to use another. This forward-only guard closes that disagreement
-- without re-seasoning historical invoices.
--
-- The save path is protected at the invoices table so every writer is covered. The
-- preview path keeps its public signature but delegates through a checked wrapper. The
-- reviewed 20260906120000 preview implementation remains byte-identical behind a private,
-- owner-only name; this migration does not retype its money calculations.

-- Drain current invoice writers before installing the guard. A writer either commits under
-- the old contract before this lock is granted or resumes after commit with the trigger live.
SET LOCAL lock_timeout = '10s';
LOCK TABLE public.invoices IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_public_oid oid;
  v_private_oid oid;
  v_assert_oid oid;
  v_guard_oid oid;
  v_public_md5 text;
  v_private_md5 text;
  v_public_args text;
  v_public_grantees text[];
  v_private_grantees text[];
  v_assert_grantees text[];
  v_guard_grantees text[];
  v_private_count integer;
  v_assert_count integer;
  v_guard_count integer;
  v_trigger_def text;
  v_trigger_enabled "char";
BEGIN
  SELECT p.oid, md5(p.prosrc), pg_get_function_arguments(p.oid)
    INTO v_public_oid, v_public_md5, v_public_args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'preview_field_app_invoice_split';

  IF v_public_oid IS NULL OR (
    SELECT count(*)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'preview_field_app_invoice_split'
  ) <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_PREVIEW_OVERLOAD: expected exactly one public.preview_field_app_invoice_split function';
  END IF;

  IF (SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' FROM pg_proc p WHERE p.oid = v_public_oid)
       <> 'preview_field_app_invoice_split(p_locations jsonb, p_chemicals jsonb, p_application_service_id uuid, p_invoice_id uuid, p_invoice_date date)'
     OR v_public_args <> 'p_locations jsonb, p_chemicals jsonb, p_application_service_id uuid DEFAULT NULL::uuid, p_invoice_id uuid DEFAULT NULL::uuid, p_invoice_date date DEFAULT NULL::date'
     OR NOT (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 's'
                    AND NOT p.proisstrict AND p.prorettype = 'jsonb'::regtype AND NOT p.proretset
                    AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
               FROM pg_proc p WHERE p.oid = v_public_oid) THEN
    RAISE EXCEPTION 'PREFLIGHT_PREVIEW_CONTRACT: preview identity, defaults, owner, security, volatility, return shape, or search_path drifted';
  END IF;

  SELECT ARRAY(
    SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
      FROM pg_proc p, aclexplode(p.proacl) a
     WHERE p.oid = v_public_oid AND a.privilege_type = 'EXECUTE'
     ORDER BY 1
  ) INTO v_public_grantees;

  IF v_public_grantees IS DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[]
     OR has_function_privilege('anon', v_public_oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_public_oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_public_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'PREFLIGHT_PREVIEW_ACL_DRIFT: preview EXECUTE posture is %, expected {authenticated,postgres,service_role}', v_public_grantees;
  END IF;

  SELECT count(*) INTO v_private_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_preview_field_app_invoice_split_impl_20260908';
  SELECT count(*) INTO v_assert_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_assert_field_app_invoice_date_in_filed_season';
  SELECT count(*) INTO v_guard_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'guard_field_app_invoice_season_date';

  SELECT p.oid, md5(p.prosrc)
    INTO v_private_oid, v_private_md5
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = '_preview_field_app_invoice_split_impl_20260908';

  SELECT pg_get_triggerdef(t.oid), t.tgenabled
    INTO v_trigger_def, v_trigger_enabled
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.invoices'::regclass
     AND t.tgname = 'aa_guard_field_app_invoice_season_date'
     AND NOT t.tgisinternal;

  IF v_private_oid IS NULL THEN
    -- First apply: pin the exact live body and access surface reviewed on 2026-09-08.
    IF v_private_count <> 0 OR v_assert_count <> 0 OR v_guard_count <> 0 OR v_trigger_def IS NOT NULL THEN
      RAISE EXCEPTION 'PREFLIGHT_INSTALL_COLLISION: private/helper/trigger names already exist without the reviewed replay identity';
    END IF;
    IF v_public_md5 <> '83f6600412ced085d0876a3c7339ff12' THEN
      RAISE EXCEPTION 'PREFLIGHT_PREVIEW_BODY_DRIFT: live preview body md5 is %, expected 83f6600412ced085d0876a3c7339ff12', v_public_md5;
    END IF;
  ELSE
    -- Replay must match the complete state this file previously installed BEFORE any
    -- CREATE OR REPLACE or ACL statement can erase evidence of another lane's change.
    IF v_private_count <> 1 OR v_assert_count <> 1 OR v_guard_count <> 1 OR v_trigger_def IS NULL THEN
      RAISE EXCEPTION 'PREFLIGHT_REPLAY_SHAPE_DRIFT: expected one private implementation, assertion, guard function, and trigger; found %, %, %, trigger=%', v_private_count, v_assert_count, v_guard_count, v_trigger_def IS NOT NULL;
    END IF;

    v_assert_oid := to_regprocedure('public._assert_field_app_invoice_date_in_filed_season(uuid,date)');
    v_guard_oid := to_regprocedure('public.guard_field_app_invoice_season_date()');

    IF v_public_md5 <> '294b3e1aac90fe785159b181386cc2d9' THEN
      RAISE EXCEPTION 'PREFLIGHT_WRAPPER_BODY_DRIFT: public preview wrapper md5 is %, expected 294b3e1aac90fe785159b181386cc2d9', v_public_md5;
    END IF;
    IF (SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' FROM pg_proc p WHERE p.oid = v_private_oid)
         <> '_preview_field_app_invoice_split_impl_20260908(p_locations jsonb, p_chemicals jsonb, p_application_service_id uuid, p_invoice_id uuid, p_invoice_date date)'
       OR v_private_md5 <> '83f6600412ced085d0876a3c7339ff12'
       OR NOT (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 's'
                      AND NOT p.proisstrict AND p.prorettype = 'jsonb'::regtype AND NOT p.proretset
                      AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
                 FROM pg_proc p WHERE p.oid = v_private_oid) THEN
      RAISE EXCEPTION 'PREFLIGHT_PRIVATE_CONTRACT_DRIFT: private preview identity, body, owner, security, volatility, return shape, or search_path drifted';
    END IF;
    IF v_assert_oid IS NULL
       OR NOT (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 's'
                      AND NOT p.proisstrict AND p.prorettype = 'void'::regtype AND NOT p.proretset
                      AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
                      AND md5(p.prosrc) = '2a4a3b079b4f18d07730fc1aa11eae96'
                 FROM pg_proc p WHERE p.oid = v_assert_oid) THEN
      RAISE EXCEPTION 'PREFLIGHT_ASSERT_CONTRACT_DRIFT: private assertion identity, body, owner, security, volatility, return shape, or search_path drifted';
    END IF;
    IF v_guard_oid IS NULL
       OR NOT (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
                      AND NOT p.proisstrict AND p.prorettype = 'trigger'::regtype AND NOT p.proretset
                      AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
                      AND md5(p.prosrc) = '5544c40616425704bd65431bdf7dd29e'
                 FROM pg_proc p WHERE p.oid = v_guard_oid) THEN
      RAISE EXCEPTION 'PREFLIGHT_TRIGGER_FUNCTION_DRIFT: trigger function identity, body, owner, security, volatility, return shape, or search_path drifted';
    END IF;

    SELECT ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
      FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = v_private_oid AND a.privilege_type = 'EXECUTE' ORDER BY 1) INTO v_private_grantees;
    SELECT ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
      FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = v_assert_oid AND a.privilege_type = 'EXECUTE' ORDER BY 1) INTO v_assert_grantees;
    SELECT ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
      FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = v_guard_oid AND a.privilege_type = 'EXECUTE' ORDER BY 1) INTO v_guard_grantees;
    IF v_private_grantees IS DISTINCT FROM ARRAY['postgres']::text[]
       OR v_assert_grantees IS DISTINCT FROM ARRAY['postgres']::text[]
       OR v_guard_grantees IS DISTINCT FROM ARRAY['postgres']::text[] THEN
      RAISE EXCEPTION 'PREFLIGHT_PRIVATE_ACL_DRIFT: expected owner-only EXECUTE, found private=%, assertion=%, guard=%', v_private_grantees, v_assert_grantees, v_guard_grantees;
    END IF;

    IF v_trigger_enabled <> 'O'
       OR v_trigger_def <> 'CREATE TRIGGER aa_guard_field_app_invoice_season_date BEFORE UPDATE OF invoice_date, season, invoice_type, deleted_at ON public.invoices FOR EACH ROW EXECUTE FUNCTION guard_field_app_invoice_season_date()' THEN
      RAISE EXCEPTION 'PREFLIGHT_TRIGGER_DRIFT: guard trigger definition or enabled state drifted: %, tgenabled=%', v_trigger_def, v_trigger_enabled;
    END IF;
  END IF;
END
$preflight$;

-- Preserve the reviewed pricing implementation on first apply. ALTER FUNCTION keeps its
-- OID and dependencies. Dynamic SQL makes the migration replay-safe after the rename.
DO $rename_preview$
BEGIN
  IF to_regprocedure('public._preview_field_app_invoice_split_impl_20260908(jsonb,jsonb,uuid,uuid,date)') IS NULL THEN
    EXECUTE 'ALTER FUNCTION public.preview_field_app_invoice_split(jsonb,jsonb,uuid,uuid,date) RENAME TO _preview_field_app_invoice_split_impl_20260908';
  END IF;
END
$rename_preview$;

ALTER FUNCTION public._preview_field_app_invoice_split_impl_20260908(jsonb, jsonb, uuid, uuid, date) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._preview_field_app_invoice_split_impl_20260908(jsonb, jsonb, uuid, uuid, date)
  FROM PUBLIC, anon, authenticated, service_role;

-- Shared private assertion used by both the preview wrapper and the table trigger. It is
-- SECURITY DEFINER because an allowed direct table writer can see only part of a split group
-- through RLS; the invariant must inspect every live member or fail closed.
CREATE OR REPLACE FUNCTION public._assert_field_app_invoice_date_in_filed_season(
  p_invoice_id uuid,
  p_invoice_date date
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_group_id uuid;
  v_filed_season integer;
BEGIN
  IF p_invoice_id IS NULL OR p_invoice_date IS NULL THEN
    RETURN;
  END IF;

  SELECT i.invoice_group_id
    INTO v_group_id
    FROM public.invoices i
   WHERE i.id = p_invoice_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT i.season
    INTO v_filed_season
    FROM public.invoices i
   WHERE i.invoice_type = 'field_application'
     AND i.deleted_at IS NULL
     AND (i.id = p_invoice_id OR (v_group_id IS NOT NULL AND i.invoice_group_id = v_group_id))
     AND public.compute_season(p_invoice_date) IS DISTINCT FROM i.season
   ORDER BY i.id
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'INVOICE_SEASON_DATE_CHANGE_NOT_ALLOWED: this invoice is filed in season %, so its transaction date must stay between % and %',
      v_filed_season,
      make_date(v_filed_season - 1, 10, 1),
      make_date(v_filed_season, 9, 30)
      USING ERRCODE = 'check_violation';
  END IF;
END
$function$;

ALTER FUNCTION public._assert_field_app_invoice_date_in_filed_season(uuid, date) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._assert_field_app_invoice_date_in_filed_season(uuid, date)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.guard_field_app_invoice_season_date()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF OLD.invoice_type = 'field_application' OR NEW.invoice_type = 'field_application' THEN
    IF NEW.season IS DISTINCT FROM OLD.season THEN
      RAISE EXCEPTION
        'INVOICE_FILED_SEASON_CHANGE_NOT_ALLOWED: field-application invoice % is permanently filed in season %',
        OLD.id,
        OLD.season
        USING ERRCODE = 'check_violation';
    END IF;

    -- Validate NEW directly: a soft-deleted OLD row is excluded by the group helper.
    IF NEW.invoice_date IS DISTINCT FROM OLD.invoice_date
       OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL)
       OR NEW.invoice_type IS DISTINCT FROM OLD.invoice_type THEN
      IF public.compute_season(NEW.invoice_date) IS DISTINCT FROM NEW.season THEN
        RAISE EXCEPTION
          'INVOICE_SEASON_DATE_CHANGE_NOT_ALLOWED: this invoice is filed in season %, so its transaction date must stay between % and %',
          NEW.season,
          make_date(NEW.season - 1, 10, 1),
          make_date(NEW.season, 9, 30)
          USING ERRCODE = 'check_violation';
      END IF;
      PERFORM public._assert_field_app_invoice_date_in_filed_season(OLD.id, NEW.invoice_date);
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.guard_field_app_invoice_season_date() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_field_app_invoice_season_date()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS aa_guard_field_app_invoice_season_date ON public.invoices;
CREATE TRIGGER aa_guard_field_app_invoice_season_date
BEFORE UPDATE OF invoice_date, season, invoice_type, deleted_at ON public.invoices
FOR EACH ROW EXECUTE FUNCTION public.guard_field_app_invoice_season_date();

-- Same public identity and defaults as before, now refusing an invalid existing-invoice
-- date before the private pricing implementation can show a misleading preview.
CREATE OR REPLACE FUNCTION public.preview_field_app_invoice_split(
  p_locations jsonb,
  p_chemicals jsonb,
  p_application_service_id uuid DEFAULT NULL::uuid,
  p_invoice_id uuid DEFAULT NULL::uuid,
  p_invoice_date date DEFAULT NULL::date
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: only admins or sales reps can preview field-app invoice splits'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM public._assert_field_app_invoice_date_in_filed_season(p_invoice_id, p_invoice_date);

  RETURN public._preview_field_app_invoice_split_impl_20260908(
    p_locations,
    p_chemicals,
    p_application_service_id,
    p_invoice_id,
    p_invoice_date
  );
END
$function$;

ALTER FUNCTION public.preview_field_app_invoice_split(jsonb, jsonb, uuid, uuid, date) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.preview_field_app_invoice_split(jsonb, jsonb, uuid, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_field_app_invoice_split(jsonb, jsonb, uuid, uuid, date) TO authenticated, service_role;

DO $postflight$
DECLARE
  v_public_oid oid;
  v_private_oid oid;
  v_assert_oid oid;
  v_guard_oid oid;
  v_trigger_oid oid;
  v_public_grantees text[];
  v_private_grantees text[];
  v_assert_grantees text[];
  v_guard_grantees text[];
  v_trigger_def text;
  v_trigger_enabled "char";
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'preview_field_app_invoice_split') <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_PREVIEW_OVERLOAD: expected exactly one public preview signature';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = '_preview_field_app_invoice_split_impl_20260908') <> 1
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = '_assert_field_app_invoice_date_in_filed_season') <> 1
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'guard_field_app_invoice_season_date') <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_PRIVATE_OVERLOAD: expected exactly one private implementation, assertion, and trigger function';
  END IF;

  SELECT p.oid INTO v_public_oid
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'preview_field_app_invoice_split';
  SELECT p.oid INTO v_private_oid
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_preview_field_app_invoice_split_impl_20260908';
  SELECT p.oid INTO v_assert_oid
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_assert_field_app_invoice_date_in_filed_season';
  SELECT p.oid INTO v_guard_oid
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'guard_field_app_invoice_season_date';

  IF v_public_oid IS NULL
     OR (SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' FROM pg_proc p WHERE p.oid = v_public_oid)
          <> 'preview_field_app_invoice_split(p_locations jsonb, p_chemicals jsonb, p_application_service_id uuid, p_invoice_id uuid, p_invoice_date date)'
     OR pg_get_function_arguments(v_public_oid) <> 'p_locations jsonb, p_chemicals jsonb, p_application_service_id uuid DEFAULT NULL::uuid, p_invoice_id uuid DEFAULT NULL::uuid, p_invoice_date date DEFAULT NULL::date'
     OR NOT (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 's' AND NOT p.proisstrict
                    AND p.prorettype = 'jsonb'::regtype AND NOT p.proretset
                    AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
                    AND md5(p.prosrc) = '294b3e1aac90fe785159b181386cc2d9'
               FROM pg_proc p WHERE p.oid = v_public_oid) THEN
    RAISE EXCEPTION 'POSTFLIGHT_PREVIEW_CONTRACT: public preview wrapper identity, defaults, owner, security, volatility, return shape, search_path, or body drifted';
  END IF;

  IF v_private_oid IS NULL
     OR (SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' FROM pg_proc p WHERE p.oid = v_private_oid)
          <> '_preview_field_app_invoice_split_impl_20260908(p_locations jsonb, p_chemicals jsonb, p_application_service_id uuid, p_invoice_id uuid, p_invoice_date date)'
     OR NOT (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 's' AND NOT p.proisstrict
                    AND p.prorettype = 'jsonb'::regtype AND NOT p.proretset
                    AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
                    AND md5(p.prosrc) = '83f6600412ced085d0876a3c7339ff12'
               FROM pg_proc p WHERE p.oid = v_private_oid) THEN
    RAISE EXCEPTION 'POSTFLIGHT_PRIVATE_CONTRACT: private preview identity, body, owner, security, volatility, return shape, or search_path drifted';
  END IF;

  IF v_assert_oid IS NULL
     OR (SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' FROM pg_proc p WHERE p.oid = v_assert_oid)
          <> '_assert_field_app_invoice_date_in_filed_season(p_invoice_id uuid, p_invoice_date date)'
     OR NOT (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 's' AND NOT p.proisstrict
                    AND p.prorettype = 'void'::regtype AND NOT p.proretset
                    AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
                    AND md5(p.prosrc) = '2a4a3b079b4f18d07730fc1aa11eae96'
               FROM pg_proc p WHERE p.oid = v_assert_oid) THEN
    RAISE EXCEPTION 'POSTFLIGHT_ASSERT_CONTRACT: season assertion identity, owner, security, volatility, search_path, or body drifted';
  END IF;

  IF v_guard_oid IS NULL
     OR (SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' FROM pg_proc p WHERE p.oid = v_guard_oid)
          <> 'guard_field_app_invoice_season_date()'
     OR NOT (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v' AND NOT p.proisstrict
                    AND p.prorettype = 'trigger'::regtype AND NOT p.proretset
                    AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
                    AND md5(p.prosrc) = '5544c40616425704bd65431bdf7dd29e'
               FROM pg_proc p WHERE p.oid = v_guard_oid) THEN
    RAISE EXCEPTION 'POSTFLIGHT_TRIGGER_FUNCTION: invoice-date trigger function contract drifted';
  END IF;

  SELECT t.oid, pg_get_triggerdef(t.oid), t.tgenabled
    INTO v_trigger_oid, v_trigger_def, v_trigger_enabled
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.invoices'::regclass
     AND t.tgname = 'aa_guard_field_app_invoice_season_date'
     AND NOT t.tgisinternal;
  IF v_trigger_oid IS NULL
     OR v_trigger_enabled <> 'O'
     OR v_trigger_def <> 'CREATE TRIGGER aa_guard_field_app_invoice_season_date BEFORE UPDATE OF invoice_date, season, invoice_type, deleted_at ON public.invoices FOR EACH ROW EXECUTE FUNCTION guard_field_app_invoice_season_date()' THEN
    RAISE EXCEPTION 'POSTFLIGHT_TRIGGER: expected the enabled BEFORE UPDATE OF invoice_date row trigger, found %, tgenabled=%', COALESCE(v_trigger_def, '<missing>'), COALESCE(v_trigger_enabled::text, '<missing>');
  END IF;

  SELECT ARRAY(
    SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
      FROM pg_proc p, aclexplode(p.proacl) a
     WHERE p.oid = v_public_oid AND a.privilege_type = 'EXECUTE'
     ORDER BY 1
  ) INTO v_public_grantees;
  IF v_public_grantees IS DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[]
     OR has_function_privilege('anon', v_public_oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_public_oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_public_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_PREVIEW_ACL: public preview EXECUTE posture drifted: %', v_public_grantees;
  END IF;

  SELECT ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
    FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = v_private_oid AND a.privilege_type = 'EXECUTE' ORDER BY 1) INTO v_private_grantees;
  SELECT ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
    FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = v_assert_oid AND a.privilege_type = 'EXECUTE' ORDER BY 1) INTO v_assert_grantees;
  SELECT ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
    FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = v_guard_oid AND a.privilege_type = 'EXECUTE' ORDER BY 1) INTO v_guard_grantees;
  IF v_private_grantees IS DISTINCT FROM ARRAY['postgres']::text[]
     OR v_assert_grantees IS DISTINCT FROM ARRAY['postgres']::text[]
     OR v_guard_grantees IS DISTINCT FROM ARRAY['postgres']::text[] THEN
    RAISE EXCEPTION 'POSTFLIGHT_PRIVATE_ACL: expected owner-only EXECUTE, found private=%, assertion=%, guard=%', v_private_grantees, v_assert_grantees, v_guard_grantees;
  END IF;

  RAISE NOTICE 'POSTFLIGHT_OK: cross-season field-app date edits are blocked at preview and table-write boundaries; public preview signature and grants preserved';
END
$postflight$;
