-- =============================================================================
-- Migration: 20260430230000_field_app_workflow_phase11.sql
-- Phase 11 — Sprint C: Field-app RLS lockdown.
--
-- Fixes P1 findings from docs/audits/2026-04-30-security-permissions-audit-findings.md:
--   - field_app_locations and field_app_location_shares had USING (true) /
--     WITH CHECK (true) on every operation. Any authenticated user could
--     read AND mutate these tables directly via PostgREST, bypassing the
--     save_field_app_invoice RPC entirely.
--   - application_records SELECT policy allowed any applicator to read every
--     application record, not just records for jobs assigned to them.
--
-- Strategy:
--   - field_app tables: SELECT remains broad (authenticated, since invoices
--     these rows belong to are already RLS-protected at the parent level);
--     INSERT/UPDATE/DELETE restricted to admin/sales. Applicators continue
--     reading via SELECT to display past application history; writes go
--     through the SECURITY DEFINER save_field_app_invoice RPC only.
--   - application_records SELECT: admin/sales see all; applicators see only
--     records where applicator_id = auth.uid().
-- =============================================================================


-- =============================================================================
-- 1. field_app_locations RLS
-- =============================================================================

DROP POLICY IF EXISTS field_app_locations_select ON field_app_locations;
DROP POLICY IF EXISTS field_app_locations_insert ON field_app_locations;
DROP POLICY IF EXISTS field_app_locations_update ON field_app_locations;
DROP POLICY IF EXISTS field_app_locations_delete ON field_app_locations;

CREATE POLICY field_app_locations_select ON field_app_locations
  FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY field_app_locations_insert ON field_app_locations
  FOR INSERT WITH CHECK (is_admin() OR is_sales_rep());

CREATE POLICY field_app_locations_update ON field_app_locations
  FOR UPDATE USING (is_admin() OR is_sales_rep())
              WITH CHECK (is_admin() OR is_sales_rep());

CREATE POLICY field_app_locations_delete ON field_app_locations
  FOR DELETE USING (is_admin() OR is_sales_rep());


-- =============================================================================
-- 2. field_app_location_shares RLS
-- =============================================================================

DROP POLICY IF EXISTS field_app_location_shares_select ON field_app_location_shares;
DROP POLICY IF EXISTS field_app_location_shares_insert ON field_app_location_shares;
DROP POLICY IF EXISTS field_app_location_shares_update ON field_app_location_shares;
DROP POLICY IF EXISTS field_app_location_shares_delete ON field_app_location_shares;

CREATE POLICY field_app_location_shares_select ON field_app_location_shares
  FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY field_app_location_shares_insert ON field_app_location_shares
  FOR INSERT WITH CHECK (is_admin() OR is_sales_rep());

CREATE POLICY field_app_location_shares_update ON field_app_location_shares
  FOR UPDATE USING (is_admin() OR is_sales_rep())
              WITH CHECK (is_admin() OR is_sales_rep());

CREATE POLICY field_app_location_shares_delete ON field_app_location_shares
  FOR DELETE USING (is_admin() OR is_sales_rep());


-- =============================================================================
-- 3. application_records SELECT — scope applicators to their own work
-- =============================================================================

DROP POLICY IF EXISTS app_records_select ON application_records;
CREATE POLICY app_records_select ON application_records
  FOR SELECT USING (
    is_admin() OR is_sales_rep()
    OR (is_applicator() AND applicator_id = (SELECT auth.uid()))
  );


-- =============================================================================
-- Verification
-- =============================================================================

DO $$
DECLARE
  v_fal_open    int;
  v_fals_open   int;
  v_ar_unscoped int;
BEGIN
  SELECT count(*) INTO v_fal_open
    FROM pg_policy
   WHERE polrelid='field_app_locations'::regclass
     AND polcmd IN ('a','w','d')
     AND (pg_get_expr(polqual, polrelid) = 'true' OR pg_get_expr(polwithcheck, polrelid) = 'true');
  IF v_fal_open > 0 THEN
    RAISE EXCEPTION 'VERIFICATION FAILED: field_app_locations still has open write policies';
  END IF;

  SELECT count(*) INTO v_fals_open
    FROM pg_policy
   WHERE polrelid='field_app_location_shares'::regclass
     AND polcmd IN ('a','w','d')
     AND (pg_get_expr(polqual, polrelid) = 'true' OR pg_get_expr(polwithcheck, polrelid) = 'true');
  IF v_fals_open > 0 THEN
    RAISE EXCEPTION 'VERIFICATION FAILED: field_app_location_shares still has open write policies';
  END IF;

  SELECT count(*) INTO v_ar_unscoped
    FROM pg_policy
   WHERE polrelid='application_records'::regclass
     AND polname='app_records_select'
     AND pg_get_expr(polqual, polrelid) NOT ILIKE '%applicator_id%';
  IF v_ar_unscoped > 0 THEN
    RAISE EXCEPTION 'VERIFICATION FAILED: app_records_select missing applicator_id ownership scope';
  END IF;

  RAISE NOTICE 'Phase 11 verified: field_app tables have admin/sales-only writes, app_records SELECT is ownership-scoped for applicators';
END $$;
