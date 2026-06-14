-- ============================================================================
-- M6b (2026-06-10 foundation ultra review, Codex round — MED):
-- profile_public_view was SELECT-granted to `anon`, and the view runs with
-- security_invoker = off (SECURITY DEFINER semantics, by design — see CLAUDE.md
-- Schema Gotchas), so it bypasses profiles RLS. Verified live 2026-06-10:
-- `SET ROLE anon` returned all 10 employee rows (id, full_name, role,
-- is_active) with no authentication — an unintended public employee
-- directory. The intended grant set (20260510070000) was authenticated-only;
-- the restore migration (20260516132645) never re-revoked anon.
--
-- Fix: revoke anon (and belt-and-braces PUBLIC). authenticated + service_role
-- keep SELECT — every frontend caller (TeamBoard, Deliveries, CustomerDetail,
-- CommissionPayments, Reports, VendorBillDetail, notificationTriggers) runs
-- behind login, so logged-in behavior is unchanged.
-- ============================================================================

REVOKE SELECT ON public.profile_public_view FROM anon;
REVOKE SELECT ON public.profile_public_view FROM PUBLIC;
GRANT SELECT ON public.profile_public_view TO authenticated;
GRANT SELECT ON public.profile_public_view TO service_role;

-- Verification
DO $$
BEGIN
  IF has_table_privilege('anon', 'public.profile_public_view', 'SELECT') THEN
    RAISE EXCEPTION 'anon can still SELECT profile_public_view';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.profile_public_view', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated lost SELECT on profile_public_view';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.profile_public_view', 'SELECT') THEN
    RAISE EXCEPTION 'service_role lost SELECT on profile_public_view';
  END IF;
END $$;
