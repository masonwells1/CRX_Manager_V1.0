-- CRM relationship-intelligence Phase 2: durable, reviewable customer facts.
-- Facts preserve their intake provenance, are immutable once created, and
-- change only through explicit review and supersession RPCs.

CREATE TABLE public.customer_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  category text NOT NULL,
  fact_key text NOT NULL,
  value_text text,
  value_json jsonb,
  confidence numeric(4,3),
  status text NOT NULL DEFAULT 'pending_review',
  source text NOT NULL DEFAULT 'rep',
  source_interaction_id uuid,
  entered_by uuid REFERENCES public.profiles(id),
  reviewed_by uuid REFERENCES public.profiles(id),
  reviewed_at timestamptz,
  review_note text,
  expires_at timestamptz,
  superseded_at timestamptz,
  superseded_by uuid REFERENCES public.customer_facts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_facts_category_check CHECK (category IN (
    'product_preference', 'constraint', 'operating_preference', 'agronomy',
    'relationship', 'communication'
  )),
  CONSTRAINT customer_facts_fact_key_check
    CHECK (fact_key = lower(btrim(fact_key)) AND fact_key <> ''),
  CONSTRAINT customer_facts_value_json_check
    CHECK (value_json IS NULL OR jsonb_typeof(value_json) IN ('object', 'array')),
  CONSTRAINT customer_facts_value_check
    CHECK ((value_text IS NULL) <> (value_json IS NULL)
      AND (value_text IS NULL OR btrim(value_text) <> '')),
  CONSTRAINT customer_facts_confidence_check
    CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  CONSTRAINT customer_facts_status_check
    CHECK (status IN ('pending_review', 'verified', 'rejected')),
  CONSTRAINT customer_facts_source_check
    CHECK (source IN ('rep', 'ai_receptionist', 'system', 'web_store')),
  CONSTRAINT customer_facts_review_stamp_check CHECK (
    (status = 'pending_review' AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR (status IN ('verified', 'rejected') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  ),
  CONSTRAINT customer_facts_ai_source_interaction_check
    CHECK (source <> 'ai_receptionist' OR source_interaction_id IS NOT NULL)
);

ALTER TABLE public.customer_interactions
  ADD CONSTRAINT customer_interactions_customer_id_id_key UNIQUE (customer_id, id);

ALTER TABLE public.customer_facts
  ADD CONSTRAINT customer_facts_customer_interaction_fkey
  FOREIGN KEY (customer_id, source_interaction_id)
  REFERENCES public.customer_interactions(customer_id, id);

CREATE UNIQUE INDEX customer_facts_current_verified_key
  ON public.customer_facts (customer_id, category, fact_key)
  WHERE status = 'verified' AND superseded_at IS NULL;
CREATE INDEX customer_facts_customer_category_idx
  ON public.customer_facts (customer_id, category);
CREATE INDEX customer_facts_customer_pending_review_idx
  ON public.customer_facts (customer_id)
  WHERE status = 'pending_review';

CREATE TRIGGER customer_facts_update_updated_at
  BEFORE UPDATE ON public.customer_facts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE OR REPLACE FUNCTION public.guard_customer_fact_provenance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  IF OLD.customer_id IS DISTINCT FROM NEW.customer_id
     OR OLD.category IS DISTINCT FROM NEW.category
     OR OLD.fact_key IS DISTINCT FROM NEW.fact_key
     OR OLD.source IS DISTINCT FROM NEW.source
     OR OLD.source_interaction_id IS DISTINCT FROM NEW.source_interaction_id
     OR OLD.entered_by IS DISTINCT FROM NEW.entered_by
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'customer fact provenance is immutable; create a superseding fact instead';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER customer_facts_guard_provenance
  BEFORE UPDATE ON public.customer_facts
  FOR EACH ROW EXECUTE FUNCTION public.guard_customer_fact_provenance();

ALTER TABLE public.customer_facts ENABLE ROW LEVEL SECURITY;

CREATE POLICY customer_facts_admin_select ON public.customer_facts
  FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY customer_facts_rep_select ON public.customer_facts
  FOR SELECT TO authenticated USING (
    public.is_sales_rep() AND EXISTS (
      SELECT 1 FROM public.customers c
      WHERE c.id = customer_facts.customer_id
        AND c.assigned_sales_rep = (SELECT auth.uid())
    )
  );
CREATE POLICY customer_facts_admin_insert ON public.customer_facts
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY customer_facts_rep_insert ON public.customer_facts
  FOR INSERT TO authenticated WITH CHECK (
    public.is_sales_rep() AND EXISTS (
      SELECT 1 FROM public.customers c
      WHERE c.id = customer_facts.customer_id
        AND c.assigned_sales_rep = (SELECT auth.uid())
    )
    AND source = 'rep'
    AND entered_by = (SELECT auth.uid())
    AND (
      status = 'pending_review'
      OR (status = 'verified' AND reviewed_by = (SELECT auth.uid()) AND reviewed_at IS NOT NULL)
    )
    -- Supersession lineage is RPC-only: a rep cannot insert a row pre-marked
    -- superseded (which would forge history and dodge the current-verified
    -- unique index).
    AND superseded_at IS NULL
    AND superseded_by IS NULL
  );

REVOKE ALL ON TABLE public.customer_facts FROM anon, PUBLIC;
GRANT SELECT, INSERT ON TABLE public.customer_facts TO authenticated;

CREATE OR REPLACE FUNCTION public.review_customer_fact(
  p_fact_id uuid,
  p_verdict text,
  p_review_note text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_fact public.customer_facts%ROWTYPE;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF p_verdict NOT IN ('verified', 'rejected') THEN
    RAISE EXCEPTION 'FACT_VERDICT_INVALID';
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
    v_existing := public.check_idempotency(p_idempotency_key, 'review_customer_fact');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;
  IF v_fact.status <> 'pending_review' THEN
    IF v_fact.status = p_verdict THEN
      v_result := jsonb_build_object('success', true, 'fact_id', v_fact.id, 'noop', true, 'status', v_fact.status);
    ELSE
      RAISE EXCEPTION 'FACT_ALREADY_REVIEWED';
    END IF;
  ELSE
    UPDATE public.customer_facts
    SET status = p_verdict, reviewed_by = auth.uid(), reviewed_at = now(), review_note = p_review_note
    WHERE id = v_fact.id;
    v_result := jsonb_build_object('success', true, 'fact_id', v_fact.id, 'noop', false, 'status', p_verdict);
  END IF;
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(p_idempotency_key, 'review_customer_fact', v_result);
  END IF;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.supersede_customer_fact(
  p_fact_id uuid,
  p_value_text text,
  p_value_json jsonb,
  p_confidence numeric,
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
    'verified', 'rep', auth.uid(), auth.uid(), now(), v_fact.expires_at
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

REVOKE ALL ON FUNCTION public.review_customer_fact(uuid, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.supersede_customer_fact(uuid, text, jsonb, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_customer_fact(uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.supersede_customer_fact(uuid, text, jsonb, numeric, text) TO authenticated;

COMMENT ON TABLE public.customer_facts IS 'Reviewable customer knowledge with immutable intake provenance and explicit supersession.';
COMMENT ON COLUMN public.customer_facts.id IS 'Stable customer-fact identifier.';
COMMENT ON COLUMN public.customer_facts.customer_id IS 'Customer the fact describes.';
COMMENT ON COLUMN public.customer_facts.category IS 'Controlled fact category.';
COMMENT ON COLUMN public.customer_facts.fact_key IS 'Lowercase, trimmed key within the category.';
COMMENT ON COLUMN public.customer_facts.value_text IS 'Nonblank scalar fact value when structured JSON is not needed.';
COMMENT ON COLUMN public.customer_facts.value_json IS 'Structured object or array fact value when text is not suitable.';
COMMENT ON COLUMN public.customer_facts.confidence IS 'Optional confidence from zero through one.';
COMMENT ON COLUMN public.customer_facts.status IS 'Pending review, verified, or rejected lifecycle state.';
COMMENT ON COLUMN public.customer_facts.source IS 'Intake channel that originally supplied the fact.';
COMMENT ON COLUMN public.customer_facts.source_interaction_id IS 'Optional same-customer interaction that supplied the fact.';
COMMENT ON COLUMN public.customer_facts.entered_by IS 'User who entered the fact.';
COMMENT ON COLUMN public.customer_facts.reviewed_by IS 'User who verified or rejected the fact.';
COMMENT ON COLUMN public.customer_facts.reviewed_at IS 'When the fact was verified or rejected.';
COMMENT ON COLUMN public.customer_facts.review_note IS 'Optional reviewer explanation.';
COMMENT ON COLUMN public.customer_facts.expires_at IS 'Optional time after which the fact should be reconsidered.';
COMMENT ON COLUMN public.customer_facts.superseded_at IS 'When a newer verified fact replaced this fact.';
COMMENT ON COLUMN public.customer_facts.superseded_by IS 'Replacement fact created by the supersession RPC.';
COMMENT ON COLUMN public.customer_facts.created_at IS 'When this fact was first recorded.';
COMMENT ON COLUMN public.customer_facts.updated_at IS 'When mutable review or supersession fields last changed.';
COMMENT ON FUNCTION public.guard_customer_fact_provenance() IS 'Blocks all provenance changes to customer facts; corrections require supersession.';
COMMENT ON FUNCTION public.review_customer_fact(uuid, text, text, text) IS 'Reviews a pending customer fact with active-admin or assigned-rep authorization and idempotent replay.';
COMMENT ON FUNCTION public.supersede_customer_fact(uuid, text, jsonb, numeric, text) IS 'Replaces one current verified fact atomically with a new self-verified rep fact.';
COMMENT ON CONSTRAINT customer_interactions_customer_id_id_key ON public.customer_interactions IS 'Supports same-customer composite references from customer facts.';
COMMENT ON CONSTRAINT customer_facts_customer_interaction_fkey ON public.customer_facts IS 'Prevents a fact from citing an interaction for another customer.';
COMMENT ON INDEX public.customer_facts_current_verified_key IS 'Allows only one current verified fact for each customer category and key.';
COMMENT ON INDEX public.customer_facts_customer_category_idx IS 'Supports facts grouped by customer and category.';
COMMENT ON INDEX public.customer_facts_customer_pending_review_idx IS 'Supports the per-customer pending-review queue.';
