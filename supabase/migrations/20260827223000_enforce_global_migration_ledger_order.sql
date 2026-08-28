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
        AND t.tgenabled = 'O'
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
