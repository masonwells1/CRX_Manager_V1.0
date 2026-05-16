-- ============================================================================
-- Codex P1 fix (PR #59, 2026-05-16 review of 82f1f66) — null-safe + active-admin
-- check on create_prepay_check_splits.
-- ============================================================================
-- The prior body filtered profile by id only:
--   SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor;
--   IF v_actor_role IS NULL OR v_actor_role != 'admin' THEN ...
-- The IS NULL guard caught missing profiles, but did NOT filter inactive
-- ones. A deactivated admin with a still-valid JWT could call this
-- SECURITY DEFINER RPC and create prepay_credits + increment
-- customers.prepay_balance_cents at will — the deactivation gate was a
-- no-op for this entry point.
--
-- Fix: add `AND is_active = true` to the profile lookup. Body otherwise
-- verbatim. Same null-safe role-check pattern as the parallel fixes for
-- edit_prepay_credit and delete_prepay_credit (20260516060000) but using
-- the existing `v_actor_role IS NULL OR != 'admin'` shape since that
-- already handles NULL correctly — just needed the is_active filter so
-- deactivated admins resolve to NULL too.
--
-- Applied to live via Supabase MCP before this commit.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_prepay_check_splits(
  p_customer_id     uuid,
  p_reference_number text,
  p_splits          jsonb,
  p_performed_by    uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor         uuid;
  v_actor_role    text;
  v_split         jsonb;
  v_total_cents   bigint := 0;
  v_credit_id     uuid;
  v_credit_ids    uuid[] := '{}';
  v_label         text;
  v_amount_cents  bigint;
  v_season        integer;
  v_result        jsonb;
  v_existing      jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  -- Codex P1 fix (2026-05-16): include is_active = true so deactivated admins
  -- with still-valid JWTs cannot create prepay credits.
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role != 'admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: only active admins can create prepay credits';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'create_prepay_check_splits');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  IF p_splits IS NULL OR jsonb_array_length(p_splits) = 0 THEN
    RAISE EXCEPTION 'INVALID_SPLITS: at least one split is required';
  END IF;

  v_season := current_season();

  FOR v_split IN SELECT * FROM jsonb_array_elements(p_splits)
  LOOP
    v_label        := NULLIF(v_split->>'label', '');
    v_amount_cents := (v_split->>'amount_cents')::bigint;

    IF v_amount_cents IS NULL OR v_amount_cents <= 0 THEN
      RAISE EXCEPTION 'INVALID_AMOUNT: each split amount must be positive (got %)', v_amount_cents;
    END IF;

    INSERT INTO prepay_credits (
      customer_id, season, original_amount_cents, balance_cents,
      payment_method, reference_number, notes, created_by,
      source_type, source_reference, bucket_label
    ) VALUES (
      p_customer_id, v_season, v_amount_cents, v_amount_cents,
      'check', p_reference_number,
      'Check #' || p_reference_number || COALESCE(' — ' || v_label, ''),
      v_actor, 'check', p_reference_number, v_label
    )
    RETURNING id INTO v_credit_id;

    v_credit_ids  := v_credit_ids || v_credit_id;
    v_total_cents := v_total_cents + v_amount_cents;
  END LOOP;

  UPDATE customers
     SET prepay_balance_cents = COALESCE(prepay_balance_cents, 0) + v_total_cents,
         updated_at = now()
   WHERE id = p_customer_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CUSTOMER_NOT_FOUND: %', p_customer_id;
  END IF;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'prepay_credit_created', 'prepay_credit', p_customer_id,
    v_actor_role,
    jsonb_build_object(
      'reference_number', p_reference_number,
      'split_count', jsonb_array_length(p_splits),
      'credit_ids', to_jsonb(v_credit_ids),
      'total_cents', v_total_cents
    ),
    v_total_cents,
    'Check #' || p_reference_number || ' split into ' ||
      jsonb_array_length(p_splits) || ' bucket(s) — $' ||
      (v_total_cents / 100.0)::numeric(12,2)
  );

  v_result := jsonb_build_object(
    'success', true,
    'credit_ids', to_jsonb(v_credit_ids),
    'total_cents', v_total_cents,
    'split_count', jsonb_array_length(p_splits)
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_prepay_check_splits', v_result);
  END IF;

  RETURN v_result;
END;
$$;
