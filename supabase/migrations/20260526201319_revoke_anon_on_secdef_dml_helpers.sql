-- B9 (2026-05-26 post-Codex audit): revoke anon/authenticated EXECUTE on
-- SECURITY DEFINER helpers that perform DML but don't reference auth.uid().
--
-- Codex's broader scan (after the 20260526151856 ultra-review migration
-- finished its regex-targeted sweep) found 6 SECDEF helper functions still
-- anon-callable. Each performs INSERT/UPDATE/DELETE on a table and has no
-- caller-identity check — meaning anon (whose key is in the public client
-- bundle) could mutate state via direct PostgREST RPC calls.
--
-- Legitimate callers:
--   * Other SECDEF wrappers running as `postgres` — can still execute these
--     because the function owner (postgres) bypasses EXECUTE grants on its
--     own functions.
--   * pg_cron jobs — run as the superuser, unaffected by EXECUTE grants.
--   * service_role administrative calls (defense-in-depth keeps the GRANT
--     even though service_role typically bypasses).
--
-- Functions and their abuse vectors if anon-callable:
--   check_idempotency          — minor (cleanup loop), lookup helper
--   check_rate_limit           — anon can forge p_user_id and exhaust any
--                                user's rate limit (DoS legitimate logins)
--   check_remainder_reminders  — anon can trigger ALL remainder notifications
--                                on demand (admin spam + premature flag set)
--   cleanup_rate_limits        — anon can delete rate-limit history, evading
--                                limits
--   log_failed_notification    — anon can spam fake notification-failure rows
--                                (audit-log poisoning)
--   notify_damaged_receiving   — anon can send fake "Damaged Items Received"
--                                alerts to all admins
--
-- See docs/audits/2026-05-26-claude-disposition-of-codex-execution.md §11
-- for the post-Codex-audit reconciliation.

BEGIN;

REVOKE EXECUTE ON FUNCTION public.check_idempotency(text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.check_rate_limit(uuid, text, integer, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.check_remainder_reminders()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_rate_limits()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.log_failed_notification(text, text, uuid, text, jsonb, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_damaged_receiving(text, text, uuid, text)
  FROM PUBLIC, anon, authenticated;

-- Keep service_role explicit (defense-in-depth; service_role typically bypasses
-- but an explicit grant survives any future Supabase grant-default changes).
GRANT EXECUTE ON FUNCTION public.check_idempotency(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(uuid, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.check_remainder_reminders() TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_rate_limits() TO service_role;
GRANT EXECUTE ON FUNCTION public.log_failed_notification(text, text, uuid, text, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.notify_damaged_receiving(text, text, uuid, text) TO service_role;

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.check_idempotency(text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.check_rate_limit(uuid,text,integer,integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.check_remainder_reminders()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.cleanup_rate_limits()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.log_failed_notification(text,text,uuid,text,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.notify_damaged_receiving(text,text,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'B9 verification failed: at least one SECDEF DML helper still anon-EXECUTE-able';
  END IF;

  IF has_function_privilege('authenticated', 'public.check_rate_limit(uuid,text,integer,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.check_remainder_reminders()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.cleanup_rate_limits()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.notify_damaged_receiving(text,text,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'B9 verification failed: at least one SECDEF DML helper still authenticated-EXECUTE-able';
  END IF;
END $$;

COMMIT;
