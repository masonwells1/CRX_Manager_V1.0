-- Hardening (Codex round-3 MEDIUM follow-up #1/#4): lock down SECURITY DEFINER functions that
-- have no business-user use case and no frontend caller.
--
-- These four are invoked by pg_cron and/or internal SECDEF callers (both run as the function
-- OWNER, not as `authenticated`) and/or service_role — never directly by the UI (verified: only
-- test-file references in src/, no supabase.rpc(...) call). Removing the authenticated/anon/PUBLIC
-- EXECUTE grant closes the "any logged-in user can trigger maintenance / write idempotency keys
-- directly" surface Codex flagged, with zero impact on legitimate callers:
--   * pg_cron runs as the owner -> owner always retains EXECUTE.
--   * SECDEF RPCs that call save_idempotency() internally execute it as the owner (the same
--     pattern already proven safe for check_idempotency(), whose authenticated grant was revoked
--     in 20260526201319 and which these RPCs still call internally without issue).
--   * service_role retains EXECUTE explicitly (re-granted below in case it came via PUBLIC).
--
-- NOT touched (explicitly justified, Codex #2/#3): log_failed_notification + release_expired_quote_holds
-- are frontend-called (Dashboard.tsx / notificationTriggers.ts), already authenticated-only (anon
-- revoked), and benign (write a failure-log row / release already-expired inventory holds). A hard
-- auth.uid() gate would break their cron / service_role / Edge-function callers (auth.uid() is NULL
-- there) and cannot reliably distinguish service_role from no-caller inside a SECDEF body. Left as-is.

REVOKE EXECUTE ON FUNCTION public.auto_expire_quotes() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.mark_overdue_invoices() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.retry_failed_notifications() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.save_idempotency(text, text, jsonb) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.auto_expire_quotes() TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_overdue_invoices() TO service_role;
GRANT EXECUTE ON FUNCTION public.retry_failed_notifications() TO service_role;
GRANT EXECUTE ON FUNCTION public.save_idempotency(text, text, jsonb) TO service_role;

-- Self-verify the final grant state (mirrors the 20260526201319 precedent): authenticated/anon
-- must NOT execute these; service_role MUST. Fails the migration if the grant state is wrong.
DO $$
BEGIN
  IF has_function_privilege('authenticated', 'public.auto_expire_quotes()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.mark_overdue_invoices()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.retry_failed_notifications()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.save_idempotency(text,text,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.auto_expire_quotes()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.mark_overdue_invoices()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.retry_failed_notifications()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.save_idempotency(text,text,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'HARDENING_FAILED: authenticated/anon still has EXECUTE on a maintenance function';
  END IF;
  IF NOT (has_function_privilege('service_role', 'public.auto_expire_quotes()', 'EXECUTE')
      AND has_function_privilege('service_role', 'public.mark_overdue_invoices()', 'EXECUTE')
      AND has_function_privilege('service_role', 'public.retry_failed_notifications()', 'EXECUTE')
      AND has_function_privilege('service_role', 'public.save_idempotency(text,text,jsonb)', 'EXECUTE')) THEN
    RAISE EXCEPTION 'HARDENING_FAILED: service_role missing EXECUTE on a maintenance function';
  END IF;
END $$;
