-- U18c: fix the morning-notification-checks cron time zone.
--
-- The U18 migration scheduled this job as '20 6 * * *' intending 06:20 local, but
-- pg_cron on Supabase runs in UTC with no per-job timezone. The result was the job
-- firing at 06:20 UTC = 01:20 AM Central — the middle of the night, not the morning.
--
-- pg_cron cannot track daylight saving on its own, so no single static schedule hits
-- 06:20 Central year-round. We schedule 11:20 UTC, which is:
--   * 06:20 America/Chicago during CDT (Mar-Nov, the growing season) — the intended time
--   * 05:20 America/Chicago during CST (Nov-Mar)
-- i.e. always early morning and never later than 06:20, which suits an ag workflow where
-- crews start early. (If exact 06:20 year-round is ever required, gate the function on
-- (now() AT TIME ZONE 'America/Chicago')::time and schedule at both 11:20 and 12:20 UTC —
-- the built-in 24h per-entity dedup makes the second run a harmless no-op.)
--
-- Re-emits the exact DO block from 20260709230000_u18_safety_nets.sql with only the cron
-- expression changed. The function public.run_morning_notification_checks() is unchanged.

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'morning-notification-checks') THEN
    PERFORM cron.unschedule('morning-notification-checks');
  END IF;
  PERFORM cron.schedule(
    'morning-notification-checks',
    '20 11 * * *',
    'SELECT public.run_morning_notification_checks()'
  );
END
$cron$;
