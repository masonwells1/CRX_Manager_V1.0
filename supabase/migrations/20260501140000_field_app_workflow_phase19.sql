-- =============================================================================
-- Migration: 20260501140000_field_app_workflow_phase19.sql
-- Phase 19 — Sprint F #3: pg_cron schedules for Dashboard-triggered jobs
--
-- Closes the audit's concern that check_remainder_reminders() and
-- release_expired_quote_holds() only ran when someone opened the
-- Dashboard. If nobody logged in for a day, partial-delivery reminders
-- and expired quote holds piled up. Both are batch operations safe to
-- run on a schedule.
--
-- This follows the same pg_cron pattern already used for
-- mark_overdue_invoices (migration 20260316121800).
--
-- Schedule rationale:
--   - check_remainder_reminders: 6:30 AM UTC daily (~12:30 AM CT).
--     Catches partial deliveries from the previous day before staff
--     arrive in the morning.
--   - release_expired_quote_holds: 6:15 AM UTC daily (~12:15 AM CT).
--     Frees inventory before sales reps start booking new quotes.
--   - mark_overdue_invoices already runs at 6:00 AM UTC.
--
-- Frontend Dashboard.tsx still runs both RPCs on load — that's
-- intentional belt-and-suspenders. If pg_cron is disabled or fails,
-- the dashboard sweep still catches up. Both functions are idempotent
-- (running twice in the same day is a no-op).
-- =============================================================================

-- pg_cron is already enabled (migration 20260316121800), but include
-- IF NOT EXISTS to be safe if this migration is replayed.
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;

-- Drop existing schedules with these names if they exist (idempotency
-- for re-running the migration). cron.unschedule throws if the job
-- doesn't exist, so we wrap in DO blocks.
DO $$
BEGIN
  PERFORM cron.unschedule('release-expired-quote-holds');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  PERFORM cron.unschedule('check-remainder-reminders');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Schedule release_expired_quote_holds at 6:15 AM UTC daily.
SELECT cron.schedule(
  'release-expired-quote-holds',
  '15 6 * * *',
  $$SELECT public.release_expired_quote_holds()$$
);

-- Schedule check_remainder_reminders at 6:30 AM UTC daily.
SELECT cron.schedule(
  'check-remainder-reminders',
  '30 6 * * *',
  $$SELECT public.check_remainder_reminders()$$
);
