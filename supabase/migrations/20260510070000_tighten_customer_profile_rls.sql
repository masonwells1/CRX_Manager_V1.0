-- ============================================================================
-- Audit fix sprint PR-07 (PART 1 OF 2) — Customer RLS + profile_public_view
-- ============================================================================
-- Plan: docs/audits/2026-05-09-implementation-plan.md (PR-07)
-- Audit findings: P1 #7 (customers RLS — driver time window + applicator gap)
-- Decisions: Q2 = Option B (today's route + assigned customers, time-windowed)
--            Q3 = safer default — DEFERRED to part 2 (see below)
--
-- Part 1 (this file) — SAFE TO APPLY ANY TIME:
--   • customers_select policy: tightens driver access to a 1-day window AND
--     adds applicator scoping (closes the access gap where applicators had
--     none). Live state was: drivers had all-time access, applicators had
--     no access at all.
--   • profile_public_view + GRANT — non-PII view of profiles
--     (id/full_name/role/is_active) with security_invoker=off so it bypasses
--     table-level RLS. Purely additive — no existing reads break.
--
-- Part 2 (file `20260510999999_profiles_select_tighten.sql`) — DEFERRED:
--   • profiles_select policy DROP/CREATE — tightens to admin-or-self.
--   • Cannot apply until ~34 frontend files migrate from `profiles!fk(...)`
--     joins to reading from `profile_public_view`. Otherwise non-admin UIs
--     render "Unknown User" everywhere a profile join is used (delivery
--     drivers, sales reps on orders/quotes/customers, applicators on jobs,
--     comment authors on team-board, activity-feed performed_by, etc).
--
-- The 99999999 suffix on part 2 keeps it last in lexicographic apply order
-- so it can sit dormant in the queue until the frontend prep PR ships.
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
-- Driver access narrows from "all my deliveries" to "deliveries within
-- 1 day". Mason confirmed (Q2 Option B) this is the intended narrowing.
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
-- Block 2 — profile_public_view (additive, safe)
-- ============================================================================
-- Live state: profiles_select uses `USING (true)` — every authenticated
-- user can read every profile's email, phone, applicator_license_number,
-- faa_certificate_number, and denied_pages. PII leak.
--
-- THIS PART OF THE FIX (the view + GRANT) is safe to apply now. The
-- profiles_select tightening that closes the PII leak ships in part 2
-- after frontend prep.
--
-- profile_public_view exposes only non-PII columns. Owned by `postgres`
-- with `security_invoker = off` so callers reading the view see all rows
-- but only the safe columns. Inactive rows are included so existing UIs
-- that show grayed-out "former employees" still work.
-- ============================================================================

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
  'Bypasses table RLS via security_invoker=off (PR-07, 2026-05-10). '
  'Required read path before profiles_select policy is tightened — see '
  'migration 20260510999999_profiles_select_tighten.sql for part 2.';

-- ============================================================================
-- Block 3 — Verification (part 1 only)
-- ============================================================================

DO $$
DECLARE
  v_customers_policy_qual text;
  v_view_exists boolean;
  v_view_grant_exists boolean;
BEGIN
  -- customers_select must include is_applicator() and the time windows
  SELECT qual INTO v_customers_policy_qual
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'customers' AND policyname = 'customers_select';

  IF v_customers_policy_qual IS NULL THEN
    RAISE EXCEPTION 'PR-07 part 1 verification: customers_select policy missing after migration';
  END IF;

  IF v_customers_policy_qual NOT LIKE '%is_applicator%' THEN
    RAISE EXCEPTION 'PR-07 part 1 verification: customers_select policy missing is_applicator() branch';
  END IF;

  IF v_customers_policy_qual NOT LIKE '%CURRENT_DATE%' THEN
    RAISE EXCEPTION 'PR-07 part 1 verification: customers_select policy missing CURRENT_DATE time window';
  END IF;

  -- profile_public_view must exist + be SELECT-grantable to authenticated
  SELECT EXISTS (
    SELECT 1 FROM information_schema.views
    WHERE table_schema = 'public' AND table_name = 'profile_public_view'
  ) INTO v_view_exists;

  IF NOT v_view_exists THEN
    RAISE EXCEPTION 'PR-07 part 1 verification: profile_public_view not created';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name = 'profile_public_view'
      AND grantee = 'authenticated'
      AND privilege_type = 'SELECT'
  ) INTO v_view_grant_exists;

  IF NOT v_view_grant_exists THEN
    RAISE EXCEPTION 'PR-07 part 1 verification: profile_public_view missing GRANT SELECT to authenticated';
  END IF;

  RAISE NOTICE 'PR-07 part 1 verification passed: customers RLS tightened + profile_public_view ready. Apply part 2 (20260510999999_profiles_select_tighten.sql) AFTER frontend dropdown migration.';
END;
$$;
