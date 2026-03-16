-- Migration: Clean up confirm_delivery overload + enable pg_cron for overdue detection
--
-- 1. Drop the stale confirm_delivery(uuid, text) overload from the consolidation
--    migration. The correct version is confirm_delivery(uuid, uuid, text) which
--    includes p_performed_by and returns jsonb.
--
-- 2. Enable pg_cron and schedule mark_overdue_invoices() to run daily at 6 AM UTC
--    (~midnight Central Time).

-- Drop stale overload
DROP FUNCTION IF EXISTS public.confirm_delivery(uuid, text);

-- Enable pg_cron
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
GRANT USAGE ON SCHEMA cron TO postgres;

-- Schedule daily overdue invoice sweep
SELECT cron.schedule(
  'mark-overdue-invoices',
  '0 6 * * *',
  $$SELECT public.mark_overdue_invoices()$$
);
