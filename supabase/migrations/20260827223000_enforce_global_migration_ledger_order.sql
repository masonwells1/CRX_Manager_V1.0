-- Global forward-only ledger guard for every production migration channel.
-- Source-only in this change: apply separately through the existing reviewed manual path.

SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION supabase_migrations.crx_enforce_monotonic_migration_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  authored_version text;
  latest_version text;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(1129465937);

  IF coalesce(NEW.name, '') !~ '^[0-9]{14}(_|$)' THEN
    RAISE EXCEPTION 'CRX migration ledger rows require an authored timestamp in name';
  END IF;
  authored_version := left(NEW.name, 14);

  SELECT max(effective_version) INTO latest_version
  FROM (
    SELECT CASE
      WHEN coalesce(name, '') ~ '^[0-9]{14}(_|$)' THEN left(name, 14)
      WHEN coalesce(version, '') ~ '^[0-9]{14}$' THEN version
      ELSE NULL
    END AS effective_version
    FROM supabase_migrations.schema_migrations
  ) ledger
  WHERE effective_version IS NOT NULL;

  IF latest_version IS NOT NULL AND authored_version <= latest_version THEN
    RAISE EXCEPTION 'CRX migration ledger ordering violation: authored %, live high-water %',
      authored_version, latest_version;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION supabase_migrations.crx_enforce_monotonic_migration_ledger()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS crx_enforce_monotonic_migration_ledger
  ON supabase_migrations.schema_migrations;

CREATE TRIGGER crx_enforce_monotonic_migration_ledger
BEFORE INSERT ON supabase_migrations.schema_migrations
FOR EACH ROW
EXECUTE FUNCTION supabase_migrations.crx_enforce_monotonic_migration_ledger();

ALTER TABLE supabase_migrations.schema_migrations
  ENABLE ALWAYS TRIGGER crx_enforce_monotonic_migration_ledger;

DO $verify$
BEGIN
  IF (SELECT count(*)
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE t.tgrelid = 'supabase_migrations.schema_migrations'::regclass
        AND NOT t.tgisinternal
        AND t.tgname = 'crx_enforce_monotonic_migration_ledger'
        AND t.tgtype = 7
        AND t.tgenabled = 'A'
        AND t.tgqual IS NULL
        AND t.tgnargs = 0
        AND n.nspname = 'supabase_migrations'
        AND p.proname = 'crx_enforce_monotonic_migration_ledger'
        AND pg_catalog.pg_get_function_identity_arguments(p.oid) = ''
        AND p.prorettype = 'pg_catalog.trigger'::regtype
        AND p.prosecdef
        AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']::text[]) <> 1 THEN
    RAISE EXCEPTION 'CRX global migration ledger ordering guard verification failed';
  END IF;
END;
$verify$;

DO $replica_probe$
DECLARE
  latest_version text;
  probe_counter bigint := 0;
  probe_version text;
  guard_blocked boolean := false;
BEGIN
  SELECT max(effective_version) INTO latest_version
  FROM (
    SELECT CASE
      WHEN coalesce(name, '') ~ '^[0-9]{14}(_|$)' THEN left(name, 14)
      WHEN coalesce(version, '') ~ '^[0-9]{14}$' THEN version
      ELSE NULL
    END AS effective_version
    FROM supabase_migrations.schema_migrations
  ) ledger
  WHERE effective_version IS NOT NULL;

  IF latest_version IS NULL THEN
    RAISE EXCEPTION 'CRX global migration ledger ordering guard requires a non-empty authored baseline';
  END IF;

  LOOP
    probe_version := pg_catalog.lpad(probe_counter::text, 14, '0');
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = probe_version
    );
    probe_counter := probe_counter + 1;
    IF probe_counter >= latest_version::bigint THEN
      RAISE EXCEPTION 'CRX global migration ledger ordering guard could not allocate a rollback-only probe version';
    END IF;
  END LOOP;

  PERFORM pg_catalog.set_config('session_replication_role', 'replica', true);
  BEGIN
    INSERT INTO supabase_migrations.schema_migrations(version, statements, name)
    VALUES (probe_version, ARRAY['CRX rollback-only replica-mode probe'], probe_version || '_crx_replica_mode_probe');
    RAISE EXCEPTION USING
      ERRCODE = 'CRX01',
      MESSAGE = 'CRX global migration ledger ordering guard was bypassed in replica mode';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM LIKE 'CRX migration ledger ordering violation:%' THEN
        guard_blocked := true;
      ELSE
        RAISE;
      END IF;
    WHEN SQLSTATE 'CRX01' THEN
      guard_blocked := false;
  END;
  PERFORM pg_catalog.set_config('session_replication_role', 'origin', true);

  IF NOT guard_blocked THEN
    RAISE EXCEPTION 'CRX global migration ledger ordering guard replica-mode verification failed';
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    PERFORM pg_catalog.set_config('session_replication_role', 'origin', true);
    RAISE;
END;
$replica_probe$;
