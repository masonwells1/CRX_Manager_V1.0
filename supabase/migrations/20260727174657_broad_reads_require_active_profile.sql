-- Broad "any logged-in user" SELECT policies must require an ACTIVE profile.
--
-- Companion to 20260727145843_inline_role_checks_require_active_profile, which
-- closed the 38 policies that inlined a profiles.role check without also
-- requiring profiles.is_active = true.
--
-- Residual gap that migration deliberately left out of scope: 31 PERMISSIVE
-- SELECT policies gate on nothing but "you are logged in" -- 30 with USING
-- (true) granted to `authenticated`, plus application_record_fields.arf_select
-- granted to PUBLIC with USING (auth.uid() IS NOT NULL). PERMISSIVE policies
-- OR together, so on every table below a deactivated user holding a still-valid
-- JWT keeps full read access regardless of the role tightening already applied.
-- Six of these tables (application_services, application_record_fields,
-- customer_application_rates, quote_pdf_templates, quote_templates,
-- team_note_attachments) directly defeat that migration; the remaining 25
-- expose independent business data (products, customer_addresses, team_notes,
-- quote_items, applicator_licenses, ...).
--
-- This migration does NOT narrow read access by role. Every ACTIVE user reads
-- exactly what they read before. The only behavioural change is that a
-- deactivated profile now reads nothing. Deciding which roles *should* see each
-- table remains a separate, deliberate product decision.
--
-- ALTER POLICY (never DROP + CREATE) preserves command, roles, permissiveness,
-- and WITH CHECK shape -- same convention as 20260726223520 and 20260727145843.

BEGIN;

-- Active-profile predicate, modelled exactly on the existing is_admin() /
-- is_sales_rep() / is_driver() / is_applicator() helpers: SECURITY DEFINER so
-- it is not itself subject to profiles RLS, STABLE, pinned search_path.
CREATE OR REPLACE FUNCTION public.is_active_profile()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.profiles
     WHERE id = (SELECT auth.uid())
       AND is_active = true
  )
$function$;

COMMENT ON FUNCTION public.is_active_profile() IS
  'True when the calling JWT maps to a profiles row with is_active = true. Role-agnostic active-account gate for broad read policies.';

-- CREATE FUNCTION grants EXECUTE to PUBLIC by default, which would hand every
-- role -- including anon -- a SECURITY DEFINER function that reads profiles.
-- Revoke that default and grant deliberately, matching is_sales_rep()'s ACL
-- (authenticated + service_role; no PUBLIC, no anon).
--
-- `FROM PUBLIC` alone is NOT enough here, proven live 2026-07-27: this project
-- carries ALTER DEFAULT PRIVILEGES for role postgres in schema public granting
-- EXECUTE on new functions to anon, authenticated and service_role. A freshly
-- created function therefore lands with acl
--   {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
-- and revoking only PUBLIC drops the leading "=X/" entry while leaving the
-- explicit anon grant intact (has_function_privilege('anon', ...) stays true).
-- anon must be named explicitly. The first apply attempt of this migration was
-- correctly rejected by postflight check 1c for exactly this reason.
REVOKE ALL ON FUNCTION public.is_active_profile() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_active_profile() TO authenticated, service_role;

-- The predicate is wrapped in a scalar sub-select so PostgreSQL evaluates it
-- once per statement as an InitPlan rather than once per candidate row.

ALTER POLICY "activity_select" ON public.activity_feed
  USING ((SELECT public.is_active_profile()));
ALTER POLICY "settings_select" ON public.app_settings
  USING ((SELECT public.is_active_profile()));
-- arf_select is the one policy here granted to PUBLIC rather than `authenticated`,
-- so anon can reach it (anon holds table-level SELECT on this table). It therefore
-- uses the inline EXISTS form already used by its three sibling policies
-- (arf_insert / arf_update / arf_delete) instead of the helper, so no EXECUTE
-- grant to anon is needed. Behaviour for anon is unchanged: auth.uid() is NULL,
-- nothing matches, zero rows.
ALTER POLICY "arf_select" ON public.application_record_fields
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE p.id = (SELECT auth.uid())
       AND p.is_active = true
  ));
ALTER POLICY "application_services_select" ON public.application_services
  USING ((SELECT public.is_active_profile()));
ALTER POLICY "applicator_licenses_select" ON public.applicator_licenses
  USING ((SELECT public.is_active_profile()));
ALTER POLICY "blend_recipe_items_select" ON public.blend_recipe_items
  USING ((SELECT public.is_active_profile()));
ALTER POLICY "addresses_select" ON public.customer_addresses
  USING ((SELECT public.is_active_profile()));
ALTER POLICY "car_select" ON public.customer_application_rates
  USING ((SELECT public.is_active_profile()));
ALTER POLICY "fbd_select" ON public.field_billing_defaults
  USING ((SELECT public.is_active_profile()));
ALTER POLICY "ground_crew_members_select" ON public.ground_crew_members
  USING ((SELECT public.is_active_profile()));
ALTER POLICY "ground_crews_select" ON public.ground_crews
  USING ((SELECT public.is_active_profile()));
ALTER POLICY "ingmap_select" ON public.ingredient_map
  USING ((SELECT public.is_active_profile()));
ALTER POLICY "inventory_holds_select" ON public.inventory_holds
  USING ((SELECT public.is_active_profile()));
ALTER POLICY "job_batches_select" ON public.job_batches
  USING ((SELECT public.is_active_profile()));
ALTER POLICY "job_tags_select" ON public.job_tags
  USING ((SELECT public.is_active_profile()));
ALTER POLICY "Authenticated users can view activity log" ON public.note_activity_log
  USING ((SELECT public.is_active_profile()));
ALTER POLICY "Authenticated users can view note tags" ON public.note_tags
  USING ((SELECT public.is_active_profile()));
ALTER POLICY "product_families_select" ON public.product_families
  USING ((SELECT public.is_active_profile()));
ALTER POLICY "products_select" ON public.products
  USING ((SELECT public.is_active_profile()));
ALTER POLICY "qitems_select" ON public.quote_items
  USING ((SELECT public.is_active_profile()));
ALTER POLICY "Authenticated users can read pdf templates" ON public.quote_pdf_templates
  USING ((SELECT public.is_active_profile()));
ALTER POLICY "qsections_select" ON public.quote_sections
  USING ((SELECT public.is_active_profile()));
ALTER POLICY "Authenticated users can read templates" ON public.quote_templates
  USING ((SELECT public.is_active_profile()));
ALTER POLICY "qversions_select" ON public.quote_versions
  USING ((SELECT public.is_active_profile()));
ALTER POLICY "rebate_programs_select" ON public.rebate_programs
  USING ((SELECT public.is_active_profile()));
ALTER POLICY "Authenticated users can view all attachments" ON public.team_note_attachments
  USING ((SELECT public.is_active_profile()));
ALTER POLICY "tcomments_select" ON public.team_note_comments
  USING ((SELECT public.is_active_profile()));
ALTER POLICY "tnotes_select" ON public.team_notes
  USING ((SELECT public.is_active_profile()));
ALTER POLICY "units_select" ON public.unit_conversions
  USING ((SELECT public.is_active_profile()));
ALTER POLICY "vehicles_select" ON public.vehicles
  USING ((SELECT public.is_active_profile()));
ALTER POLICY "warehouses_select" ON public.warehouses
  USING ((SELECT public.is_active_profile()));

DO $verify$
DECLARE
  v_expected   CONSTANT int := 30;   -- 31 targets, minus arf_select which uses the inline form
  v_converted  int;
  v_remaining  int;
  v_offenders  text;
  v_arf        text;
BEGIN
  -- 1. Every helper-based target now carries the active-profile predicate.
  SELECT count(*) INTO v_converted
    FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND pol.polcmd IN ('r', '*')
     AND coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') LIKE '%is_active_profile%';

  IF v_converted <> v_expected THEN
    RAISE EXCEPTION 'POSTFLIGHT: expected % policies to require an active profile, found %',
      v_expected, v_converted;
  END IF;

  -- 1b. arf_select uses the inline form; assert it still gates on is_active.
  SELECT pg_get_expr(pol.polqual, pol.polrelid) INTO v_arf
    FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
   WHERE c.relname = 'application_record_fields' AND pol.polname = 'arf_select';

  IF v_arf IS NULL OR v_arf NOT LIKE '%is_active%' THEN
    RAISE EXCEPTION 'POSTFLIGHT: arf_select does not require an active profile: %',
      coalesce(v_arf, '<missing>');
  END IF;

  -- 1c. The helper must not be executable by PUBLIC or anon.
  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'is_active_profile'
       AND (has_function_privilege('anon', p.oid, 'EXECUTE')
            -- a PUBLIC grant renders with an empty grantee, i.e. "=X/postgres"
            OR EXISTS (SELECT 1 FROM unnest(p.proacl) acl WHERE acl::text LIKE '=%'))
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT: is_active_profile() must not be executable by PUBLIC or anon';
  END IF;

  -- 2. No PERMISSIVE read policy still admits any logged-in user unconditionally.
  SELECT count(*),
         coalesce(string_agg(c.relname || '.' || pol.polname, ', ' ORDER BY c.relname), '')
    INTO v_remaining, v_offenders
    FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND pol.polpermissive
     AND pol.polcmd IN ('r', '*')
     AND btrim(coalesce(pg_get_expr(pol.polqual, pol.polrelid), '')) IN (
       'true',
       '(true)',
       '(auth.uid() IS NOT NULL)',
       '(( SELECT auth.uid() AS uid) IS NOT NULL)'
     );

  IF v_remaining <> 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT: % unconditional read policies remain: %', v_remaining, v_offenders;
  END IF;

  RAISE NOTICE 'OK: % broad read policies now require an active profile; 0 unconditional read policies remain.',
    v_converted;
END;
$verify$;

COMMIT;
