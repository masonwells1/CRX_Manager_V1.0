-- ============================================================================
-- Phase 1.4 — Profile role-lock trigger (closes Critical #3)
-- ============================================================================
-- Audit finding (AUDIT_2026_05 / Phase 0 verification):
--   profiles_update RLS allows USING + CHECK = `((auth.uid() = id) OR is_admin())`,
--   which lets any authenticated user update their OWN profile row freely.
--   There is no column-level constraint, so a non-admin user can issue a direct
--   PostgREST PATCH and set their own `role = 'admin'` (or `is_active = true`,
--   or clear their `denied_pages` array). This is the second half of the
--   privilege-escalation chain — the first half (Critical #2, `handle_new_user`
--   trusting `raw_user_meta_data->>'role'`) is mitigated by Mason disabling
--   public signup in the Supabase Auth dashboard. This migration closes the
--   second half so the chain stays broken even if signup is ever re-enabled.
--
-- Approach: BEFORE UPDATE trigger that rejects the UPDATE if a privilege-
-- bearing column actually changed AND the caller is not admin. Non-privilege
-- self-updates (full_name, phone, applicator_license_number,
-- faa_certificate_number) remain allowed by both the RLS policy and the
-- trigger.
--
-- Columns locked: role, is_active, denied_pages
-- Columns NOT locked: full_name, phone, email, applicator_license_number,
--   faa_certificate_number, updated_at (user can still maintain own profile)
--
-- Pattern reference: matches the existing _guard_<entity>_<action> naming
-- (_guard_invoice_delete, _guard_order_delete, etc.) and uses the canonical
-- token-style error code (PROFILE_ROLE_LOCK).
-- ============================================================================

CREATE OR REPLACE FUNCTION public._guard_profile_role_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF (
    OLD.role IS DISTINCT FROM NEW.role
    OR OLD.is_active IS DISTINCT FROM NEW.is_active
    OR OLD.denied_pages IS DISTINCT FROM NEW.denied_pages
  ) AND NOT is_admin() THEN
    RAISE EXCEPTION 'PROFILE_ROLE_LOCK: only admins can change role, is_active, or denied_pages'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public._guard_profile_role_lock IS
  'Phase 1.4 — Blocks non-admin UPDATE that would change role/is_active/denied_pages. Closes Critical #3 (self-role-escalation via direct PostgREST PATCH).';

DROP TRIGGER IF EXISTS trg_guard_profile_role_lock ON public.profiles;

CREATE TRIGGER trg_guard_profile_role_lock
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public._guard_profile_role_lock();

-- ─── Verification ─────────────────────────────────────────────────────────

DO $$
DECLARE
  v_function_exists boolean;
  v_trigger_exists boolean;
  v_function_security_definer boolean;
  v_function_search_path text;
BEGIN
  -- Function exists with correct attributes
  SELECT
    EXISTS (SELECT 1 FROM pg_proc WHERE proname='_guard_profile_role_lock' AND pronamespace='public'::regnamespace),
    (SELECT prosecdef FROM pg_proc WHERE proname='_guard_profile_role_lock' AND pronamespace='public'::regnamespace),
    (SELECT array_to_string(proconfig, ', ') FROM pg_proc WHERE proname='_guard_profile_role_lock' AND pronamespace='public'::regnamespace)
    INTO v_function_exists, v_function_security_definer, v_function_search_path;

  IF NOT v_function_exists THEN
    RAISE EXCEPTION 'profile-role-lock verification: function _guard_profile_role_lock not created';
  END IF;
  IF NOT v_function_security_definer THEN
    RAISE EXCEPTION 'profile-role-lock verification: function is not SECURITY DEFINER';
  END IF;
  IF v_function_search_path IS NULL OR v_function_search_path NOT LIKE '%pg_temp%' THEN
    RAISE EXCEPTION 'profile-role-lock verification: function missing search_path with pg_temp (got: %)', v_function_search_path;
  END IF;

  -- Trigger exists on profiles, fires BEFORE UPDATE
  SELECT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON t.tgrelid = c.oid
    WHERE c.relname='profiles' AND c.relnamespace='public'::regnamespace
      AND t.tgname='trg_guard_profile_role_lock'
      AND NOT t.tgisinternal
  ) INTO v_trigger_exists;

  IF NOT v_trigger_exists THEN
    RAISE EXCEPTION 'profile-role-lock verification: trigger trg_guard_profile_role_lock not created on profiles';
  END IF;

  RAISE NOTICE 'profile-role-lock verification passed: trigger active on public.profiles.';
END;
$$;
