-- CRM Phase 2 amendment (Sol phase-gate 2.G, finding H2):
-- supersede_customer_fact copied the retired fact's expires_at onto the
-- replacement row, so an expired verified fact could never be renewed —
-- the expired row keeps its slot in customer_facts_current_verified_key
-- and every correction inherits the stale expiry. The replacement expiry
-- must be an explicit input.
--
-- Signature change (added p_expires_at) requires DROP + CREATE: CREATE OR
-- REPLACE with a different argument list would leave two overloads behind.
-- p_expires_at is intentionally required (no DEFAULT) so no caller can
-- silently fall back to the old copy-forward behavior; NULL means the
-- replacement fact does not expire.

DROP FUNCTION IF EXISTS public.supersede_customer_fact(uuid, text, jsonb, numeric, text);

CREATE FUNCTION public.supersede_customer_fact(
  p_fact_id uuid,
  p_value_text text,
  p_value_json jsonb,
  p_confidence numeric,
  p_expires_at timestamptz,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_fact public.customer_facts%ROWTYPE;
  v_new_fact_id uuid;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF (p_value_text IS NULL) = (p_value_json IS NULL)
     OR (p_value_text IS NOT NULL AND btrim(p_value_text) = '')
     OR (p_value_json IS NOT NULL AND jsonb_typeof(p_value_json) NOT IN ('object', 'array'))
     OR (p_confidence IS NOT NULL AND p_confidence NOT BETWEEN 0 AND 1) THEN
    RAISE EXCEPTION 'FACT_VALUE_INVALID';
  END IF;

  SELECT * INTO v_fact FROM public.customer_facts WHERE id = p_fact_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FACT_NOT_FOUND'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_active)
     OR NOT (public.is_admin() OR (public.is_sales_rep() AND EXISTS (
       SELECT 1 FROM public.customers c
       WHERE c.id = v_fact.customer_id AND c.assigned_sales_rep = auth.uid()
     ))) THEN
    RAISE EXCEPTION 'FACT_ACCESS_DENIED';
  END IF;
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'supersede_customer_fact');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;
  -- Time-sensitive validation sits AFTER the idempotency replay (Codex r2): a committed call
  -- whose short expiry has since passed must replay its committed result on retry, not error.
  IF p_expires_at IS NOT NULL AND p_expires_at <= now() THEN
    RAISE EXCEPTION 'FACT_EXPIRY_INVALID';
  END IF;
  IF v_fact.status <> 'verified' OR v_fact.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'FACT_NOT_CURRENT_VERIFIED';
  END IF;

  -- Three-step order: the self-FK on superseded_by is NOT deferrable, so the
  -- replacement row must exist before the old row can reference it — and the
  -- old row must leave the current-verified partial unique index before the
  -- replacement can enter it. (1) retire old, (2) insert new, (3) link.
  v_new_fact_id := gen_random_uuid();
  UPDATE public.customer_facts
  SET superseded_at = now()
  WHERE id = v_fact.id;

  INSERT INTO public.customer_facts (
    id,
    customer_id, category, fact_key, value_text, value_json, confidence,
    status, source, entered_by, reviewed_by, reviewed_at, expires_at
  ) VALUES (
    v_new_fact_id, v_fact.customer_id, v_fact.category, v_fact.fact_key, p_value_text, p_value_json, p_confidence,
    'verified', 'rep', auth.uid(), auth.uid(), now(), p_expires_at
  );

  UPDATE public.customer_facts
  SET superseded_by = v_new_fact_id
  WHERE id = v_fact.id;

  v_result := jsonb_build_object('success', true, 'fact_id', v_fact.id, 'replacement_fact_id', v_new_fact_id);
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(p_idempotency_key, 'supersede_customer_fact', v_result);
  END IF;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.supersede_customer_fact(uuid, text, jsonb, numeric, timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.supersede_customer_fact(uuid, text, jsonb, numeric, timestamptz, text) TO authenticated;

COMMENT ON FUNCTION public.supersede_customer_fact(uuid, text, jsonb, numeric, timestamptz, text) IS 'Replaces one current verified fact atomically with a new self-verified rep fact carrying an explicit replacement expiry.';
