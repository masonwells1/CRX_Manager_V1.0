-- =============================================================================
-- 2026-05-16: Expand email_log.status CHECK to include 'pending'
--
-- Supports the durable send-email pattern (ultra-review P2 #5). Current flow
-- inserts the email_log row AFTER the Resend send completes, so if the insert
-- fails post-send the customer gets the email but there's no audit record and
-- no idempotency entry — future retries would duplicate the email.
--
-- New flow: insert email_log with status='pending' BEFORE calling Resend
-- (write-ahead log). After Resend returns, UPDATE to 'sent' or 'failed'.
-- This makes the email_log → idempotency_key the durable replay marker, not
-- a best-effort post-hoc record.
--
-- Existing status values ('sent', 'failed', 'bounced') unchanged. Adding
-- 'pending' is additive — existing code that filters by sent/failed/bounced
-- continues to work; only the send-email function itself produces 'pending'
-- rows, and only transiently (always updated to sent/failed within the same
-- request).
-- =============================================================================

BEGIN;

ALTER TABLE public.email_log
  DROP CONSTRAINT IF EXISTS email_log_status_check;

ALTER TABLE public.email_log
  ADD CONSTRAINT email_log_status_check
  CHECK (status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text, 'bounced'::text]));

-- Verification
DO $verify$
DECLARE
  v_check_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_check_def
    FROM pg_constraint
   WHERE conrelid = 'public.email_log'::regclass
     AND conname = 'email_log_status_check';

  IF v_check_def NOT LIKE '%pending%' THEN
    RAISE EXCEPTION 'email_log_status_check: pending not in allowed values, got %', v_check_def;
  END IF;
  IF v_check_def NOT LIKE '%sent%' OR v_check_def NOT LIKE '%failed%' OR v_check_def NOT LIKE '%bounced%' THEN
    RAISE EXCEPTION 'email_log_status_check: lost an existing value, got %', v_check_def;
  END IF;
END
$verify$;

COMMIT;
