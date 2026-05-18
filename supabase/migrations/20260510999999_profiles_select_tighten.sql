-- ============================================================================
-- Audit fix sprint PR-07 (PART 2 OF 2) — profiles_select policy tightening
-- ============================================================================
-- Plan: docs/audits/2026-05-09-implementation-plan.md (PR-07)
-- Audit findings: P1 (profiles RLS — `USING (true)` PII leak)
-- Decision: Q3 = safer default (admins + self for full PII)
--
-- ⚠️ DO NOT APPLY UNTIL FRONTEND DROPDOWN MIGRATION IS COMPLETE.
--
-- This migration is intentionally stamped at the far end of the May 10
-- timestamp range (999999) so it sits dormant in the lexicographic apply
-- order until Mason runs it manually.
--
-- WHAT BREAKS IF APPLIED PREMATURELY:
--   ~34 frontend files join on `profiles` to display user names — activity
--   feed, delivery driver display, sales rep on order/quote/customer,
--   applicator on jobs, comment authors on team-board, etc. After this
--   migration, those joins return NULL for non-admin users (because RLS
--   blocks the underlying table read). UIs render "Unknown User" or empty
--   values everywhere a profile name is shown.
--
-- PREREQUISITE FOR SAFE APPLY:
--   Every `profiles!fk_name(full_name, ...)` join in the frontend that
--   reads only non-PII columns (id/full_name/role/is_active) must migrate
--   to read from `public.profile_public_view` instead. The view was
--   created in part 1 (`20260510070000_tighten_customer_profile_rls.sql`)
--   and bypasses table RLS via `security_invoker = off`.
--
--   Direct `profiles` reads remain valid for:
--     • Admins (always have full access)
--     • Users reading their own row (e.g., Settings page)
--     • Any callsite that genuinely needs PII (email, phone,
--       applicator_license_number, faa_certificate_number)
--
-- ROLLBACK:
--   DROP POLICY IF EXISTS profiles_select ON profiles;
--   CREATE POLICY profiles_select ON profiles FOR SELECT USING (true);
--
-- After applying, run `node scripts/regenerate-schema-registry.mjs`.
-- ============================================================================

DROP POLICY IF EXISTS profiles_select ON profiles;

CREATE POLICY profiles_select ON profiles FOR SELECT
USING (
  is_admin()
  OR id = (SELECT auth.uid())
);

-- ─── Verification ─────────────────────────────────────────────────────────

DO $$
DECLARE
  v_profiles_policy_qual text;
BEGIN
  SELECT qual INTO v_profiles_policy_qual
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'profiles' AND policyname = 'profiles_select';

  IF v_profiles_policy_qual IS NULL THEN
    RAISE EXCEPTION 'PR-07 part 2 verification: profiles_select policy missing after migration';
  END IF;

  IF v_profiles_policy_qual = 'true' THEN
    RAISE EXCEPTION 'PR-07 part 2 verification: profiles_select still USING (true) — tightening did not apply';
  END IF;

  IF v_profiles_policy_qual NOT LIKE '%is_admin%' THEN
    RAISE EXCEPTION 'PR-07 part 2 verification: profiles_select missing is_admin() gate';
  END IF;

  RAISE NOTICE 'PR-07 part 2 verification passed: profiles_select tightened to admin-or-self.';
END;
$$;
