-- APPLIED LIVE 2026-08-07 as version 20260807220323 (Supabase-assigned at apply time;
-- authored as 20260807120000, re-stamped 20260807221500 pre-apply). Reviewed CLEAN by
-- both Codex charters; postflight ACL/overload/search_path assertions passed at apply.
--
-- Retry-safe CRM fact intake (2026-08-04 CRM audit §4, KNOWN_ISSUES §4).
-- CustomerFacts adds a new fact with a direct `customer_facts` insert, so a
-- committed response lost in transit and then retried double-logs the fact.
-- The interaction path was closed the same way on 2026-07-17
-- (20260717113000_log_customer_interaction_rpc.sql); this mirrors that RPC's
-- house pattern exactly: enforced p_idempotency_key via
-- check_idempotency/save_idempotency, an exact-request fingerprint so a
-- replayed key carrying edited values fails closed instead of silently
-- discarding the edit, SECURITY DEFINER with a pinned search_path, and
-- REVOKE PUBLIC/anon + GRANT authenticated.
--
-- Authorization mirrors the customer_facts INSERT policies that govern the
-- current direct-insert path: an active admin, or an active sales rep assigned
-- to this customer. The row is always pinned to source = 'rep' and the caller's
-- own identity, so AI/web/system provenance is never writable through here —
-- the same restriction the rep INSERT policy enforces today.
--
-- The frontend caller in src/components/customers/CustomerFacts.tsx cuts over to
-- this RPC in the same change that lands this rename.

-- Preflight: log_customer_fact must not exist in any form. With 6 DEFAULT
-- arguments, an out-of-band lower-arity overload would make PostgREST calls
-- ambiguous instead of erroring loudly, so assert a clean slate before CREATE.
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'log_customer_fact') <> 0 THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: log_customer_fact already exists — expected zero overloads';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_customer_fact(
  p_customer_id uuid,
  p_category text,
  p_fact_key text,
  p_value_text text DEFAULT NULL,
  p_value_json jsonb DEFAULT NULL,
  p_confidence numeric DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
  p_save_verified boolean DEFAULT false,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_fact_id uuid;
  v_fact_key text;
  v_value_text text;
  v_status text;
  v_existing jsonb;
  v_result jsonb;
  v_fingerprint text;
BEGIN
  -- The idempotency key is REQUIRED: an omitted key would silently give the
  -- caller zero retry protection — the exact double-log this RPC exists to fix
  -- (pending_review facts have no unique index to catch the duplicate).
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'FACT_IDEMPOTENCY_KEY_REQUIRED';
  END IF;

  -- Argument validation mirrors the customer_facts CHECK constraints so callers
  -- get stable machine-readable tokens instead of raw constraint errors. Every
  -- check below is deterministic on the arguments, so running them before the
  -- idempotency replay cannot reject a replay of a committed call. The one
  -- non-deterministic check — p_expires_at against now() — deliberately runs
  -- AFTER the replay return, or a committed call retried after a short expiry
  -- passed would error instead of replaying (the bug 20260716195012 fixed for
  -- supersede_customer_fact on this same table).
  IF p_customer_id IS NULL THEN
    RAISE EXCEPTION 'CUSTOMER_ID_REQUIRED';
  END IF;
  IF p_category IS NULL OR p_category NOT IN (
       'product_preference', 'constraint', 'operating_preference',
       'agronomy', 'relationship', 'communication') THEN
    RAISE EXCEPTION 'FACT_CATEGORY_INVALID';
  END IF;

  v_fact_key := lower(btrim(COALESCE(p_fact_key, '')));
  IF v_fact_key = '' OR v_fact_key !~ '^[a-z0-9]+(_[a-z0-9]+)*$' THEN
    RAISE EXCEPTION 'FACT_KEY_INVALID';
  END IF;

  v_value_text := CASE WHEN p_value_text IS NULL THEN NULL ELSE btrim(p_value_text) END;
  IF v_value_text = '' THEN
    v_value_text := NULL;
  END IF;
  -- customer_facts_value_check: exactly one of text/json, and text is nonblank.
  IF (v_value_text IS NULL) = (p_value_json IS NULL) THEN
    RAISE EXCEPTION 'FACT_VALUE_INVALID';
  END IF;
  IF p_value_json IS NOT NULL AND jsonb_typeof(p_value_json) NOT IN ('object', 'array') THEN
    RAISE EXCEPTION 'FACT_VALUE_INVALID';
  END IF;
  IF p_confidence IS NOT NULL AND (p_confidence < 0 OR p_confidence > 1) THEN
    RAISE EXCEPTION 'FACT_CONFIDENCE_INVALID';
  END IF;
  v_status := CASE WHEN COALESCE(p_save_verified, false) THEN 'verified' ELSE 'pending_review' END;

  IF NOT EXISTS (
       SELECT 1 FROM public.profiles p
       WHERE p.id = auth.uid() AND p.is_active
     )
     OR NOT (public.is_admin() OR (public.is_sales_rep() AND EXISTS (
       SELECT 1 FROM public.customers c
       WHERE c.id = p_customer_id
         AND c.assigned_sales_rep = auth.uid()
     ))) THEN
    RAISE EXCEPTION 'FACT_ACCESS_DENIED';
  END IF;

  -- Exact-request replay only (same rule as log_customer_interaction): a
  -- replayed key must carry the same payload, or the rep's edits between a
  -- lost-response commit and the retry would be silently discarded.
  v_fingerprint := md5(jsonb_build_object(
    'customer_id', p_customer_id,
    'category', p_category,
    'fact_key', v_fact_key,
    'value_text', v_value_text,
    'value_json', p_value_json,
    'confidence', p_confidence,
    'expires_at', CASE WHEN p_expires_at IS NULL THEN NULL
                  ELSE to_char(p_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
    'status', v_status
  )::text);

  v_existing := public.check_idempotency(p_idempotency_key, 'log_customer_fact');
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'request_fingerprint' IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'FACT_REPLAY_PAYLOAD_MISMATCH: this key already saved a fact with different values';
    END IF;
    RETURN v_existing;
  END IF;

  -- Non-deterministic (clock-dependent) check: must stay AFTER the replay
  -- return above — see the ordering note at the top of this function.
  IF p_expires_at IS NOT NULL AND p_expires_at <= now() THEN
    RAISE EXCEPTION 'FACT_EXPIRY_INVALID';
  END IF;

  BEGIN
    INSERT INTO public.customer_facts (
      customer_id, category, fact_key, value_text, value_json, confidence,
      status, source, entered_by, reviewed_by, reviewed_at, expires_at
    ) VALUES (
      p_customer_id, p_category, v_fact_key, v_value_text, p_value_json, p_confidence,
      v_status, 'rep', auth.uid(),
      CASE WHEN v_status = 'verified' THEN auth.uid() END,
      CASE WHEN v_status = 'verified' THEN now() END,
      p_expires_at
    )
    RETURNING id INTO v_fact_id;
  EXCEPTION WHEN unique_violation THEN
    -- customer_facts_current_verified_key: one current verified fact per
    -- (customer, category, key). Correcting an existing one goes through
    -- supersede_customer_fact, so return a stable token the UI can explain.
    RAISE EXCEPTION 'FACT_DUPLICATE_CURRENT_VERIFIED: a current verified fact already exists for this category and key; correct it instead';
  END;

  v_result := jsonb_build_object(
    'success', true,
    'fact_id', v_fact_id,
    'status', v_status,
    'request_fingerprint', v_fingerprint
  );
  PERFORM public.save_idempotency(p_idempotency_key, 'log_customer_fact', v_result);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.log_customer_fact(
  uuid, text, text, text, jsonb, numeric, timestamptz, boolean, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_customer_fact(
  uuid, text, text, text, jsonb, numeric, timestamptz, boolean, text
) TO authenticated;

COMMENT ON FUNCTION public.log_customer_fact(
  uuid, text, text, text, jsonb, numeric, timestamptz, boolean, text
) IS 'Idempotently records a rep-sourced customer fact under active-admin or assigned-rep authorization; a replayed key with different values fails closed.';

-- Postflight: exactly one overload, SECURITY DEFINER, pinned search_path, and
-- the intended ACLs (anon/PUBLIC denied, authenticated allowed) — the standard
-- house assertions, so a partial apply cannot pass silently.
DO $$
DECLARE
  v_count int;
  v_secdef boolean;
  v_config text[];
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'log_customer_fact';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: expected exactly 1 log_customer_fact overload, found %', v_count;
  END IF;

  SELECT p.prosecdef, p.proconfig INTO v_secdef, v_config
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'log_customer_fact';
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: log_customer_fact is not SECURITY DEFINER';
  END IF;
  IF NOT ('search_path=public, pg_temp' = ANY (v_config)) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: log_customer_fact search_path is not pinned to public, pg_temp';
  END IF;

  IF has_function_privilege('anon',
       'public.log_customer_fact(uuid, text, text, text, jsonb, numeric, timestamptz, boolean, text)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: anon can execute log_customer_fact';
  END IF;
  IF NOT has_function_privilege('authenticated',
       'public.log_customer_fact(uuid, text, text, text, jsonb, numeric, timestamptz, boolean, text)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: authenticated cannot execute log_customer_fact';
  END IF;
END;
$$;
