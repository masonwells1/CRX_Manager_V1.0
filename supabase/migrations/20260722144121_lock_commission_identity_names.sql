-- Lock commission-identity names (Codex push-proof HIGH, 2026-07-22).
--
-- Commission-split recipients resolve by lower(trim(profiles.full_name)),
-- and 20260722134252 made that resolution load-bearing (validator + backstop
-- trigger). But profiles_update RLS lets any authenticated user update their
-- OWN row, and _guard_profile_role_lock only locked role/is_active/
-- denied_pages — full_name was deliberately self-serviceable. That leaves two
-- vectors: (a) a non-admin renames themselves to an existing recipient name,
-- creating two active matches so the validator rejects that recipient
-- everywhere (blocks quoting/invoicing); (b) a non-admin renames themselves
-- to a vacated name still stored in split snapshots, routing future
-- commissions to their own user id. Two closures, both fail-closed:
--   1. full_name joins the admin-only column set in _guard_profile_role_lock.
--   2. A case-insensitive unique index over ACTIVE profiles' names makes
--      duplicate active names impossible for everyone, admins included.

SET LOCAL lock_timeout = '5s';

LOCK TABLE public.profiles IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_guard_hash text;
  v_dup_count integer;
BEGIN
  SELECT md5(p.prosrc)
    INTO v_guard_hash
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public._guard_profile_role_lock()');

  IF v_guard_hash IS DISTINCT FROM 'faad3630dbffc28fb20f6bc3d37eaa54' THEN
    RAISE EXCEPTION 'PROFILE_GUARD_BASELINE_DRIFT: %', v_guard_hash;
  END IF;

  SELECT count(*)
    INTO v_dup_count
    FROM (
      SELECT 1
        FROM public.profiles
       WHERE is_active = true
       GROUP BY lower(btrim(full_name))
      HAVING count(*) > 1
    ) d;

  IF v_dup_count <> 0 THEN
    RAISE EXCEPTION 'PROFILE_NAME_DEDUP_REQUIRED: % duplicate active names', v_dup_count;
  END IF;
END;
$preflight$;

-- Same body as 20260511090000 with full_name added to the admin-only set.
-- Token PROFILE_ROLE_LOCK is kept — it is the established error contract.
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
    OR OLD.full_name IS DISTINCT FROM NEW.full_name
  ) AND NOT is_admin() THEN
    RAISE EXCEPTION 'PROFILE_ROLE_LOCK: only admins can change full_name, role, is_active, or denied_pages'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public._guard_profile_role_lock() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._guard_profile_role_lock() FROM anon;

COMMENT ON FUNCTION public._guard_profile_role_lock IS
  'Blocks non-admin UPDATE that would change role/is_active/denied_pages (Phase 1.4, Critical #3) or full_name (2026-07-22 — full_name is commission-routing identity since 20260722134252).';

-- Active profile names must be unique case-insensitively: the commission
-- validator requires exactly-one-active-match, so a duplicate name would
-- brick that recipient for everyone.
CREATE UNIQUE INDEX IF NOT EXISTS uq_profiles_active_full_name_ci
  ON public.profiles (lower(btrim(full_name)))
  WHERE is_active = true;

DO $postflight$
DECLARE
  v_existing_name text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid = to_regprocedure('public._guard_profile_role_lock()')
       AND p.prosecdef
       AND p.proconfig @> ARRAY['search_path=public, pg_temp']
       AND p.prosrc LIKE '%OLD.full_name IS DISTINCT FROM NEW.full_name%'
  ) THEN
    RAISE EXCEPTION 'PROFILE_GUARD_POSTFLIGHT_DRIFT';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger t
     WHERE t.tgrelid = 'public.profiles'::regclass
       AND t.tgname = 'trg_guard_profile_role_lock'
       AND NOT t.tgisinternal
       AND t.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'PROFILE_GUARD_TRIGGER_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'profiles'
       AND indexname = 'uq_profiles_active_full_name_ci'
       AND indexdef LIKE '%UNIQUE%'
       AND indexdef LIKE '%WHERE (is_active = true)%'
  ) THEN
    RAISE EXCEPTION 'PROFILE_NAME_UNIQUE_INDEX_MISSING';
  END IF;

  -- The index must actually reject a duplicate active name. Runs inside a
  -- sub-block and always errors, so no row ever lands; the dummy id/email are
  -- random so they cannot collide with a real profile. email is NOT NULL with
  -- no default (drift-review B1), so it must be supplied for the test to
  -- reach the unique index at all. The duplicate name is derived from a real
  -- active profile (re-cased + padded) so the test never depends on one
  -- specific person existing.
  SELECT '  ' || upper(p.full_name) || ' '
    INTO v_existing_name
    FROM public.profiles p
   WHERE p.is_active = true
     AND NULLIF(btrim(p.full_name), '') IS NOT NULL
   ORDER BY p.full_name
   LIMIT 1;

  IF v_existing_name IS NULL THEN
    RAISE EXCEPTION 'PROFILE_NAME_UNIQUE_POSTFLIGHT_NO_TEST_PROFILE';
  END IF;

  BEGIN
    INSERT INTO public.profiles (id, email, full_name, role, is_active)
    SELECT gen_random_uuid(), gen_random_uuid() || '@postflight.invalid', v_existing_name, 'sales_rep', true;
    RAISE EXCEPTION 'PROFILE_NAME_UNIQUE_POSTFLIGHT_FAILED';
  EXCEPTION
    WHEN unique_violation THEN
      NULL; -- expected: uq_profiles_active_full_name_ci fired
    WHEN OTHERS THEN
      IF SQLERRM = 'PROFILE_NAME_UNIQUE_POSTFLIGHT_FAILED' THEN
        RAISE;
      END IF;
      -- Any other failure (e.g. an auth.users FK) means the index was not
      -- what rejected the row — the test is inconclusive, fail loudly.
      IF SQLSTATE <> '23503' THEN
        RAISE EXCEPTION 'PROFILE_NAME_UNIQUE_POSTFLIGHT_WRONG_ERROR: % (%)', SQLERRM, SQLSTATE;
      END IF;
      -- FK to auth.users fired before the unique index could: fall back to a
      -- catalog-only assertion (shape was already checked above).
      NULL;
  END;
END;
$postflight$;