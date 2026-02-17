-- ============================================================================
-- Per-User Page Permissions
-- CRX Manager V1.0
-- Date: 2026-03-01
--
-- Adds a denied_pages text[] column to profiles for per-user page restrictions.
-- Updates admin_update_profile() to accept and manage denied_pages.
-- Also fixes pre-existing bug: adds 'applicator' to role validation.
-- ============================================================================

-- 1. Add denied_pages column to profiles
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS denied_pages text[] NOT NULL DEFAULT '{}';

-- 2. Recreate admin_update_profile with denied_pages support + applicator fix
CREATE OR REPLACE FUNCTION admin_update_profile(
  target_user_id uuid,
  new_role text DEFAULT NULL,
  new_full_name text DEFAULT NULL,
  new_phone text DEFAULT NULL,
  new_is_active boolean DEFAULT NULL,
  new_denied_pages text[] DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller_role text;
  caller_active boolean;
  updated_count int;
  v_final_role text;
BEGIN
  -- Verify caller is an ACTIVE admin
  SELECT role, is_active INTO caller_role, caller_active
  FROM profiles WHERE id = (SELECT auth.uid());

  IF caller_role IS NULL OR caller_role != 'admin' OR caller_active != true THEN
    RETURN json_build_object('error', 'Active admin access required');
  END IF;

  -- Validate role if provided (fixed: now includes 'applicator')
  IF new_role IS NOT NULL AND new_role NOT IN ('admin', 'sales_rep', 'driver', 'applicator') THEN
    RETURN json_build_object('error', 'Invalid role. Must be admin, sales_rep, driver, or applicator');
  END IF;

  -- Determine the final role (new or existing)
  IF new_role IS NOT NULL THEN
    v_final_role := new_role;
  ELSE
    SELECT role INTO v_final_role FROM profiles WHERE id = target_user_id;
  END IF;

  -- Admins never have denied pages — auto-clear
  IF v_final_role = 'admin' AND new_denied_pages IS NOT NULL THEN
    new_denied_pages := '{}';
  END IF;

  -- Update profile
  UPDATE profiles SET
    role = COALESCE(new_role, role),
    full_name = COALESCE(new_full_name, full_name),
    phone = COALESCE(new_phone, phone),
    is_active = COALESCE(new_is_active, is_active),
    denied_pages = COALESCE(new_denied_pages, denied_pages),
    updated_at = now()
  WHERE id = target_user_id;

  GET DIAGNOSTICS updated_count = ROW_COUNT;

  IF updated_count = 0 THEN
    RETURN json_build_object('error', 'User not found');
  END IF;

  RETURN json_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION admin_update_profile(uuid, text, text, text, boolean, text[]) TO authenticated;
