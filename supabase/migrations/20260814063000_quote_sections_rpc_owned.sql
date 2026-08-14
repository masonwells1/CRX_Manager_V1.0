-- STATUS: NOT APPLIED
-- LOCAL CANDIDATE.
--
-- quote_sections is replaced only through governed quote RPCs, but the browser
-- role still held TRUNCATE/TRIGGER/REFERENCES and three obsolete write policies.
-- RLS never protects TRUNCATE. A successful TRUNCATE or DELETE would cascade to
-- quote_items, erasing immutable quote-time cost snapshots and allowing a later
-- save to stamp a different cost basis. Make the table RPC-owned while keeping
-- quote rendering (SELECT) and owner-side SECURITY DEFINER writers intact.

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
DECLARE
  v_owner name;
BEGIN
  IF to_regclass('public.quote_sections') IS NULL
     OR to_regclass('public.quote_items') IS NULL THEN
    RAISE EXCEPTION 'QUOTE_SECTIONS_BOUNDARY_PRECONDITION: required tables are missing';
  END IF;

  SELECT r.rolname INTO v_owner
  FROM pg_class c
  JOIN pg_roles r ON r.oid = c.relowner
  WHERE c.oid = 'public.quote_sections'::regclass;

  IF v_owner IS DISTINCT FROM 'postgres'
     OR NOT EXISTS (
       SELECT 1 FROM pg_class c
       WHERE c.oid = 'public.quote_sections'::regclass
         AND c.relrowsecurity
     ) THEN
    RAISE EXCEPTION 'QUOTE_SECTIONS_BOUNDARY_PRECONDITION: owner or RLS state drifted';
  END IF;

  IF NOT has_table_privilege('authenticated', 'public.quote_sections', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.quote_sections', 'TRUNCATE')
     OR NOT has_table_privilege('authenticated', 'public.quote_sections', 'TRIGGER')
     OR NOT has_table_privilege('authenticated', 'public.quote_sections', 'REFERENCES') THEN
    RAISE EXCEPTION 'QUOTE_SECTIONS_BOUNDARY_PRECONDITION: observed authenticated ACL drifted';
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'quote_sections'
         AND policyname = 'qsections_select' AND cmd = 'SELECT'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'quote_sections'
         AND policyname = 'qsections_insert' AND cmd = 'INSERT'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'quote_sections'
         AND policyname = 'qsections_update' AND cmd = 'UPDATE'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'quote_sections'
         AND policyname = 'qsections_delete' AND cmd = 'DELETE'
     ) THEN
    RAISE EXCEPTION 'QUOTE_SECTIONS_BOUNDARY_PRECONDITION: expected policy set drifted';
  END IF;
END;
$preflight$;

LOCK TABLE public.quote_sections IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.quote_items IN ACCESS EXCLUSIVE MODE;

DROP POLICY IF EXISTS qsections_insert ON public.quote_sections;
DROP POLICY IF EXISTS qsections_update ON public.quote_sections;
DROP POLICY IF EXISTS qsections_delete ON public.quote_sections;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
  ON TABLE public.quote_sections FROM PUBLIC, anon, authenticated, service_role;

DO $postflight$
DECLARE
  v_role name;
  v_priv text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon'::name, 'authenticated'::name, 'service_role'::name]
  LOOP
    FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES']
    LOOP
      IF has_table_privilege(v_role, 'public.quote_sections', v_priv) THEN
        RAISE EXCEPTION 'QUOTE_SECTIONS_BOUNDARY_POSTCONDITION: % still holds %', v_role, v_priv;
      END IF;
    END LOOP;

    FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'REFERENCES']
    LOOP
      IF has_any_column_privilege(v_role, 'public.quote_sections', v_priv) THEN
        RAISE EXCEPTION 'QUOTE_SECTIONS_BOUNDARY_POSTCONDITION: % still holds column-level %', v_role, v_priv;
      END IF;
    END LOOP;
  END LOOP;

  IF EXISTS (
       SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'quote_sections'
         AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
     ) THEN
    RAISE EXCEPTION 'QUOTE_SECTIONS_BOUNDARY_POSTCONDITION: browser write policy remains';
  END IF;

  IF NOT has_table_privilege('authenticated', 'public.quote_sections', 'SELECT')
     OR NOT has_table_privilege('anon', 'public.quote_sections', 'SELECT')
     OR NOT EXISTS (
       SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'quote_sections'
         AND policyname = 'qsections_select' AND cmd = 'SELECT'
     ) THEN
    RAISE EXCEPTION 'QUOTE_SECTIONS_BOUNDARY_POSTCONDITION: read path changed';
  END IF;
END;
$postflight$;
