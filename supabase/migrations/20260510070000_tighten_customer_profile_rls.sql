-- ============================================================================
-- Audit fix sprint PR-07 — Customer + profile RLS tightening
-- ============================================================================
-- Plan: docs/audits/2026-05-09-implementation-plan.md (PR-07)
-- Audit findings: P1 #7 (customers RLS), P1 (profiles RLS — peer)
-- Decisions: Q2 = Option B (today's route + assigned customers, time-windowed)
--            Q3 = safer default (admins + self for full PII)
--
-- ⚠️ DO NOT APPLY THIS MIGRATION TO LIVE SUPABASE WITHOUT FRONTEND PREP.
--
-- Block 2 below TIGHTENS profiles_select to admin-or-self. Many existing
-- frontend pages join on `profiles` to display user names (activity feed,
-- delivery driver name, sales rep on order/quote/customer, applicator on
-- jobs, comment authors on team-board, etc). After this migration, those
-- joins return NULL for non-admin users — UIs will show "Unknown User"
-- everywhere a name was previously rendered.
--
-- The fix is to migrate every such join + dropdown to read from
-- `public.profile_public_view` (defined in Block 2) instead of `profiles`
-- directly. The view is `security_invoker = off` and exposes only
-- non-PII columns: id, full_name, role, is_active.
--
-- RECOMMENDED DEPLOYMENT ORDER:
--   1. Apply Block 2's view + GRANT (safe — additive only, doesn't change
--      existing behavior). Run as a separate migration step if desired.
--   2. Update frontend (separate PR) — switch every `profiles` SELECT for
--      display purposes to `profile_public_view`. Keep `profiles` reads only
--      where PII (email/phone/license) is actually rendered for the user
--      themselves or by an admin.
--   3. Apply Block 2's policy DROP/CREATE — the tightening itself.
--   4. Apply Block 1 (customers) — independent of profile changes.
--
-- This single migration file represents the FINAL STATE. Splitting into
-- phases is at Mason's discretion when applying via Supabase MCP.
-- ============================================================================

-- ============================================================================
-- Block 1 — customers_select: add applicator scoping + tighten driver window
-- ============================================================================
-- Live state at 2026-05-10 (verified via pg_policies):
--   admin: see all
--   sales_rep: see only customers WHERE assigned_sales_rep = auth.uid()
--   driver: see customers WHERE EXISTS deliveries WHERE customer_id = customers.id
--           AND assigned_driver = auth.uid()  -- ← no time window today
--   applicator: NO ACCESS today (gap that PR-07 closes)
--
-- After this migration:
--   admin: unchanged
--   sales_rep: unchanged (already correctly scoped)
--   driver: only deliveries with scheduled_date >= CURRENT_DATE - INTERVAL '1 day'
--   applicator: jobs with applicator_id = auth.uid() AND job_date >= CURRENT_DATE - INTERVAL '7 days'
--
-- Note: jobs.scheduled_date does NOT exist — the column is `job_date`. Plan's
-- spec referenced `scheduled_date`, live inspection corrected.
-- ============================================================================

DROP POLICY IF EXISTS customers_select ON customers;

CREATE POLICY customers_select ON customers FOR SELECT
USING (
  -- admins and assigned sales reps unchanged
  is_admin()
  OR (is_sales_rep() AND assigned_sales_rep = (SELECT auth.uid()))
  -- drivers: only customers tied to their deliveries within the recent window
  OR (
    is_driver()
    AND EXISTS (
      SELECT 1 FROM deliveries d
      WHERE d.customer_id = customers.id
        AND d.assigned_driver = (SELECT auth.uid())
        AND d.scheduled_date >= CURRENT_DATE - INTERVAL '1 day'
    )
  )
  -- applicators: only customers tied to their assigned jobs within 7-day window
  OR (
    is_applicator()
    AND EXISTS (
      SELECT 1 FROM jobs j
      WHERE j.customer_id = customers.id
        AND j.applicator_id = (SELECT auth.uid())
        AND j.job_date >= CURRENT_DATE - INTERVAL '7 days'
    )
  )
);

-- ============================================================================
-- Block 2 — profile_public_view + tightened profiles_select
-- ============================================================================
-- Live state: profiles_select uses `USING (true)` — every authenticated
-- user can read every profile's email, phone, applicator_license_number,
-- faa_certificate_number, and denied_pages. PII leak.
--
-- profile_public_view exposes only non-PII columns. Owned by `postgres`
-- with `security_invoker = off` so the view bypasses table-level RLS —
-- callers reading the view see all rows but only the safe columns.
-- ============================================================================

-- profiles table has no deleted_at column (verified 2026-05-10) — soft-delete
-- happens via auth.users cascade + is_active flag. The view exposes inactive
-- rows too so existing UIs that show grayed-out "former employees" still work.
DROP VIEW IF EXISTS public.profile_public_view;
CREATE VIEW public.profile_public_view
WITH (security_invoker = off, security_barrier = false)
AS
SELECT
  id,
  full_name,
  role,
  is_active
FROM public.profiles;

GRANT SELECT ON public.profile_public_view TO authenticated;

COMMENT ON VIEW public.profile_public_view IS
  'Non-PII view of profiles — id, full_name, role, is_active only. '
  'Use this for assignment dropdowns, joined display names, and any '
  'frontend read that does NOT need email/phone/license/certificate. '
  'Bypasses table RLS via security_invoker=off (PR-07, 2026-05-10).';

-- Tighten the underlying table policy. From this point forward, direct
-- SELECT on `profiles` returns only the caller's own row OR all rows for
-- admins. The view above is the supported read path for everything else.
DROP POLICY IF EXISTS profiles_select ON profiles;

CREATE POLICY profiles_select ON profiles FOR SELECT
USING (
  is_admin()
  OR id = (SELECT auth.uid())
);

-- ============================================================================
-- Block 3 — Verification block
-- ============================================================================

DO $$
DECLARE
  v_customers_policy_qual text;
  v_profiles_policy_qual text;
  v_view_exists boolean;
  v_view_grant_exists boolean;
BEGIN
  -- customers_select must include is_applicator() and the time windows
  SELECT qual INTO v_customers_policy_qual
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'customers' AND policyname = 'customers_select';

  IF v_customers_policy_qual IS NULL THEN
    RAISE EXCEPTION 'PR-07 verification: customers_select policy missing after migration';
  END IF;

  IF v_customers_policy_qual NOT LIKE '%is_applicator%' THEN
    RAISE EXCEPTION 'PR-07 verification: customers_select policy missing is_applicator() branch';
  END IF;

  IF v_customers_policy_qual NOT LIKE '%CURRENT_DATE%' THEN
    RAISE EXCEPTION 'PR-07 verification: customers_select policy missing CURRENT_DATE time window';
  END IF;

  -- profiles_select must NOT be USING (true) anymore
  SELECT qual INTO v_profiles_policy_qual
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'profiles' AND policyname = 'profiles_select';

  IF v_profiles_policy_qual IS NULL THEN
    RAISE EXCEPTION 'PR-07 verification: profiles_select policy missing after migration';
  END IF;

  IF v_profiles_policy_qual = 'true' OR v_profiles_policy_qual ILIKE '%true%' AND v_profiles_policy_qual NOT ILIKE '%is_admin%' THEN
    RAISE EXCEPTION 'PR-07 verification: profiles_select still permissive (is_admin gate missing)';
  END IF;

  -- profile_public_view must exist + be SELECT-grantable to authenticated
  SELECT EXISTS (
    SELECT 1 FROM information_schema.views
    WHERE table_schema = 'public' AND table_name = 'profile_public_view'
  ) INTO v_view_exists;

  IF NOT v_view_exists THEN
    RAISE EXCEPTION 'PR-07 verification: profile_public_view not created';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name = 'profile_public_view'
      AND grantee = 'authenticated'
      AND privilege_type = 'SELECT'
  ) INTO v_view_grant_exists;

  IF NOT v_view_grant_exists THEN
    RAISE EXCEPTION 'PR-07 verification: profile_public_view missing GRANT SELECT to authenticated';
  END IF;

  RAISE NOTICE 'PR-07 verification passed: customers + profiles RLS tightened, profile_public_view ready.';
END;
$$;
