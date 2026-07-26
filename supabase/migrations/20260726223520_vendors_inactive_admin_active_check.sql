-- vendors_select_inactive_admin: require the admin profile to be ACTIVE.
--
-- Why: 20260726215154 added the inactive-vendor read policy checking only
-- profiles.role = 'admin'. PR #236 review (Codex P2) noted a deactivated
-- admin (profiles.is_active = false) holding a still-valid JWT would keep
-- read access through it. The project's newer admin-only policies
-- (20260701213000) check `is_active = true`; this brings the new policy in
-- line. (The older vendors_select policy and is_admin() helper predate that
-- convention and still omit the check — that systemic gap is tracked
-- separately and is deliberately NOT widened or narrowed here.)
--
-- Fix: ALTER POLICY only — same table, same command (SELECT), same
-- soft-deleted-rows scope, with `is_active = true` added to the admin check.

ALTER POLICY vendors_select_inactive_admin ON public.vendors
  USING (
    (deleted_at IS NOT NULL)
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.role = 'admin'::text
        AND profiles.is_active = true
    )
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
    RAISE EXCEPTION 'vendors_inactive_admin_active_check verification: policy not found';
  END IF;
  IF v_cmd <> 'r' THEN
    RAISE EXCEPTION 'vendors_inactive_admin_active_check verification: must be SELECT-only, found cmd %', v_cmd;
  END IF;
  IF NOT v_permissive THEN
    RAISE EXCEPTION 'vendors_inactive_admin_active_check verification: must stay PERMISSIVE';
  END IF;
  IF v_expr NOT LIKE '%deleted_at IS NOT NULL%' THEN
    RAISE EXCEPTION 'vendors_inactive_admin_active_check verification: must stay scoped to soft-deleted rows';
  END IF;
  IF v_expr NOT LIKE '%''admin''%' OR v_expr LIKE '%sales_rep%' THEN
    RAISE EXCEPTION 'vendors_inactive_admin_active_check verification: must stay admin-only';
  END IF;
  IF v_expr NOT LIKE '%is_active%' THEN
    RAISE EXCEPTION 'vendors_inactive_admin_active_check verification: is_active check missing';
  END IF;

  -- The active-row policy must remain untouched by this ALTER.
  SELECT pg_get_expr(polqual, polrelid) INTO v_expr
  FROM pg_policy
  WHERE polrelid = 'public.vendors'::regclass AND polname = 'vendors_select';
  IF v_expr IS NULL OR v_expr NOT LIKE '%deleted_at IS NULL%' THEN
    RAISE EXCEPTION 'vendors_inactive_admin_active_check verification: vendors_select missing or altered';
  END IF;

  -- Still no write policy on vendors.
  IF EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.vendors'::regclass AND polcmd <> 'r'
  ) THEN
    RAISE EXCEPTION 'vendors_inactive_admin_active_check verification: unexpected non-SELECT policy on vendors';
  END IF;

  RAISE NOTICE 'vendors_inactive_admin_active_check verification passed.';
END;
$$;
