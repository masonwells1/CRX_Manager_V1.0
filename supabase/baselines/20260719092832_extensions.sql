-- CRX extension prerequisites at live high-water 20260719092832.
-- Apply first on a NEW Supabase project, before the public schema baseline.
BEGIN;

DO $baseline_roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metabase_ro') THEN
    CREATE ROLE metabase_ro NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS INHERIT;
  END IF;
END;
$baseline_roles$;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS plpgsql_check WITH SCHEMA public;

DO $baseline_extension_schemas$
DECLARE
  v_mismatch text;
BEGIN
  SELECT string_agg(e.extname || ' is in ' || n.nspname, ', ' ORDER BY e.extname)
    INTO v_mismatch
  FROM pg_extension e
  JOIN pg_namespace n ON n.oid = e.extnamespace
  JOIN (VALUES
    ('pgcrypto', 'extensions'),
    ('postgis', 'extensions'),
    ('uuid-ossp', 'extensions')
  ) AS required(extname, schema_name) ON required.extname = e.extname
  WHERE n.nspname <> required.schema_name;

  IF v_mismatch IS NOT NULL THEN
    RAISE EXCEPTION
      'baseline extension schema mismatch: %; move these extensions before restoring the CRX baseline',
      v_mismatch;
  END IF;
END;
$baseline_extension_schemas$;

COMMIT;
