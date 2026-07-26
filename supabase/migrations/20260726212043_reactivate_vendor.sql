-- reactivate_vendor(): admin-only undo for vendor soft-delete.
--
-- Why: delete_vendor() (20260510120000) soft-deletes by stamping
-- vendors.deleted_at, and the vendor-liveness gate (20260726201208) now
-- hard-blocks void_vendor_payment on a soft-deleted vendor with
-- "restore the vendor before voiding its payments" — but no restore path
-- existed. Owner-approved 2026-07-26: the UI reframes soft-delete as
-- Deactivate, and this RPC is the matching Reactivate.
--
-- Safety:
--   * Admin-only, same actor gate as delete_vendor.
--   * Locks the deactivated vendor row (deleted_at IS NOT NULL FOR UPDATE)
--     so a concurrent second reactivation or edit serializes.
--   * An active vendor with the same normalized identity blocks
--     reactivation (VENDOR_NAME_CONFLICT). The partial unique index
--     vendors_active_normalized_name_key (20260722033450) is the hard
--     backstop; the unique_violation handler maps the race to the same
--     friendly error.
--   * Idempotent via check_idempotency/save_idempotency like its peers.

CREATE OR REPLACE FUNCTION public.reactivate_vendor(
  p_vendor_id uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_actor_role text;
  v_vendor record;
  v_conflict_name text;
  v_result jsonb;
  v_existing jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;

  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role <> 'admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: only admins can reactivate vendors';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'reactivate_vendor');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_vendor
  FROM vendors
  WHERE id = p_vendor_id AND deleted_at IS NOT NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VENDOR_NOT_FOUND_OR_ACTIVE: % (missing, or already active)', p_vendor_id;
  END IF;

  SELECT name INTO v_conflict_name
  FROM vendors
  WHERE deleted_at IS NULL
    AND normalize_vendor_alias(name) = normalize_vendor_alias(v_vendor.name)
  LIMIT 1;
  IF v_conflict_name IS NOT NULL THEN
    RAISE EXCEPTION
      'VENDOR_NAME_CONFLICT: an active vendor "%" already uses this name; rename it (or this vendor) first',
      v_conflict_name;
  END IF;

  BEGIN
    UPDATE vendors SET deleted_at = NULL, updated_at = now() WHERE id = p_vendor_id;
  EXCEPTION WHEN unique_violation THEN
    -- Concurrent create/reactivate of the same normalized name won the
    -- race; surface the same friendly error the pre-check uses.
    RAISE EXCEPTION
      'VENDOR_NAME_CONFLICT: an active vendor already uses this name; rename it (or this vendor) first';
  END;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id
  ) VALUES (
    'vendor_reactivated',
    'Vendor ' || v_vendor.name || ' reactivated',
    v_actor, 'vendor', p_vendor_id
  );

  v_result := jsonb_build_object('success', true, 'vendor_id', p_vendor_id);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'reactivate_vendor', v_result);
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.reactivate_vendor(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reactivate_vendor(uuid, text) TO authenticated, service_role;

-- ─── Verification ─────────────────────────────────────────────────────────

DO $$
DECLARE
  v_count integer;
  v_src text;
  v_secdef boolean;
  v_config text[];
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname = 'reactivate_vendor';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'reactivate_vendor verification: expected 1 overload, found %', v_count;
  END IF;

  SELECT prosrc, prosecdef, proconfig INTO v_src, v_secdef, v_config
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname = 'reactivate_vendor';

  IF NOT v_secdef THEN
    RAISE EXCEPTION 'reactivate_vendor verification: must be SECURITY DEFINER';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM unnest(v_config) c WHERE c LIKE 'search_path=%pg_temp%') THEN
    RAISE EXCEPTION 'reactivate_vendor verification: search_path must include pg_temp';
  END IF;
  IF v_src NOT LIKE '%deleted_at IS NOT NULL%'
     OR v_src NOT LIKE '%VENDOR_NAME_CONFLICT%'
     OR v_src NOT LIKE '%normalize_vendor_alias%' THEN
    RAISE EXCEPTION 'reactivate_vendor verification: expected guard predicates missing from body';
  END IF;

  IF has_function_privilege('anon', 'public.reactivate_vendor(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'reactivate_vendor verification: anon must not be able to execute reactivate_vendor';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.reactivate_vendor(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'reactivate_vendor verification: authenticated lost EXECUTE on reactivate_vendor';
  END IF;

  RAISE NOTICE 'reactivate_vendor verification passed.';
END;
$$;
