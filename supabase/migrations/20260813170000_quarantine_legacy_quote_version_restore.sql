-- Quarantine quote-version snapshots created before browser writes were revoked.
--
-- STATUS: NOT APPLIED
-- LOCAL CANDIDATE.
--
-- Before 20260813080000, authenticated users could INSERT directly into
-- quote_versions. Restore treats snapshot_data as authoritative money: it can
-- replace quote/item prices, profit, product cost snapshots, and downstream
-- commission inputs. The write-boundary migration rejects obviously suspicious
-- legacy costs, but no heuristic can prove that every plausible historical
-- price/profit/cost combination came from the server-side writer.
--
-- This forward-only migration takes the conservative path. Every version that
-- exists when this migration acquires its quote_versions lock is recorded in a
-- private quarantine table and becomes view-only history. Versions created
-- after the already-required RPC-only boundary are not quarantined and remain
-- restorable. No quote/version business row is changed or deleted.
--
-- Supabase apply_migration owns the outer transaction. Do not add BEGIN/COMMIT:
-- the population boundary, wrapper replacement, ACLs, and postconditions must
-- be atomic.

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
DECLARE
  v_wrapper regprocedure := to_regprocedure(
    'public.restore_quote_version(uuid,uuid,uuid,text,bigint,text)'
  );
BEGIN
  IF to_regclass('public.quote_versions') IS NULL OR v_wrapper IS NULL THEN
    RAISE EXCEPTION 'QUOTE_VERSION_QUARANTINE_DRIFT: expected restore surface is incomplete';
  END IF;

  IF to_regclass('public.quote_version_restore_quarantine') IS NOT NULL THEN
    RAISE EXCEPTION 'QUOTE_VERSION_QUARANTINE_DRIFT: quarantine relation already exists';
  END IF;

  IF (SELECT count(*) FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND proname = 'restore_quote_version') <> 1
     OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = v_wrapper)
       <> '322a16413d9ec087ebff86b7ba3bd82c'
     OR NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_wrapper)
     OR (SELECT p.proconfig FROM pg_proc p WHERE p.oid = v_wrapper)
       IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR (SELECT p.proowner FROM pg_proc p WHERE p.oid = v_wrapper)
       <> 'postgres'::regrole THEN
    RAISE EXCEPTION 'QUOTE_VERSION_QUARANTINE_DRIFT: governed restore wrapper changed';
  END IF;

  -- 20260813080000 must already have closed every browser mutation path. If
  -- it has not, a new forged version could arrive after this migration commits
  -- and escape the quarantine population.
  IF has_table_privilege('anon', 'public.quote_versions', 'INSERT')
     OR has_table_privilege('anon', 'public.quote_versions', 'UPDATE')
     OR has_table_privilege('anon', 'public.quote_versions', 'DELETE')
     OR has_table_privilege('authenticated', 'public.quote_versions', 'INSERT')
     OR has_table_privilege('authenticated', 'public.quote_versions', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.quote_versions', 'DELETE')
     OR has_any_column_privilege('anon', 'public.quote_versions', 'INSERT')
     OR has_any_column_privilege('anon', 'public.quote_versions', 'UPDATE')
     OR has_any_column_privilege('authenticated', 'public.quote_versions', 'INSERT')
     OR has_any_column_privilege('authenticated', 'public.quote_versions', 'UPDATE')
     OR EXISTS (
       SELECT 1
       FROM pg_policies
       WHERE schemaname = 'public'
         AND tablename = 'quote_versions'
         AND cmd IN ('ALL', 'INSERT', 'UPDATE', 'DELETE')
     ) THEN
    RAISE EXCEPTION 'QUOTE_VERSION_QUARANTINE_DRIFT: RPC-only browser write boundary is not active';
  END IF;

  IF has_function_privilege('anon', v_wrapper, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_wrapper, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_wrapper, 'EXECUTE') THEN
    RAISE EXCEPTION 'QUOTE_VERSION_QUARANTINE_DRIFT: governed restore ACL changed';
  END IF;
END;
$preflight$;

CREATE TABLE public.quote_version_restore_quarantine (
  version_id uuid PRIMARY KEY
    REFERENCES public.quote_versions(id) ON DELETE CASCADE,
  quarantined_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  reason text NOT NULL DEFAULT 'pre_rpc_owned_snapshot'
    CHECK (reason = 'pre_rpc_owned_snapshot')
);

COMMENT ON TABLE public.quote_version_restore_quarantine IS
  'Quote versions that predate the RPC-only write boundary and are view-only, never restorable.';

ALTER TABLE public.quote_version_restore_quarantine ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quote_version_restore_quarantine FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.quote_version_restore_quarantine
  FROM PUBLIC, anon, authenticated, service_role;

-- Freeze the boundary. A server-side version insert that began concurrently
-- either commits before this lock and is quarantined or waits until this
-- transaction commits and is therefore post-boundary and trusted.
LOCK TABLE public.quote_versions IN ACCESS EXCLUSIVE MODE;

INSERT INTO public.quote_version_restore_quarantine (version_id)
SELECT qv.id
FROM public.quote_versions qv
ORDER BY qv.id;

CREATE FUNCTION public._guard_quote_version_restore_quarantine_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'QUOTE_VERSION_RESTORE_QUARANTINE_IMMUTABLE';
END;
$function$;

CREATE TRIGGER guard_quote_version_restore_quarantine_immutable
BEFORE UPDATE OR DELETE ON public.quote_version_restore_quarantine
FOR EACH ROW
EXECUTE FUNCTION public._guard_quote_version_restore_quarantine_immutable();

REVOKE ALL ON FUNCTION public._guard_quote_version_restore_quarantine_immutable()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._guard_quote_version_restore_quarantine_immutable()
  TO postgres;

CREATE OR REPLACE FUNCTION public.restore_quote_version(
  p_quote_id uuid,
  p_version_id uuid,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL,
  p_expected_row_version bigint DEFAULT NULL,
  p_below_cost_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._begin_below_cost_money_write(
    'restore_quote_version', p_performed_by,
    jsonb_build_object('below_cost_reason', p_below_cost_reason)
  );

  IF EXISTS (
    SELECT 1
    FROM public.quote_version_restore_quarantine q
    WHERE q.version_id = p_version_id
  ) THEN
    RAISE EXCEPTION 'QUOTE_VERSION_RESTORE_QUARANTINED';
  END IF;

  RETURN public._restore_quote_version_below_cost_impl_20260810(
    p_quote_id, p_version_id, p_performed_by, p_idempotency_key,
    p_expected_row_version
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.restore_quote_version(
  uuid, uuid, uuid, text, bigint, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_quote_version(
  uuid, uuid, uuid, text, bigint, text
) TO authenticated, service_role;

DO $postflight$
DECLARE
  v_wrapper regprocedure := to_regprocedure(
    'public.restore_quote_version(uuid,uuid,uuid,text,bigint,text)'
  );
  v_source text;
  v_rel record;
  v_guard regprocedure := to_regprocedure(
    'public._guard_quote_version_restore_quarantine_immutable()'
  );
BEGIN
  SELECT p.prosrc INTO v_source FROM pg_proc p WHERE p.oid = v_wrapper;
  SELECT c.relrowsecurity, c.relforcerowsecurity, c.relowner
    INTO v_rel
  FROM pg_class c
  WHERE c.oid = 'public.quote_version_restore_quarantine'::regclass;

  IF v_wrapper IS NULL
     OR position('QUOTE_VERSION_RESTORE_QUARANTINED' in v_source) = 0
     OR position('quote_version_restore_quarantine' in v_source) = 0
     OR position('quote_version_restore_quarantine' in v_source)
        > position('_restore_quote_version_below_cost_impl_20260810' in v_source)
     OR NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_wrapper)
     OR (SELECT p.proconfig FROM pg_proc p WHERE p.oid = v_wrapper)
       IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR (SELECT p.proowner FROM pg_proc p WHERE p.oid = v_wrapper)
       <> 'postgres'::regrole THEN
    RAISE EXCEPTION 'QUOTE_VERSION_QUARANTINE_POSTCONDITION_FAILED: restore wrapper is not fail-closed';
  END IF;

  IF NOT v_rel.relrowsecurity
     OR NOT v_rel.relforcerowsecurity
     OR v_rel.relowner <> 'postgres'::regrole
     OR EXISTS (
       SELECT 1 FROM pg_policies
       WHERE schemaname = 'public'
         AND tablename = 'quote_version_restore_quarantine'
     )
     OR has_table_privilege('anon', 'public.quote_version_restore_quarantine', 'SELECT')
     OR has_table_privilege('anon', 'public.quote_version_restore_quarantine', 'INSERT')
     OR has_table_privilege('authenticated', 'public.quote_version_restore_quarantine', 'SELECT')
     OR has_table_privilege('authenticated', 'public.quote_version_restore_quarantine', 'INSERT')
     OR has_table_privilege('service_role', 'public.quote_version_restore_quarantine', 'SELECT')
     OR has_table_privilege('service_role', 'public.quote_version_restore_quarantine', 'INSERT') THEN
    RAISE EXCEPTION 'QUOTE_VERSION_QUARANTINE_POSTCONDITION_FAILED: quarantine table is exposed';
  END IF;

  IF v_guard IS NULL
     OR (SELECT p.proconfig FROM pg_proc p WHERE p.oid = v_guard)
       IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR position('QUOTE_VERSION_RESTORE_QUARANTINE_IMMUTABLE' in
       (SELECT p.prosrc FROM pg_proc p WHERE p.oid = v_guard)) = 0
     OR has_function_privilege('anon', v_guard, 'EXECUTE')
     OR has_function_privilege('authenticated', v_guard, 'EXECUTE')
     OR has_function_privilege('service_role', v_guard, 'EXECUTE')
     OR NOT has_function_privilege('postgres', v_guard, 'EXECUTE')
     OR NOT EXISTS (
       SELECT 1
       FROM pg_trigger t
       WHERE t.tgrelid = 'public.quote_version_restore_quarantine'::regclass
         AND t.tgname = 'guard_quote_version_restore_quarantine_immutable'
         AND t.tgfoid = v_guard
         AND t.tgenabled IN ('O', 'A')
         AND NOT t.tgisinternal
     ) THEN
    RAISE EXCEPTION 'QUOTE_VERSION_QUARANTINE_POSTCONDITION_FAILED: quarantine set is mutable';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.quote_versions qv
    LEFT JOIN public.quote_version_restore_quarantine q
      ON q.version_id = qv.id
    WHERE q.version_id IS NULL
  ) THEN
    RAISE EXCEPTION 'QUOTE_VERSION_QUARANTINE_POSTCONDITION_FAILED: a pre-boundary version escaped quarantine';
  END IF;

  IF has_function_privilege('anon', v_wrapper, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_wrapper, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_wrapper, 'EXECUTE') THEN
    RAISE EXCEPTION 'QUOTE_VERSION_QUARANTINE_POSTCONDITION_FAILED: restore ACL changed';
  END IF;
END;
$postflight$;
