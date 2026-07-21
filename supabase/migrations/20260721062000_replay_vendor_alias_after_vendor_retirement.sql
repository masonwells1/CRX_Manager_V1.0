-- Preserve exact stage_vendor_alias replay after its vendor is retired.
--
-- The durable-replay migration (20260720230000) stores the original actor and
-- request fingerprint on vendor_aliases and reconstructs its response. However, it
-- checked the vendor's current deleted_at state before consulting either the
-- short-lived cache or durable receipt. An exact retry could therefore change
-- from success to VENDOR_NOT_FOUND after the vendor was later soft-deleted.
-- Replays must return the already-committed result; only a new mutation needs
-- the vendor to be active.

DO $preflight$
DECLARE
  v_proc regprocedure := to_regprocedure(
    'public.stage_vendor_alias(text,text,uuid,text,uuid,text)'
  );
  v_hash text;
  v_existing_receipts bigint;
BEGIN
  IF v_proc IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: stage_vendor_alias overload is missing';
  END IF;

  SELECT md5(p.prosrc)
    INTO v_hash
  FROM pg_proc p
  WHERE p.oid = v_proc;

  IF v_hash IS DISTINCT FROM 'dfb69478e6b01aeac3d5efd2876a52ff' THEN
    RAISE EXCEPTION
      'PREFLIGHT_FAILED: stage_vendor_alias body drifted (expected %, got %)',
      'dfb69478e6b01aeac3d5efd2876a52ff', v_hash;
  END IF;

  -- The live system has no staged aliases with durable keys yet. If that ever
  -- changes before apply, stop: a reviewed row cannot reconstruct its original
  -- pending response exactly and needs an owner-reviewed reconciliation.
  SELECT count(*)
    INTO v_existing_receipts
  FROM public.vendor_aliases
  WHERE idempotency_key IS NOT NULL;
  IF v_existing_receipts <> 0 THEN
    RAISE EXCEPTION
      'PREFLIGHT_FAILED: % existing vendor-alias durable receipt(s) require reconciliation',
      v_existing_receipts;
  END IF;
END;
$preflight$;

CREATE TABLE public.vendor_alias_stage_receipts (
  idempotency_key text PRIMARY KEY,
  alias_id uuid NOT NULL UNIQUE
    REFERENCES public.vendor_aliases(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL
    REFERENCES auth.users(id) ON DELETE RESTRICT,
  request_fingerprint text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.vendor_alias_stage_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY vendor_alias_stage_receipts_no_direct_access
  ON public.vendor_alias_stage_receipts
  FOR ALL
  TO authenticated
  USING (false)
  WITH CHECK (false);
REVOKE ALL ON TABLE public.vendor_alias_stage_receipts
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.stage_vendor_alias(
  p_alias_raw text,
  p_alias_display text,
  p_proposed_vendor_id uuid,
  p_source text,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_request_fp text;
  v_durable public.vendor_alias_stage_receipts%ROWTYPE;
  v_alias_id uuid;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF NULLIF(btrim(p_alias_raw), '') IS NULL OR NULLIF(btrim(p_alias_display), '') IS NULL THEN
    RAISE EXCEPTION 'VENDOR_ALIAS_TEXT_REQUIRED';
  END IF;
  IF p_source NOT IN ('legacy_product', 'legacy_po', 'import', 'manual') THEN
    RAISE EXCEPTION 'VENDOR_ALIAS_SOURCE_INVALID';
  END IF;

  v_request_fp := md5(jsonb_build_object(
    'actor_id', v_actor,
    'alias_raw', p_alias_raw,
    'alias_display', p_alias_display,
    'proposed_vendor_id', p_proposed_vendor_id,
    'source', p_source
  )::text);
  v_existing := public.check_idempotency(p_idempotency_key, 'stage_vendor_alias');
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'actor_id' IS DISTINCT FROM v_actor::text
       OR v_existing->>'request_fingerprint' IS DISTINCT FROM v_request_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_existing->'response';
  END IF;

  -- The alias row is the durable receipt. Consult it before current-vendor
  -- validation so an exact retry does not re-litigate mutable vendor state.
  SELECT * INTO v_durable
  FROM public.vendor_alias_stage_receipts receipt
  WHERE receipt.idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF FOUND THEN
    IF v_durable.actor_id IS DISTINCT FROM v_actor
       OR v_durable.request_fingerprint IS DISTINCT FROM v_request_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_durable.response;
  END IF;

  -- Only a new alias mutation depends on the vendor still being active.
  IF NOT EXISTS (
    SELECT 1
    FROM public.vendors
    WHERE id = p_proposed_vendor_id
      AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'VENDOR_NOT_FOUND';
  END IF;

  BEGIN
    INSERT INTO public.vendor_aliases(
      proposed_vendor_id, alias_raw, alias_display, source,
      review_status, created_by, idempotency_key, request_fingerprint
    ) VALUES (
      p_proposed_vendor_id, btrim(p_alias_raw), btrim(p_alias_display), p_source,
      'pending', v_actor, p_idempotency_key, v_request_fp
    ) RETURNING id INTO v_alias_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'VENDOR_ALIAS_ALREADY_EXISTS';
  END;

  SELECT to_jsonb(a) - 'idempotency_key' - 'request_fingerprint' INTO v_result
  FROM public.vendor_aliases a WHERE a.id = v_alias_id;
  INSERT INTO public.vendor_alias_stage_receipts(
    idempotency_key, alias_id, actor_id, request_fingerprint, response
  ) VALUES (
    p_idempotency_key, v_alias_id, v_actor, v_request_fp, v_result
  );
  PERFORM public.save_idempotency(
    p_idempotency_key,
    'stage_vendor_alias',
    jsonb_build_object(
      'actor_id', v_actor,
      'request_fingerprint', v_request_fp,
      'response', v_result
    )
  );
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.stage_vendor_alias(text, text, uuid, text, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stage_vendor_alias(text, text, uuid, text, uuid, text)
  TO authenticated, service_role;

DO $verify$
DECLARE
  v_proc regprocedure := to_regprocedure(
    'public.stage_vendor_alias(text,text,uuid,text,uuid,text)'
  );
  v_body text;
  v_config text[];
BEGIN
  SELECT p.prosrc, p.proconfig
    INTO v_body, v_config
  FROM pg_proc p
  WHERE p.oid = v_proc;

  IF md5(v_body) IS DISTINCT FROM 'cc69347d52682422c370d0e8255fce1b' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: stage_vendor_alias body hash drifted';
  END IF;

  IF position('WHERE receipt.idempotency_key = p_idempotency_key' IN v_body) = 0
     OR position('WHERE id = p_proposed_vendor_id' IN v_body) = 0
     OR position('WHERE receipt.idempotency_key = p_idempotency_key' IN v_body)
        > position('WHERE id = p_proposed_vendor_id' IN v_body) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: durable replay must precede vendor validation';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'vendor_alias_stage_receipts'
      AND c.relrowsecurity
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_policies p
    WHERE p.schemaname = 'public'
      AND p.tablename = 'vendor_alias_stage_receipts'
      AND p.policyname = 'vendor_alias_stage_receipts_no_direct_access'
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: protected immutable response receipts are missing';
  END IF;

  IF has_table_privilege('anon', 'public.vendor_alias_stage_receipts', 'SELECT')
     OR has_table_privilege('anon', 'public.vendor_alias_stage_receipts', 'INSERT')
     OR has_table_privilege('authenticated', 'public.vendor_alias_stage_receipts', 'SELECT')
     OR has_table_privilege('authenticated', 'public.vendor_alias_stage_receipts', 'INSERT')
     OR has_table_privilege('service_role', 'public.vendor_alias_stage_receipts', 'SELECT')
     OR has_table_privilege('service_role', 'public.vendor_alias_stage_receipts', 'INSERT') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: durable receipt table is directly accessible';
  END IF;

  IF NOT ('search_path=public, pg_temp' = ANY(COALESCE(v_config, ARRAY[]::text[]))) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: stage_vendor_alias search_path drifted';
  END IF;

  IF has_function_privilege('anon', v_proc, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_proc, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_proc, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: stage_vendor_alias grants drifted';
  END IF;
END;
$verify$;
