-- vendors_select_inactive_admin: let admins READ deactivated vendors.
--
-- Why: the reactivate_vendor feature (20260726212043) added a "Show Inactive"
-- view + Reactivate button to the admin-only Vendors page, but the sole
-- vendors SELECT policy (vendors_select, 20260510030000) requires
-- deleted_at IS NULL — RLS silently filters every soft-deleted row, so the
-- inactive view always renders empty and no vendor can be reached for
-- reactivation. Found by PR #236 automated review (P1) and confirmed against
-- live pg_policy before this fix.
--
-- Fix: one additive, permissive SELECT policy scoped to admins and to
-- soft-deleted rows only (policies OR together). Active-row visibility is
-- unchanged (vendors_select still governs it, admin + sales_rep). Writes are
-- untouched: reactivation happens only through the SECURITY DEFINER
-- reactivate_vendor RPC, and Section 9 (20260726190515) already removed
-- browser-role vendor write paths.

CREATE POLICY vendors_select_inactive_admin ON public.vendors
  FOR SELECT
  USING (
    (deleted_at IS NOT NULL)
    AND ((SELECT profiles.role FROM profiles
          WHERE profiles.id = (SELECT auth.uid())) = 'admin'::text)
  );

-- ─── Verification ─────────────────────────────────────────────────────────

DO $$
DECLARE
  v_expr text;
  v_cmd char;
  v_permissive boolean;
BEGIN
  SELECT pg_get_expr(polqual, polrelid), polcmd, polpermissive
    INTO v_expr, v_cmd, v_permissive
  FROM pg_policy
  WHERE polrelid = 'public.vendors'::regclass
    AND polname = 'vendors_select_inactive_admin';

  IF v_expr IS NULL THEN
    RAISE EXCEPTION 'vendors_select_inactive_admin verification: policy not found';
  END IF;
  IF v_cmd <> 'r' THEN
    RAISE EXCEPTION 'vendors_select_inactive_admin verification: must be SELECT-only, found cmd %', v_cmd;
  END IF;
  IF NOT v_permissive THEN
    RAISE EXCEPTION 'vendors_select_inactive_admin verification: must be PERMISSIVE so it ORs with vendors_select';
  END IF;
  IF v_expr NOT LIKE '%deleted_at IS NOT NULL%' THEN
    RAISE EXCEPTION 'vendors_select_inactive_admin verification: must be scoped to soft-deleted rows only';
  END IF;
  IF v_expr NOT LIKE '%''admin''%' OR v_expr LIKE '%sales_rep%' THEN
    RAISE EXCEPTION 'vendors_select_inactive_admin verification: must be admin-only';
  END IF;

  -- The original active-row policy must still exist, unchanged in scope:
  -- active rows visible to admin + sales_rep, soft-deleted rows excluded.
  SELECT pg_get_expr(polqual, polrelid) INTO v_expr
  FROM pg_policy
  WHERE polrelid = 'public.vendors'::regclass AND polname = 'vendors_select';
  IF v_expr IS NULL OR v_expr NOT LIKE '%deleted_at IS NULL%' THEN
    RAISE EXCEPTION 'vendors_select_inactive_admin verification: vendors_select active-row policy missing or altered';
  END IF;

  -- No write policy may have appeared on vendors as a side effect.
  IF EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.vendors'::regclass AND polcmd <> 'r'
  ) THEN
    RAISE EXCEPTION 'vendors_select_inactive_admin verification: unexpected non-SELECT policy on vendors';
  END IF;

  RAISE NOTICE 'vendors_select_inactive_admin verification passed.';
END;
$$;
