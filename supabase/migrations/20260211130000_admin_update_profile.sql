-- Admin-only RPC to update any user's profile (role, name, phone, active status)
CREATE OR REPLACE FUNCTION admin_update_profile(
  target_user_id uuid,
  new_role text DEFAULT NULL,
  new_full_name text DEFAULT NULL,
  new_phone text DEFAULT NULL,
  new_is_active boolean DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  caller_role text;
  updated_count int;
BEGIN
  -- Verify caller is an admin
  SELECT role INTO caller_role FROM public.profiles WHERE id = auth.uid();
  IF caller_role IS NULL OR caller_role != 'admin' THEN
    RETURN json_build_object('error', 'Admin access required');
  END IF;

  -- Validate role if provided
  IF new_role IS NOT NULL AND new_role NOT IN ('admin', 'sales_rep', 'driver') THEN
    RETURN json_build_object('error', 'Invalid role. Must be admin, sales_rep, or driver');
  END IF;

  -- Update profile
  UPDATE public.profiles SET
    role = COALESCE(new_role, role),
    full_name = COALESCE(new_full_name, full_name),
    phone = COALESCE(new_phone, phone),
    is_active = COALESCE(new_is_active, is_active),
    updated_at = now()
  WHERE id = target_user_id;

  GET DIAGNOSTICS updated_count = ROW_COUNT;

  IF updated_count = 0 THEN
    RETURN json_build_object('error', 'User not found');
  END IF;

  RETURN json_build_object('success', true);
END;
$$;
