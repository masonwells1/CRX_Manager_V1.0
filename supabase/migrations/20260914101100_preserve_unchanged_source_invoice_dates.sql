-- Preserve an existing field invoice's unchanged stored date, including legitimate
-- prior-season job/blend creation. This is not a date edit or a re-seasoning.
-- Actual disposable public preview regressions failed for BOTH creators under the
-- September 8 guard. Date changes still must land inside the immutable filed season.
-- Apply AFTER 20260914101000; keep the earlier migration and cutover phases intact.
-- ORDERING: strict, and this file was RESTAMPED from 20260913152700 to 20260911130000 on
-- 2026-09-20 so its stamp finally matches the line above, then to 20260914101100 on
-- 2026-09-21 together with the other three (see the season guard's header: the eight
-- 20260914100* commission migrations apply live FIRST, and none of the four may apply
-- before all eight have). At the old stamp it sorted AFTER
-- both cutover phases, and phase 2 (20260914101300) deliberately aborts at
-- GENERIC_FIELD_CUTOVER_ACTIVE_RECEIPTS or GENERIC_FIELD_CUTOVER_NOT_QUIET rather than
-- cutting over while generic save receipts or other transactions are live. Under strict
-- ordering this correction could not step around that block, so ordinary generic-invoice
-- activity could have stranded production in exactly the broken state this file exists to
-- fix - the September 8 guard rejecting unchanged-date previews for legitimate prior-season
-- job/blend invoices - for the receipt lifetime or longer. The new stamp needs only the two
-- guard identities created by 20260914101000 and nothing from either cutover phase, and it
-- sorts above the live-applied 20260911120000. Apply order is now:
-- 20260914101000, THIS FILE, 20260914101200 (phase 1), 20260914101300 (phase 2).
-- No business-row backfill, deletion, new grant, table, column, or pricing change.
-- The owner-only SECURITY DEFINER assertion still inspects all live group members
-- through RLS for the preview, and the row trigger still protects every table writer by
-- validating the written row against its OWN filed season (never another member's).

-- Pin the migration session's search_path BEFORE any check runs, for the same reason as
-- 20260914101000: pg_get_triggerdef() schema-qualifies the trigger's function when public is
-- not visible, so this file's preflight and postflight trigger comparisons would reject a
-- valid trigger and abort the apply. Fail-closed, but it strands the apply. Verified on
-- PostgreSQL 17.
SET LOCAL search_path = public, pg_temp;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '60s';
LOCK TABLE public.invoices IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_assert pg_proc;
  v_guard pg_proc;
BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
      AND proname = '_assert_field_app_invoice_date_in_filed_season') <> 1
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
      AND proname = 'guard_field_app_invoice_season_date') <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_UNCHANGED_DATE_SHAPE: expected the two existing guard identities without overloads';
  END IF;
  SELECT * INTO v_assert FROM pg_proc
    WHERE oid = to_regprocedure('public._assert_field_app_invoice_date_in_filed_season(uuid,date)');
  SELECT * INTO v_guard FROM pg_proc
    WHERE oid = to_regprocedure('public.guard_field_app_invoice_season_date()');
  IF v_assert.oid IS NULL OR v_guard.oid IS NULL
     OR v_assert.proargnames IS DISTINCT FROM ARRAY['p_invoice_id', 'p_invoice_date']::text[]
     OR v_assert.pronargdefaults <> 0 OR v_guard.pronargdefaults <> 0
     OR v_assert.prorettype <> 'void'::regtype OR v_guard.prorettype <> 'trigger'::regtype
     OR v_assert.proowner <> 'postgres'::regrole OR v_guard.proowner <> 'postgres'::regrole
     OR NOT v_assert.prosecdef OR NOT v_guard.prosecdef
     OR v_assert.provolatile <> 's' OR v_guard.provolatile <> 'v'
     OR v_assert.proisstrict OR v_guard.proisstrict OR v_assert.proretset OR v_guard.proretset
     OR v_assert.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR v_guard.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[] THEN
    RAISE EXCEPTION 'PREFLIGHT_UNCHANGED_DATE_CONTRACT: identity, defaults, owner, return shape, security, volatility, or search path drift';
  END IF;
  IF (md5(v_assert.prosrc), md5(v_guard.prosrc)) NOT IN (
      ('2a4a3b079b4f18d07730fc1aa11eae96', 'd8c4bbd4517c5986807d7eca058260b6'),
      ('1a6d088f4696f2429c034e0f178d4e94', '0005b29c0b10e26efed981ce6cdaf18d')) THEN
    RAISE EXCEPTION 'PREFLIGHT_UNCHANGED_DATE_BODY: unknown or partially installed guard pair';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p,
      aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
      WHERE p.oid IN (v_assert.oid, v_guard.oid) AND a.grantee <> 'postgres'::regrole) THEN
    RAISE EXCEPTION 'PREFLIGHT_UNCHANGED_DATE_ACL: both guard functions must remain owner-only';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
      WHERE t.tgrelid = 'public.invoices'::regclass
      AND t.tgname = 'aa_guard_field_app_invoice_season_date' AND NOT t.tgisinternal
      AND t.tgenabled = 'O' AND t.tgfoid = v_guard.oid
      AND pg_get_triggerdef(t.oid) = 'CREATE TRIGGER aa_guard_field_app_invoice_season_date BEFORE UPDATE OF invoice_date, season, invoice_type, deleted_at ON public.invoices FOR EACH ROW EXECUTE FUNCTION guard_field_app_invoice_season_date()') THEN
    RAISE EXCEPTION 'PREFLIGHT_UNCHANGED_DATE_TRIGGER: expected the enabled original row trigger';
  END IF;
END
$preflight$;

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
  SELECT i.invoice_group_id INTO v_group_id FROM public.invoices i WHERE i.id = p_invoice_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT i.season INTO v_filed_season
    FROM public.invoices i
   WHERE i.invoice_type = 'field_application' AND i.deleted_at IS NULL
     AND (i.id = p_invoice_id OR (v_group_id IS NOT NULL AND i.invoice_group_id = v_group_id))
     -- Preserve each member's own stored date; never use another member's season.
     AND p_invoice_date IS DISTINCT FROM i.invoice_date
     AND public.compute_season(p_invoice_date) IS DISTINCT FROM i.season
   ORDER BY i.id LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'INVOICE_SEASON_DATE_CHANGE_NOT_ALLOWED: this invoice is filed in season %, so its transaction date must stay between % and %',
      v_filed_season, make_date(v_filed_season - 1, 10, 1), make_date(v_filed_season, 9, 30)
      USING ERRCODE = 'check_violation';
  END IF;
END
$function$;

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
        OLD.id, OLD.season USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.invoice_date IS DISTINCT FROM OLD.invoice_date
       OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL)
       OR NEW.invoice_type IS DISTINCT FROM OLD.invoice_type THEN
      -- An unchanged-date restore preserves the original invoice, not a new date.
      -- A restore PLUS date/type change still checks NEW directly while OLD is deleted.
      IF (NEW.invoice_date IS DISTINCT FROM OLD.invoice_date
          OR NEW.invoice_type IS DISTINCT FROM OLD.invoice_type)
         AND public.compute_season(NEW.invoice_date) IS DISTINCT FROM NEW.season THEN
        RAISE EXCEPTION
          'INVOICE_SEASON_DATE_CHANGE_NOT_ALLOWED: this invoice is filed in season %, so its transaction date must stay between % and %',
          NEW.season, make_date(NEW.season - 1, 10, 1), make_date(NEW.season, 9, 30)
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

-- Restate the unchanged private contract; no new executable RPC or grant is added.
ALTER FUNCTION public._assert_field_app_invoice_date_in_filed_season(uuid, date) OWNER TO postgres;
ALTER FUNCTION public.guard_field_app_invoice_season_date() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._assert_field_app_invoice_date_in_filed_season(uuid, date)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_field_app_invoice_season_date()
  FROM PUBLIC, anon, authenticated, service_role;

DO $postflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
      WHERE p.oid = 'public._assert_field_app_invoice_date_in_filed_season(uuid,date)'::regprocedure
      AND md5(p.prosrc) = '1a6d088f4696f2429c034e0f178d4e94' AND p.prosecdef AND p.provolatile = 's'
      AND p.proowner = 'postgres'::regrole AND p.prorettype = 'void'::regtype
      AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[])
     OR NOT EXISTS (SELECT 1 FROM pg_proc p
      WHERE p.oid = 'public.guard_field_app_invoice_season_date()'::regprocedure
      AND md5(p.prosrc) = '0005b29c0b10e26efed981ce6cdaf18d' AND p.prosecdef AND p.provolatile = 'v'
      AND p.proowner = 'postgres'::regrole AND p.prorettype = 'trigger'::regtype
      AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]) THEN
    RAISE EXCEPTION 'POSTFLIGHT_UNCHANGED_DATE_BODY: corrected guard contract drift';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p,
      aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
      WHERE p.oid IN ('public._assert_field_app_invoice_date_in_filed_season(uuid,date)'::regprocedure,
        'public.guard_field_app_invoice_season_date()'::regprocedure)
      AND a.grantee <> 'postgres'::regrole) THEN
    RAISE EXCEPTION 'POSTFLIGHT_UNCHANGED_DATE_ACL: corrected functions must remain owner-only';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.invoices'::regclass
      AND t.tgname = 'aa_guard_field_app_invoice_season_date' AND NOT t.tgisinternal
      AND t.tgenabled = 'O' AND t.tgfoid = 'public.guard_field_app_invoice_season_date()'::regprocedure
      AND pg_get_triggerdef(t.oid) = 'CREATE TRIGGER aa_guard_field_app_invoice_season_date BEFORE UPDATE OF invoice_date, season, invoice_type, deleted_at ON public.invoices FOR EACH ROW EXECUTE FUNCTION guard_field_app_invoice_season_date()') THEN
    RAISE EXCEPTION 'POSTFLIGHT_UNCHANGED_DATE_TRIGGER: original enabled trigger drift';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_UNCHANGED_DATE_OK: original dates and filed seasons preserved; new out-of-season date edits refused';
END
$postflight$;
