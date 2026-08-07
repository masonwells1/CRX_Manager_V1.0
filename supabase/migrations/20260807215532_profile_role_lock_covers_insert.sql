-- APPLIED LIVE 2026-08-07 as version 20260807215532 (Supabase-assigned at apply time;
-- authored as 20260807153000). Reviewed CLEAN by both Codex charters; all pre/postflight
-- checks passed at apply, including the live non-admin escalation-insert probe.
--
-- Extend `_guard_profile_role_lock` to INSERT (residual of KNOWN_ISSUES §0d).
--
-- §0d closed the `profile_public_view` RLS bypass that made self-DELETE of a
-- `profiles` row reachable. It explicitly did NOT close the follow-up it
-- exposed (KNOWN_ISSUES §0d, "Follow-ups this exposed", bullet 1):
--
--   `profiles_insert` is `TO authenticated WITH CHECK (auth.uid() = id OR
--   is_admin())` with no role pin, `profiles_role_check` permits `'admin'`,
--   and `trg_guard_profile_role_lock` is `BEFORE UPDATE` only — so it never
--   fires on INSERT. Any authenticated user whose own `profiles` row is
--   absent can insert it back with `role = 'admin'`, and `is_admin()`
--   (EXISTS role='admin' AND is_active) is then true. Full escalation.
--
-- Live state re-read 2026-08-07, confirming the description:
--   trg_guard_profile_role_lock -> BEFORE UPDATE ON public.profiles FOR EACH ROW
--     (tgtype 19 = ROW|BEFORE|UPDATE)
--   profiles_insert (cmd 'a', TO authenticated)
--     WITH CHECK ((SELECT auth.uid()) = id OR is_admin())   -- no role pin
--   profiles_role_check allows admin/sales_rep/driver/applicator/entity_recipient
--   _guard_profile_role_lock prosrc md5 = ac9a1057507879b62d398bcb2738b6f5
--
-- WHY A BLANKET DENY FOR AUTHENTICATED NON-ADMINS, rather than "own row with a
-- non-privileged role":
--
--   A "non-privileged role" pin cannot be written safely here. The escalation
--   that matters is not only driver -> admin: a `driver` can also delete and
--   re-insert as `sales_rep` to pick up the office-only pricing reads that
--   20260727231652 / 20260728123224 restricted. To reject that, the guard would
--   need to know the row's PREVIOUS role — and there is no surviving signal,
--   because `trg_sync_profile_public_directory` fires AFTER DELETE and removes
--   the mirror row too. Any allowlisted role is therefore an escalation for
--   somebody below it.
--
--   Meanwhile no legitimate end-user-session INSERT exists. Verified 2026-08-07:
--     - `src/` contains zero `.from('profiles').insert(...)` call sites; the
--       frontend never inserts a profile.
--     - Profile creation runs through `public.handle_new_user()`, the
--       SECURITY DEFINER `AFTER INSERT ON auth.users` trigger, driven by the
--       `create-user` edge function's service_role `admin.createUser` call.
--       In that path `auth.uid()` is NULL (a service_role JWT carries no `sub`).
--
--   So the INSERT arm fires only when `auth.uid()` IS NOT NULL — i.e. a real
--   end-user session — and in that case allows only `is_admin()`. That is a
--   strictly stronger control than a role pin, and it is verifiable rather
--   than a judgment call about which role is "non-privileged".
--
-- ACCEPTED RESIDUAL (deliberate, not an oversight): a caller holding the
-- service_role key, or a `postgres`/owner session, still inserts unguarded,
-- because `auth.uid()` is NULL for both. Those principals are already
-- BYPASSRLS and can write `profiles.role` directly; a trigger cannot be the
-- boundary for them. The boundary this migration asserts is the authenticated
-- PostgREST route, which is the one §0d showed was reachable.
--
-- UPDATE SEMANTICS ARE UNCHANGED. The existing four-column lock (role,
-- is_active, denied_pages, full_name gated on is_admin()) is reproduced
-- byte-for-byte below; the only additions are the TG_OP branch ahead of it and
-- the widened trigger event list.

SET LOCAL lock_timeout = '5s';

LOCK TABLE public.profiles IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_guard_hash text;
  v_tgtype smallint;
  v_high_water text;
BEGIN
  -- CHECK 6 (self-proving): this file must be strictly above the live ledger
  -- high-water at the moment of apply — a fresher migration already in the
  -- ledger means this file was stamped in the past and must be re-stamped.
  SELECT max(version) INTO v_high_water FROM supabase_migrations.schema_migrations;
  IF v_high_water IS NULL OR v_high_water >= '20260807153000' THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: live migration high-water % is not below 20260807153000 — re-stamp this file',
      COALESCE(v_high_water, '(none)');
  END IF;

  SELECT md5(p.prosrc)
    INTO v_guard_hash
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public._guard_profile_role_lock()');

  IF v_guard_hash IS DISTINCT FROM 'ac9a1057507879b62d398bcb2738b6f5' THEN
    RAISE EXCEPTION 'PROFILE_ROLE_LOCK_BASELINE_DRIFT: %', v_guard_hash;
  END IF;

  -- Baseline must still be UPDATE-only (tgtype 19 = ROW|BEFORE|UPDATE). If it
  -- is already 23 (ROW|BEFORE|INSERT|UPDATE) another session landed this fix
  -- and this migration must not be applied blind.
  SELECT t.tgtype
    INTO v_tgtype
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.profiles'::regclass
     AND t.tgname = 'trg_guard_profile_role_lock'
     AND NOT t.tgisinternal;

  IF v_tgtype IS DISTINCT FROM 19::smallint THEN
    RAISE EXCEPTION 'PROFILE_ROLE_LOCK_TRIGGER_BASELINE_DRIFT: %', v_tgtype;
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public._guard_profile_role_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  -- INSERT arm (KNOWN_ISSUES §0d residual). OLD is NULL on INSERT, so this
  -- must branch before the UPDATE comparison below ever touches OLD.
  IF TG_OP = 'INSERT' THEN
    -- auth.uid() IS NULL => service_role / owner / the handle_new_user signup
    -- trigger. Those principals bypass RLS anyway; see the header note on the
    -- accepted residual. Only a real end-user session is gated.
    IF (SELECT auth.uid()) IS NOT NULL AND NOT is_admin() THEN
      RAISE EXCEPTION 'PROFILE_INSERT_LOCK: only admins can insert profile rows; profiles are created by the create-user flow'
        USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
  END IF;

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
$function$;

REVOKE ALL ON FUNCTION public._guard_profile_role_lock() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._guard_profile_role_lock() FROM anon;

-- CREATE OR REPLACE preserves the old catalog comment, which described the
-- UPDATE arm only — re-emit it to cover the new INSERT lock.
COMMENT ON FUNCTION public._guard_profile_role_lock() IS
  'Blocks non-admin UPDATE that would change role/is_active/denied_pages/full_name, and blocks any non-admin logged-in INSERT into profiles (PROFILE_INSERT_LOCK). Service-key/edge-function writes (auth.uid() NULL) are exempt.';

-- Widen the event list. DROP + CREATE rather than adding a second trigger: two
-- triggers on the same table fire in name order, and an INSERT-only companion
-- would be silently droppable on its own.
DROP TRIGGER IF EXISTS trg_guard_profile_role_lock ON public.profiles;

CREATE TRIGGER trg_guard_profile_role_lock
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public._guard_profile_role_lock();

DO $postflight$
DECLARE
  v_victim uuid;
  v_email text;
BEGIN
  -- Structural: trigger now covers INSERT and UPDATE, still BEFORE/ROW, enabled.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger t
     WHERE t.tgrelid = 'public.profiles'::regclass
       AND t.tgname = 'trg_guard_profile_role_lock'
       AND NOT t.tgisinternal
       AND t.tgenabled = 'O'
       AND t.tgtype = 23::smallint   -- ROW|BEFORE|INSERT|UPDATE
  ) THEN
    RAISE EXCEPTION 'PROFILE_ROLE_LOCK_TRIGGER_POSTFLIGHT_DRIFT';
  END IF;

  -- Structural: SECDEF + pinned search_path intact, both arms present.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid = to_regprocedure('public._guard_profile_role_lock()')
       AND p.prosecdef
       AND p.proconfig @> ARRAY['search_path=public, pg_temp']
       AND p.prosrc LIKE '%PROFILE_INSERT_LOCK%'
       AND p.prosrc LIKE '%PROFILE_ROLE_LOCK:%'
       AND p.prosrc LIKE '%OLD.denied_pages IS DISTINCT FROM NEW.denied_pages%'
  ) THEN
    RAISE EXCEPTION 'PROFILE_ROLE_LOCK_BODY_POSTFLIGHT_DRIFT';
  END IF;

  -- Behavioral: impersonate a real ACTIVE NON-ADMIN and attempt the §0d
  -- escalation insert (own id, role='admin'). Must raise 42501. A
  -- service_role/postgres attempt proves nothing here — auth.uid() is NULL for
  -- those and the new arm deliberately does not fire on them.
  SELECT id, email INTO v_victim, v_email
    FROM public.profiles
   WHERE role <> 'admin' AND is_active
   ORDER BY id
   LIMIT 1;

  IF v_victim IS NULL THEN
    RAISE NOTICE 'PROFILE_INSERT_LOCK behavioral proof skipped: no active non-admin profile';
  ELSE
    BEGIN
      PERFORM set_config('request.jwt.claims',
                         json_build_object('sub', v_victim::text, 'role', 'authenticated')::text,
                         true);
      SET LOCAL ROLE authenticated;

      -- Same shape as the §0d path: the row is deleted, then re-inserted. The
      -- DELETE may be silently skipped (no DELETE policy → 0 rows) or raise
      -- (FK/permission); swallow that in its own subtransaction — either way
      -- the INSERT below still hits the BEFORE INSERT arm, which fires ahead
      -- of any RLS WITH CHECK or PK error, so the proof stays unambiguous.
      BEGIN
        DELETE FROM public.profiles WHERE id = v_victim;
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;

      INSERT INTO public.profiles (id, email, full_name, role, is_active)
      VALUES (v_victim, v_email, 'postflight escalation probe', 'admin', true);

      RAISE EXCEPTION 'PROFILE_INSERT_LOCK_POSTFLIGHT_FAILED';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 'PROFILE_INSERT_LOCK_POSTFLIGHT_FAILED' THEN
        RAISE;
      END IF;
      -- ONLY the new arm's own token counts. A generic 42501 (RLS WITH CHECK)
      -- would mean the arm never fired — that is a postflight FAILURE, not a
      -- pass (drift review M4, 2026-08-07).
      IF SQLERRM NOT LIKE 'PROFILE_INSERT_LOCK:%' THEN
        RAISE EXCEPTION 'PROFILE_INSERT_LOCK_POSTFLIGHT_WRONG_ERROR: % (%)', SQLERRM, SQLSTATE;
      END IF;
    END;

    RESET ROLE;
    PERFORM set_config('request.jwt.claims', '', true);
  END IF;
END;
$postflight$;
