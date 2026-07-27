-- Deactivating a profile must actually revoke access.
--
-- Before this migration, profiles.is_active was a pure application-layer flag.
-- Setting it to false narrowed what RLS would return, but the underlying
-- Supabase auth user stayed unbanned and its sessions/refresh tokens stayed
-- valid: the deactivated person kept a working login, kept refreshing their
-- session indefinitely, and kept whatever access any policy still granted.
--
-- Mason's decision (2026-07-27): deactivating a user immediately ends their
-- active sessions and blocks re-login; reactivating restores access. Applies to
-- new deactivations only -- the one already-deactivated account is deliberately
-- NOT backfilled here (no ban is set for it and its existing session rows are
-- left alone).
--
-- Residual window, stated plainly: an access token already issued stays
-- cryptographically valid until it expires (about one hour). Deleting the
-- session and refresh tokens means it cannot be renewed, and banned_until
-- blocks both fresh sign-in and refresh-token exchange, so access ends within
-- that window at the latest. Killing it instantly would require JWT
-- revocation, which GoTrue does not offer.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Do not let an admin lock everyone out.
-- ---------------------------------------------------------------------------
-- Deactivation now bans the auth user, so deactivating the only remaining
-- active admin would leave nobody able to administer the app and would need
-- Supabase dashboard recovery. Refuse that update outright.
CREATE OR REPLACE FUNCTION public._guard_last_active_admin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF OLD.is_active = true
     AND NEW.is_active = false
     AND OLD.role = 'admin'
     AND NOT EXISTS (
       SELECT 1
         FROM public.profiles p
        WHERE p.role = 'admin'
          AND p.is_active = true
          AND p.id <> NEW.id
     )
  THEN
    RAISE EXCEPTION 'LAST_ACTIVE_ADMIN: cannot deactivate the only active admin'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public._guard_last_active_admin() IS
  'Refuses to deactivate the last active admin, which would lock the account out of its own app now that deactivation bans the auth user.';

-- CREATE FUNCTION grants EXECUTE to PUBLIC by default. These are trigger-only
-- functions; no application role may invoke them directly.
REVOKE ALL ON FUNCTION public._guard_last_active_admin() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_last_active_admin ON public.profiles;
CREATE TRIGGER trg_guard_last_active_admin
  BEFORE UPDATE OF is_active ON public.profiles
  FOR EACH ROW
  WHEN (OLD.is_active IS DISTINCT FROM NEW.is_active)
  EXECUTE FUNCTION public._guard_last_active_admin();

-- ---------------------------------------------------------------------------
-- 2. Mirror is_active into the Supabase auth layer.
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER (owner: postgres, which holds auth USAGE + auth.users
-- UPDATE + auth.sessions/auth.refresh_tokens DELETE) so this works whether the
-- profile is changed through admin_update_profile or by an admin writing the
-- row directly under RLS. auth.users is owned by supabase_auth_admin; only the
-- banned_until column is touched.
--
-- Who may reach this trigger at all is already constrained upstream by
-- trg_guard_profile_role_lock, which rejects any change to is_active unless the
-- caller is an active admin.
CREATE OR REPLACE FUNCTION public._sync_auth_access_on_profile_active()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.is_active = false THEN
    -- Block future sign-ins and refresh-token exchanges. A finite far-future
    -- timestamp, not 'infinity': GoTrue scans banned_until into a Go time.Time,
    -- and a Postgres infinity can fail that decode and 500 the auth endpoint.
    UPDATE auth.users
       SET banned_until = timestamptz '9999-12-31 23:59:59+00'
     WHERE id = NEW.id;

    -- End every live session. refresh_tokens.user_id is varchar, not uuid.
    DELETE FROM auth.refresh_tokens WHERE user_id = NEW.id::text;
    DELETE FROM auth.sessions       WHERE user_id = NEW.id;

  ELSIF NEW.is_active = true THEN
    -- Reactivation restores the ability to log in. Sessions are not restored --
    -- the user signs in again.
    UPDATE auth.users
       SET banned_until = NULL
     WHERE id = NEW.id
       AND banned_until IS NOT NULL;
  END IF;

  RETURN NULL;
END;
$function$;

COMMENT ON FUNCTION public._sync_auth_access_on_profile_active() IS
  'Mirrors profiles.is_active into Supabase auth: deactivation bans the auth user and drops its sessions/refresh tokens; reactivation clears the ban.';

-- Trigger-only, and it writes to the auth schema as SECURITY DEFINER. No
-- application role may invoke it directly; strip the default PUBLIC grant.
REVOKE ALL ON FUNCTION public._sync_auth_access_on_profile_active() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_sync_auth_access_on_profile_active ON public.profiles;
CREATE TRIGGER trg_sync_auth_access_on_profile_active
  AFTER UPDATE OF is_active ON public.profiles
  FOR EACH ROW
  WHEN (OLD.is_active IS DISTINCT FROM NEW.is_active)
  EXECUTE FUNCTION public._sync_auth_access_on_profile_active();

-- ---------------------------------------------------------------------------
-- 3. Shape verification (no live data is mutated by this block).
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(expected, ', ')
    INTO v_missing
    FROM (VALUES
            ('trg_guard_last_active_admin'),
            ('trg_sync_auth_access_on_profile_active')
         ) AS t(expected)
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_trigger tg
       JOIN pg_class c ON c.oid = tg.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = 'profiles'
        AND NOT tg.tgisinternal
        AND tg.tgname = t.expected
   );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT: expected trigger(s) missing on public.profiles: %', v_missing;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = '_sync_auth_access_on_profile_active'
       AND p.prosecdef
       AND p.proconfig @> ARRAY['search_path=public, pg_temp']
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT: _sync_auth_access_on_profile_active must be SECURITY DEFINER with a pinned search_path';
  END IF;

  -- Neither trigger function may be executable by PUBLIC, anon, or authenticated.
  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('_guard_last_active_admin', '_sync_auth_access_on_profile_active')
       AND (has_function_privilege('anon',          p.oid, 'EXECUTE')
            OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
            -- a PUBLIC grant renders with an empty grantee, i.e. "=X/postgres"
            OR EXISTS (SELECT 1 FROM unnest(p.proacl) acl WHERE acl::text LIKE '=%'))
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT: trigger functions must not be executable by PUBLIC, anon, or authenticated';
  END IF;

  RAISE NOTICE 'OK: deactivation now bans the auth user and clears its sessions; last-active-admin deactivation is refused.';
END;
$verify$;

COMMIT;
