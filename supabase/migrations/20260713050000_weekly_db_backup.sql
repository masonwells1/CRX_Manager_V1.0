-- Weekly automated in-database backup (2026-07-12).
-- Free Supabase plan has no point-in-time recovery. This is an automated,
-- zero-touch safety net against the everyday risk: a bad edit / accidental
-- delete / corruption on a table. It snapshots every public table's rows into
-- a private, admin-only backup_snapshots table once a week and keeps 8 weeks.
-- Restore = read the snapshot's `data` jsonb back into the table.
-- NOTE: this lives in the same database, so it is NOT an off-site copy for a
-- total-Supabase-loss scenario (deliberate trade-off, owner-approved).

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;

-- 1. Private snapshot store -------------------------------------------------
CREATE TABLE IF NOT EXISTS public.backup_snapshots (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  taken_at   timestamptz NOT NULL DEFAULT now(),
  table_name text        NOT NULL,
  row_count  integer     NOT NULL,
  data       jsonb       NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_backup_snapshots_taken_at
  ON public.backup_snapshots (taken_at DESC);

ALTER TABLE public.backup_snapshots ENABLE ROW LEVEL SECURITY;

-- Admins may READ snapshots (to inspect/restore). Nobody may write via the API
-- --- only the SECURITY DEFINER cron function below inserts (as table owner,
-- bypassing RLS). No INSERT/UPDATE/DELETE policy exists, so authenticated/anon
-- callers can never mutate the backup store even though SELECT is granted.
DROP POLICY IF EXISTS backup_snapshots_admin_read ON public.backup_snapshots;
CREATE POLICY backup_snapshots_admin_read
  ON public.backup_snapshots
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

REVOKE ALL ON public.backup_snapshots FROM anon;
REVOKE ALL ON public.backup_snapshots FROM authenticated;
GRANT SELECT ON public.backup_snapshots TO authenticated; -- gated to admins by RLS

-- 1b. Run log ---------------------------------------------------------------
-- One row per backup run so a partial/zero backup is VISIBLE and never looks
-- successful just because pg_cron saw the SELECT return. `succeeded` is false
-- whenever any table failed; retention pruning is skipped on a failed run
-- (below) so a broken backup can never delete older good snapshots.
CREATE TABLE IF NOT EXISTS public.backup_runs (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ran_at           timestamptz NOT NULL DEFAULT now(),
  tables_backed_up integer     NOT NULL,
  rows_backed_up   bigint      NOT NULL,
  failed           jsonb       NOT NULL DEFAULT '[]'::jsonb,
  succeeded        boolean     NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backup_runs_ran_at ON public.backup_runs (ran_at DESC);
ALTER TABLE public.backup_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS backup_runs_admin_read ON public.backup_runs;
CREATE POLICY backup_runs_admin_read
  ON public.backup_runs FOR SELECT TO authenticated USING (public.is_admin());
REVOKE ALL ON public.backup_runs FROM anon;
REVOKE ALL ON public.backup_runs FROM authenticated;
GRANT SELECT ON public.backup_runs TO authenticated; -- gated to admins by RLS

-- 2. The backup routine -----------------------------------------------------
-- Internal cron-only routine (NOT a user-facing RPC — revoked from anon &
-- authenticated below, so the p_idempotency_key convention does not apply;
-- re-running just writes another dated snapshot, which prune trims).
CREATE OR REPLACE FUNCTION public.run_weekly_db_backup()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ts        timestamptz := now();
  v_tbl       text;
  v_tables    integer := 0;
  v_rows      bigint  := 0;
  v_failed    text[]  := '{}';
  v_succeeded boolean;
BEGIN
  FOR v_tbl IN
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT IN ('backup_snapshots', 'backup_runs')
    ORDER BY tablename
  LOOP
    -- Each table is isolated: if ONE table fails (e.g. a future giant table
    -- exceeds the ~1GB single-jsonb ceiling, or any other error) it is recorded
    -- in v_failed and the backup CONTINUES with the rest, so one bad table can
    -- never silently kill the whole safety net.
    -- to_jsonb(t.*) is lossless for every column type (geometry etc. serialize
    -- to their exact text form); empty tables store an empty array.
    BEGIN
      EXECUTE format(
        'INSERT INTO public.backup_snapshots (taken_at, table_name, row_count, data) '
        'SELECT $1, $2, count(*)::int, COALESCE(jsonb_agg(to_jsonb(t.*)), ''[]''::jsonb) '
        'FROM public.%I t',
        v_tbl
      ) USING v_ts, v_tbl;
      v_tables := v_tables + 1;
    EXCEPTION WHEN OTHERS THEN
      v_failed := array_append(v_failed, v_tbl || ': ' || SQLERRM);
    END;
  END LOOP;

  SELECT COALESCE(sum(row_count), 0)
    INTO v_rows
    FROM public.backup_snapshots
   WHERE taken_at = v_ts;

  -- A run only counts as succeeded if EVERY table was captured AND at least one
  -- table actually was — a zero-table run must never count as success (else the
  -- prune below would delete older good snapshots while backing up nothing).
  v_succeeded := (array_length(v_failed, 1) IS NULL) AND v_tables > 0;

  -- Persist + expose the outcome of every run (pg_cron only records that the
  -- SELECT returned, not whether tables failed, so this is the real audit).
  INSERT INTO public.backup_runs (ran_at, tables_backed_up, rows_backed_up, failed, succeeded)
  VALUES (v_ts, v_tables, v_rows, to_jsonb(v_failed), v_succeeded);

  -- Retention: keep 8 weeks — but ONLY prune after a FULLY successful run, so a
  -- broken/partial backup can never delete older good snapshots.
  IF v_succeeded THEN
    DELETE FROM public.backup_snapshots
     WHERE taken_at < now() - interval '56 days';
    DELETE FROM public.backup_runs
     WHERE ran_at < now() - interval '56 days';
  END IF;

  RETURN json_build_object(
    'taken_at',  v_ts,
    'succeeded', v_succeeded,
    'tables',    v_tables,
    'rows',      v_rows,
    'failed',    to_jsonb(v_failed)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.run_weekly_db_backup() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.run_weekly_db_backup() FROM anon;
REVOKE ALL ON FUNCTION public.run_weekly_db_backup() FROM authenticated;

-- 3. Schedule: every Sunday 07:00 UTC (~01:00 America/Chicago — quiet time).
-- Idempotent: drop any prior schedule of the same name before (re)creating.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'weekly-db-backup') THEN
    PERFORM cron.unschedule('weekly-db-backup');
  END IF;
END;
$$;

SELECT cron.schedule(
  'weekly-db-backup',
  '0 7 * * 0',
  $$SELECT public.run_weekly_db_backup()$$
);
