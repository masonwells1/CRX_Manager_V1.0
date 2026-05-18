-- ============================================================================
-- Decision-B #9a + #9b — Tighten SELECT RLS on field_app_locations + field_app_location_shares
-- ============================================================================
-- Audit finding (Phase 0 verification, 2026-05-11):
--   #9a: field_app_locations_select USING ((SELECT auth.uid()) IS NOT NULL) —
--        any authenticated user can read billing splits.
--   #9b: field_app_location_shares_select — same shape.
--
-- Mason's decision (2026-05-12): Option C —
--   `is_admin() OR is_sales_rep() OR is_applicator()`. Drivers excluded;
--   applicators retained because the field-app workflow (multi-customer jobs,
--   split-billing on iPad) needs to see who gets billed for what.
--
-- Matches the pattern set by `field_crop_history_select` in
-- `20260512030000_tighten_blend_ticket_field_crop_history_rls.sql`.
-- ============================================================================

DROP POLICY IF EXISTS field_app_locations_select ON public.field_app_locations;

CREATE POLICY field_app_locations_select ON public.field_app_locations
  FOR SELECT
  USING (is_admin() OR is_sales_rep() OR is_applicator());

COMMENT ON POLICY field_app_locations_select ON public.field_app_locations IS
  'Decision-B (#9a) — admin/sales_rep/applicator only. Drivers excluded (no business need for billing splits). Was ((SELECT auth.uid()) IS NOT NULL) — any authenticated user.';

DROP POLICY IF EXISTS field_app_location_shares_select ON public.field_app_location_shares;

CREATE POLICY field_app_location_shares_select ON public.field_app_location_shares
  FOR SELECT
  USING (is_admin() OR is_sales_rep() OR is_applicator());

COMMENT ON POLICY field_app_location_shares_select ON public.field_app_location_shares IS
  'Decision-B (#9b) — admin/sales_rep/applicator only. Matches field_app_locations_select.';

-- ─── Verification ────────────────────────────────────────────────────────

DO $$
DECLARE
  v_locations_qual text;
  v_shares_qual text;
BEGIN
  SELECT qual::text INTO v_locations_qual
  FROM pg_policies
  WHERE tablename = 'field_app_locations' AND policyname = 'field_app_locations_select';
  IF v_locations_qual IS NULL OR v_locations_qual !~ 'is_admin' THEN
    RAISE EXCEPTION 'decision-b verification: field_app_locations_select missing role gate (qual=%)', v_locations_qual;
  END IF;

  SELECT qual::text INTO v_shares_qual
  FROM pg_policies
  WHERE tablename = 'field_app_location_shares' AND policyname = 'field_app_location_shares_select';
  IF v_shares_qual IS NULL OR v_shares_qual !~ 'is_admin' THEN
    RAISE EXCEPTION 'decision-b verification: field_app_location_shares_select missing role gate (qual=%)', v_shares_qual;
  END IF;

  RAISE NOTICE 'decision-b verification passed: field_app_locations + field_app_location_shares SELECT tightened.';
END;
$$;
