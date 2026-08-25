-- STATUS: NOT APPLIED
-- CRX-SEC-1 follow-up: a direct quote_versions write was possible before
-- 20260813080000 removes the browser write path. A normal-looking legacy row
-- cannot prove it came through the owner RPC, so it must not become a trusted
-- money source merely because the boundary is now closed.
--
-- This preserves history for display, marks only versions created by the RPC
-- after this migration as restorable, and rejects an unmarked version before it
-- can rebuild quote_items.cost_at_quote_cents. It deliberately does not
-- backfill existing rows: that would turn an unprovable assertion into trust.

SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '10s';

DO $precond$
BEGIN
  -- This marker is meaningful only after 20260813080000 has made version
  -- writes RPC-owned. Timestamp ordering is not an apply-order guarantee: if
  -- this file were applied first, a browser could insert a row and supply its
  -- own non-null marker. Fail closed on the complete live boundary instead.
  IF EXISTS (
    SELECT 1 FROM pg_policy p
    WHERE p.polrelid = 'public.quote_versions'::regclass
      AND p.polcmd IN ('a', 'w', 'd', '*')
  ) OR has_table_privilege('authenticated', 'public.quote_versions', 'INSERT')
     OR has_table_privilege('authenticated', 'public.quote_versions', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.quote_versions', 'DELETE')
     OR has_table_privilege('authenticated', 'public.quote_versions', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.quote_versions', 'TRIGGER')
     OR has_table_privilege('authenticated', 'public.quote_versions', 'REFERENCES')
     OR has_table_privilege('anon', 'public.quote_versions', 'INSERT')
     OR has_table_privilege('anon', 'public.quote_versions', 'UPDATE')
     OR has_table_privilege('anon', 'public.quote_versions', 'DELETE')
     OR has_table_privilege('anon', 'public.quote_versions', 'TRUNCATE')
     OR has_table_privilege('anon', 'public.quote_versions', 'TRIGGER')
     OR has_table_privilege('anon', 'public.quote_versions', 'REFERENCES')
     OR has_any_column_privilege('authenticated', 'public.quote_versions', 'INSERT')
     OR has_any_column_privilege('authenticated', 'public.quote_versions', 'UPDATE')
     OR has_any_column_privilege('authenticated', 'public.quote_versions', 'REFERENCES')
     OR has_any_column_privilege('anon', 'public.quote_versions', 'INSERT')
     OR has_any_column_privilege('anon', 'public.quote_versions', 'UPDATE')
     OR has_any_column_privilege('anon', 'public.quote_versions', 'REFERENCES') THEN
    RAISE EXCEPTION 'PRECOND: 20260813080000 quote_versions RPC-only write boundary is not fully present; refuse to create a forgeable trust marker';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = 'public.quote_versions'::regclass
      AND a.attname = 'restore_trusted_at'
      AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION 'PRECOND: quote_versions.restore_trusted_at already exists. Refusing to inherit an unreviewed trust marker or backfill state.';
  END IF;
  IF to_regprocedure('public.create_quote_version(uuid,uuid,text,text,bigint)') IS NULL
     OR to_regprocedure('public.restore_quote_version(uuid,uuid,uuid,text,bigint,text)') IS NULL
     OR to_regprocedure('public._restore_quote_version_below_cost_impl_20260810(uuid,uuid,uuid,text,bigint)') IS NULL
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'restore_quote_version') <> 1
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = '_restore_quote_version_below_cost_impl_20260810') <> 1 THEN
    RAISE EXCEPTION 'PRECOND: expected quote-version RPC signatures are missing; re-review before applying the trust boundary';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = 'public.restore_quote_version(uuid,uuid,uuid,text,bigint,text)'::regprocedure
      AND p.prosecdef
      AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) c(value) WHERE replace(c.value, ' ', '') = 'search_path=public,pg_temp')
      AND p.prosrc LIKE '%_restore_quote_version_below_cost_impl_20260810%'
  ) THEN
    RAISE EXCEPTION 'PRECOND: public restore wrapper is not the pinned SECURITY DEFINER route to the guarded implementation';
  END IF;
  IF has_function_privilege('anon', 'public.restore_quote_version(uuid,uuid,uuid,text,bigint,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.restore_quote_version(uuid,uuid,uuid,text,bigint,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._restore_quote_version_below_cost_impl_20260810(uuid,uuid,uuid,text,bigint)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._restore_quote_version_below_cost_impl_20260810(uuid,uuid,uuid,text,bigint)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PRECOND: restore API grants do not match the trusted wrapper/private implementation boundary';
  END IF;
END;
$precond$;

ALTER TABLE public.quote_versions
  ADD COLUMN restore_trusted_at timestamptz;

-- The outer create wrapper owns caller and row-version checks. Mark only its
-- first successful result, after the owner-side writer constructs the snapshot
-- from typed database rows. Cached retries return before this point, so they
-- cannot bless a pre-boundary row with a reused idempotency key.
CREATE OR REPLACE FUNCTION public.create_quote_version(
  p_quote_id uuid,
  p_performed_by uuid,
  p_method text DEFAULT 'presented',
  p_idempotency_key text DEFAULT NULL,
  p_expected_row_version bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid;
  v_actor_role text;
  v_quote_owner uuid;
  v_current_row_version bigint;
  v_post_row_version bigint;
  v_existing jsonb;
  v_result jsonb;
  v_version_id uuid;
  v_cache_rows integer;
  v_trust_rows integer;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role INTO v_actor_role FROM public.profiles
  WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep');
  IF v_actor_role IS NULL THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  SELECT created_by INTO v_quote_owner FROM public.quotes
  WHERE id = p_quote_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found: %', p_quote_id; END IF;
  IF v_actor_role <> 'admin' AND v_quote_owner IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'NOT_QUOTE_OWNER';
  END IF;
  IF p_expected_row_version IS NULL OR p_expected_row_version < 1 THEN
    RAISE EXCEPTION 'QUOTE_STALE_WRITE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'create_quote_version');
  END IF;

  SELECT created_by, row_version INTO v_quote_owner, v_current_row_version
  FROM public.quotes WHERE id = p_quote_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found: %', p_quote_id; END IF;
  IF v_actor_role <> 'admin' AND v_quote_owner IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'NOT_QUOTE_OWNER';
  END IF;

  IF v_existing IS NOT NULL THEN
    IF jsonb_typeof(v_existing) IS DISTINCT FROM 'object'
       OR v_existing->>'_quote_id' IS DISTINCT FROM p_quote_id::text
       OR v_existing->>'_actor_id' IS DISTINCT FROM v_actor::text
       OR v_existing->>'_method' IS DISTINCT FROM p_method
       OR COALESCE(v_existing->>'_expected_row_version', '') !~ '^[1-9][0-9]*$'
       OR (v_existing->>'_expected_row_version')::bigint IS DISTINCT FROM p_expected_row_version
       OR COALESCE(v_existing->>'_post_row_version', '') !~ '^[1-9][0-9]*$'
       OR (v_existing->>'_post_row_version')::bigint IS DISTINCT FROM v_current_row_version THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT';
    END IF;
    v_version_id := NULLIF(v_existing->>'version_id', '')::uuid;
    IF v_version_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.quote_versions WHERE id = v_version_id AND quote_id = p_quote_id
    ) THEN RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT'; END IF;
    RETURN (v_existing - '_quote_id' - '_actor_id' - '_method'
      - '_expected_row_version' - '_post_row_version')
      || jsonb_build_object('status', 'duplicate', 'message', 'Already processed');
  END IF;

  IF v_current_row_version IS DISTINCT FROM p_expected_row_version THEN
    RAISE EXCEPTION 'QUOTE_STALE_WRITE';
  END IF;

  v_result := public._create_quote_version_owner_impl(
    p_quote_id, p_performed_by, p_method, p_idempotency_key
  );
  v_version_id := NULLIF(v_result->>'version_id', '')::uuid;
  IF v_result->>'status' IS DISTINCT FROM 'created' OR v_version_id IS NULL THEN
    RAISE EXCEPTION 'QUOTE_VERSION_TRUST_MARK_FAILED';
  END IF;
  UPDATE public.quote_versions
     SET restore_trusted_at = clock_timestamp()
   WHERE id = v_version_id AND quote_id = p_quote_id AND restore_trusted_at IS NULL;
  GET DIAGNOSTICS v_trust_rows = ROW_COUNT;
  IF v_trust_rows <> 1 THEN RAISE EXCEPTION 'QUOTE_VERSION_TRUST_MARK_FAILED'; END IF;

  SELECT row_version INTO v_post_row_version FROM public.quotes WHERE id = p_quote_id;
  v_result := v_result || jsonb_build_object('row_version', v_post_row_version);
  IF p_idempotency_key IS NOT NULL THEN
    UPDATE public.idempotency_keys
    SET result = v_result || jsonb_build_object(
      '_quote_id', p_quote_id, '_actor_id', v_actor, '_method', p_method,
      '_expected_row_version', p_expected_row_version, '_post_row_version', v_post_row_version
    )
    WHERE idempotency_key = p_idempotency_key AND operation = 'create_quote_version';
    GET DIAGNOSTICS v_cache_rows = ROW_COUNT;
    IF v_cache_rows <> 1 THEN RAISE EXCEPTION 'IDEMPOTENCY_CACHE_WRITE_FAILED'; END IF;
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.create_quote_version(uuid, uuid, text, text, bigint)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_quote_version(uuid, uuid, text, text, bigint)
  TO authenticated, service_role;

-- This private implementation owns idempotency replay. Put the trust check
-- after a validated cached replay, so a retry of a pre-migration restore remains
-- a no-op response, but before quote rows can be rebuilt from an old snapshot.
CREATE OR REPLACE FUNCTION public._restore_quote_version_below_cost_impl_20260810(
  p_quote_id uuid,
  p_version_id uuid,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL,
  p_expected_row_version bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid;
  v_actor_role text;
  v_quote_owner uuid;
  v_current_row_version bigint;
  v_post_row_version bigint;
  v_existing jsonb;
  v_result jsonb;
  v_cache_rows integer;
  v_restore_trusted_at timestamptz;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  SELECT role INTO v_actor_role FROM public.profiles
  WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep');
  IF v_actor_role IS NULL THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  SELECT created_by INTO v_quote_owner FROM public.quotes
  WHERE id = p_quote_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found: %', p_quote_id; END IF;
  IF v_actor_role <> 'admin' AND v_quote_owner IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'NOT_QUOTE_OWNER';
  END IF;
  IF p_expected_row_version IS NULL OR p_expected_row_version < 1 THEN
    RAISE EXCEPTION 'QUOTE_STALE_WRITE';
  END IF;
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'restore_quote_version');
  END IF;

  SELECT created_by, row_version INTO v_quote_owner, v_current_row_version
  FROM public.quotes WHERE id = p_quote_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found: %', p_quote_id; END IF;
  IF v_actor_role <> 'admin' AND v_quote_owner IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'NOT_QUOTE_OWNER';
  END IF;
  SELECT restore_trusted_at INTO v_restore_trusted_at
  FROM public.quote_versions
  WHERE id = p_version_id AND quote_id = p_quote_id
  FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Version not found: %', p_version_id; END IF;

  IF v_existing IS NOT NULL THEN
    IF jsonb_typeof(v_existing) IS DISTINCT FROM 'object'
       OR v_existing->>'_quote_id' IS DISTINCT FROM p_quote_id::text
       OR v_existing->>'_version_id' IS DISTINCT FROM p_version_id::text
       OR v_existing->>'_actor_id' IS DISTINCT FROM v_actor::text
       OR COALESCE(v_existing->>'_expected_row_version', '') !~ '^[1-9][0-9]*$'
       OR (v_existing->>'_expected_row_version')::bigint IS DISTINCT FROM p_expected_row_version
       OR COALESCE(v_existing->>'_post_row_version', '') !~ '^[1-9][0-9]*$'
       OR (v_existing->>'_post_row_version')::bigint IS DISTINCT FROM v_current_row_version THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT';
    END IF;
    RETURN (v_existing - '_quote_id' - '_version_id' - '_actor_id'
      - '_expected_row_version' - '_post_row_version')
      || jsonb_build_object('status', 'duplicate', 'message', 'Already processed');
  END IF;
  IF v_current_row_version IS DISTINCT FROM p_expected_row_version THEN
    RAISE EXCEPTION 'QUOTE_STALE_WRITE';
  END IF;
  IF v_restore_trusted_at IS NULL THEN
    RAISE EXCEPTION 'QUOTE_VERSION_LEGACY_UNTRUSTED';
  END IF;

  v_result := public._restore_quote_version_owner_impl(
    p_quote_id, p_version_id, p_performed_by, p_idempotency_key
  );
  SELECT row_version INTO v_post_row_version FROM public.quotes WHERE id = p_quote_id;
  IF v_post_row_version IS DISTINCT FROM v_current_row_version + 1 THEN
    RAISE EXCEPTION 'QUOTE_ROW_VERSION_ADVANCE_INVALID';
  END IF;
  v_result := v_result || jsonb_build_object('row_version', v_post_row_version);
  IF p_idempotency_key IS NOT NULL THEN
    UPDATE public.idempotency_keys
    SET result = v_result || jsonb_build_object(
      '_quote_id', p_quote_id, '_version_id', p_version_id, '_actor_id', v_actor,
      '_expected_row_version', p_expected_row_version, '_post_row_version', v_post_row_version
    )
    WHERE idempotency_key = p_idempotency_key AND operation = 'restore_quote_version';
    GET DIAGNOSTICS v_cache_rows = ROW_COUNT;
    IF v_cache_rows <> 1 THEN RAISE EXCEPTION 'IDEMPOTENCY_CACHE_WRITE_FAILED'; END IF;
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public._restore_quote_version_below_cost_impl_20260810(uuid, uuid, uuid, text, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._restore_quote_version_below_cost_impl_20260810(uuid, uuid, uuid, text, bigint)
  TO postgres;

DO $postcond$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = 'public.quote_versions'::regclass
      AND a.attname = 'restore_trusted_at' AND NOT a.attisdropped
      AND a.atttypid = 'timestamptz'::regtype AND NOT a.attnotnull
  ) THEN
    RAISE EXCEPTION 'POSTCOND: quote_versions.restore_trusted_at has the wrong shape';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_attrdef d
    JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
    WHERE d.adrelid = 'public.quote_versions'::regclass AND a.attname = 'restore_trusted_at'
  ) OR EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = 'public.quote_versions'::regclass AND a.attname = 'restore_trusted_at'
      AND a.attgenerated <> ''
  ) OR EXISTS (
    SELECT 1 FROM public.quote_versions WHERE restore_trusted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'POSTCOND: trust marker must have no default/generated value and must leave every pre-boundary version untrusted';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policy p
    WHERE p.polrelid = 'public.quote_versions'::regclass
      AND p.polcmd IN ('a', 'w', 'd', '*')
  ) OR has_table_privilege('authenticated', 'public.quote_versions', 'INSERT')
     OR has_table_privilege('authenticated', 'public.quote_versions', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.quote_versions', 'DELETE')
     OR has_table_privilege('authenticated', 'public.quote_versions', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.quote_versions', 'TRIGGER')
     OR has_table_privilege('authenticated', 'public.quote_versions', 'REFERENCES')
     OR has_table_privilege('anon', 'public.quote_versions', 'INSERT')
     OR has_table_privilege('anon', 'public.quote_versions', 'UPDATE')
     OR has_table_privilege('anon', 'public.quote_versions', 'DELETE')
     OR has_table_privilege('anon', 'public.quote_versions', 'TRUNCATE')
     OR has_table_privilege('anon', 'public.quote_versions', 'TRIGGER')
     OR has_table_privilege('anon', 'public.quote_versions', 'REFERENCES')
     OR has_any_column_privilege('authenticated', 'public.quote_versions', 'INSERT')
     OR has_any_column_privilege('authenticated', 'public.quote_versions', 'UPDATE')
     OR has_any_column_privilege('authenticated', 'public.quote_versions', 'REFERENCES')
     OR has_any_column_privilege('anon', 'public.quote_versions', 'INSERT')
     OR has_any_column_privilege('anon', 'public.quote_versions', 'UPDATE')
     OR has_any_column_privilege('anon', 'public.quote_versions', 'REFERENCES') THEN
    RAISE EXCEPTION 'POSTCOND: quote_versions RPC-only write boundary regressed while creating the trust marker';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = 'public.create_quote_version(uuid,uuid,text,text,bigint)'::regprocedure
      AND prosrc LIKE '%restore_trusted_at = clock_timestamp()%'
  ) THEN RAISE EXCEPTION 'POSTCOND: create_quote_version no longer marks new snapshots trusted'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = 'public._restore_quote_version_below_cost_impl_20260810(uuid,uuid,uuid,text,bigint)'::regprocedure
      AND prosrc LIKE '%QUOTE_VERSION_LEGACY_UNTRUSTED%'
      AND prosrc LIKE '%restore_trusted_at%'
      AND substring(
            prosrc FROM 1 FOR greatest(
              strpos(lower(prosrc), 'raise exception ''quote_version_legacy_untrusted''') - 1,
              0
            )
          ) !~* '(insert\s+into|update\s+(only\s+)?[a-z_\"]|delete\s+from|merge\s+into|truncate\s+(table\s+)?[a-z_\"]|execute\s+|perform\s+|call\s+)'
      AND length(
            btrim(regexp_replace(
              substring(
                prosrc FROM 1 FOR greatest(
                  strpos(lower(prosrc), 'raise exception ''quote_version_legacy_untrusted''') - 1,
                  0
                )
              ),
              '\s+',
              ' ',
              'g'
            ))
          ) = 2730
      AND md5(
            btrim(regexp_replace(
              substring(
                prosrc FROM 1 FOR greatest(
                  strpos(lower(prosrc), 'raise exception ''quote_version_legacy_untrusted''') - 1,
                  0
                )
              ),
              '\s+',
              ' ',
              'g'
            ))
          ) = '62440ea5c855d1366808c5a2098177d7'
  ) THEN RAISE EXCEPTION 'POSTCOND: restore path no longer rejects untrusted legacy snapshots'; END IF;
  IF has_function_privilege('authenticated', 'public._restore_quote_version_below_cost_impl_20260810(uuid,uuid,uuid,text,bigint)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._restore_quote_version_below_cost_impl_20260810(uuid,uuid,uuid,text,bigint)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCOND: private restore implementation is externally callable';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'restore_quote_version') <> 1
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = '_restore_quote_version_below_cost_impl_20260810') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
       WHERE p.oid = 'public.restore_quote_version(uuid,uuid,uuid,text,bigint,text)'::regprocedure
         AND p.prosecdef
         AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) c(value) WHERE replace(c.value, ' ', '') = 'search_path=public,pg_temp')
         AND p.prosrc LIKE '%_restore_quote_version_below_cost_impl_20260810%'
     ) THEN
    RAISE EXCEPTION 'POSTCOND: restore overload, SECURITY DEFINER, search path, or routing boundary drifted';
  END IF;
END;
$postcond$;
