-- CRX operational schedules at live high-water 20260719065443.
-- Apply after the public schema baseline on a NEW Supabase project.
BEGIN;

DO $baseline_cron_guard$
BEGIN
  IF current_database() <> 'postgres' OR current_user <> 'postgres' THEN
    RAISE EXCEPTION 'BASELINE_CRON_RESTORE_REQUIRES_POSTGRES_DATABASE_AND_ROLE';
  END IF;

  IF to_regclass('cron.job') IS NULL OR to_regprocedure('cron.schedule(text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'BASELINE_CRON_EXTENSION_REQUIRED';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM cron.job
     WHERE jobname = ANY (ARRAY[
       'auto-expire-quotes',
       'check-remainder-reminders',
       'check-unpriced-orders',
       'data-integrity-sweep',
       'mark-overdue-invoices',
       'morning-notification-checks',
       'release-expired-quote-holds',
       'weekly-db-backup'
     ])
  ) THEN
    RAISE EXCEPTION 'BASELINE_CRON_RESTORE_REQUIRES_ABSENT_JOBS';
  END IF;
END;
$baseline_cron_guard$;

SELECT cron.schedule('auto-expire-quotes', '5 6 * * *', 'SELECT public.auto_expire_quotes()');
SELECT cron.schedule('check-remainder-reminders', '30 6 * * *', 'SELECT public.check_remainder_reminders()');
SELECT cron.schedule('check-unpriced-orders', '10 6 * * *', 'SELECT public.check_unpriced_orders()');
SELECT cron.schedule('data-integrity-sweep', '45 6 * * *', 'SELECT public.run_data_integrity_sweep()');
SELECT cron.schedule('mark-overdue-invoices', '0 6 * * *', 'SELECT public.mark_overdue_invoices()');
SELECT cron.schedule('morning-notification-checks', '20 11 * * *', 'SELECT public.run_morning_notification_checks()');
SELECT cron.schedule('release-expired-quote-holds', '15 6 * * *', 'SELECT public.release_expired_quote_holds()');
SELECT cron.schedule('weekly-db-backup', '0 7 * * 0', 'SELECT public.run_weekly_db_backup()');

DO $baseline_cron_postflight$
DECLARE
  v_expected jsonb := jsonb_build_object(
    'auto-expire-quotes', jsonb_build_object('schedule', '5 6 * * *', 'command', 'SELECT public.auto_expire_quotes()'),
    'check-remainder-reminders', jsonb_build_object('schedule', '30 6 * * *', 'command', 'SELECT public.check_remainder_reminders()'),
    'check-unpriced-orders', jsonb_build_object('schedule', '10 6 * * *', 'command', 'SELECT public.check_unpriced_orders()'),
    'data-integrity-sweep', jsonb_build_object('schedule', '45 6 * * *', 'command', 'SELECT public.run_data_integrity_sweep()'),
    'mark-overdue-invoices', jsonb_build_object('schedule', '0 6 * * *', 'command', 'SELECT public.mark_overdue_invoices()'),
    'morning-notification-checks', jsonb_build_object('schedule', '20 11 * * *', 'command', 'SELECT public.run_morning_notification_checks()'),
    'release-expired-quote-holds', jsonb_build_object('schedule', '15 6 * * *', 'command', 'SELECT public.release_expired_quote_holds()'),
    'weekly-db-backup', jsonb_build_object('schedule', '0 7 * * 0', 'command', 'SELECT public.run_weekly_db_backup()')
  );
  v_actual jsonb;
BEGIN
  SELECT jsonb_object_agg(
           expected.key,
           expected.value || jsonb_build_object('database', 'postgres', 'username', 'postgres')
           ORDER BY expected.key
         )
    INTO v_expected
    FROM jsonb_each(v_expected) expected;

  SELECT jsonb_object_agg(
           j.jobname,
           jsonb_build_object(
             'schedule', j.schedule,
             'command', j.command,
             'database', j.database,
             'username', j.username
           )
           ORDER BY j.jobname
         )
    INTO v_actual
    FROM cron.job j
   WHERE j.active
     AND j.jobname = ANY (ARRAY[
       'auto-expire-quotes',
       'check-remainder-reminders',
       'check-unpriced-orders',
       'data-integrity-sweep',
       'mark-overdue-invoices',
       'morning-notification-checks',
       'release-expired-quote-holds',
       'weekly-db-backup'
     ]);

  IF v_actual IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'BASELINE_CRON_POSTFLIGHT_FAILED';
  END IF;
END;
$baseline_cron_postflight$;

COMMIT;
