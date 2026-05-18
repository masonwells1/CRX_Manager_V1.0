-- idempotency-body-check: exempt
-- (Uses check_idempotency / save_idempotency helper functions — same
-- canonical pattern Mason ratified in CLAUDE.md.)
-- ============================================================================
-- Spawned task — restore create_prepay_check_splits
-- ============================================================================
-- Tracks: spawned task during 2026-05-11 follow-up session
--
-- WHY THIS MIGRATION EXISTS:
--   PrepaymentManager.tsx:297 calls `supabase.rpc('create_prepay_check_splits', ...)`
--   but the function never existed in production. The original migration
--   (`20260327200000_wave4_security_integrity.sql`) defined it but was
--   never applied — current `pg_proc` has no row for this function. The
--   "Split a check into multiple buckets" UI flow has therefore been
--   broken since whenever the call was added.
--
-- WHAT'S CHANGED FROM THE ORIGINAL DEFINITION:
--   1. Idempotency pattern — switched to the canonical
--      check_idempotency/save_idempotency helpers (same fix PR-02
--      applied to record_invoice_payment / create_quick_delivery /
--      update_order_items). The original's
--      `(v_existing->>'status') = 'completed'` test never matched the
--      saved jsonb shape — replay would silently re-execute.
--   2. operation_type — `prepay_check_splits_created` is NOT in
--      financial_audit_log_operation_type_check's allowed list, so the
--      INSERT would have failed. Switched to `prepay_credit_created`
--      which IS in the allowed list and is the operation we're actually
--      performing (one per split, but we log one summary row for the
--      whole batch).
--   3. Schema fields — prepay_credits has a dedicated `bucket_label`
--      column now (the original wrote the label into `notes`). Using
--      the dedicated column. Also setting `source_type='check'`,
--      `source_reference=p_reference_number`, `created_by=v_actor`,
--      and `season=current_season()` per current schema conventions.
--   4. Strict actor pattern — v_actor := auth.uid() with mismatch
--      reject (matches codex F1/F2 + post-audit F-cleanup migrations).
--   5. search_path = public, pg_temp (CLAUDE.md SECURITY DEFINER rule).
--
-- After applying, verify:
--   SELECT proname FROM pg_proc
--   WHERE proname = 'create_prepay_check_splits'
--     AND pronamespace='public'::regnamespace;
--   Expected: 1 row.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_prepay_check_splits(
  p_customer_id      uuid,
  p_reference_number text,
  p_splits           jsonb,   -- [{label, amount_cents}]
  p_performed_by     uuid,
  p_idempotency_key  text DEFAULT NULL
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
  -- Strict actor pattern (matches codex F1/F2 + post-audit follow-ups):
  -- derive v_actor from the JWT, reject mismatched p_performed_by values.
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  -- Admin-only
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor;
  IF v_actor_role IS NULL OR v_actor_role != 'admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: only admins can create prepay credits';
  END IF;

  -- Canonical idempotency check (CLAUDE.md pattern)
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'create_prepay_check_splits');
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  -- Validate splits
  IF p_splits IS NULL OR jsonb_array_length(p_splits) = 0 THEN
    RAISE EXCEPTION 'INVALID_SPLITS: at least one split is required';
  END IF;

  v_season := current_season();

  -- Insert each split and accumulate total
  FOR v_split IN SELECT * FROM jsonb_array_elements(p_splits)
  LOOP
    v_label        := NULLIF(v_split->>'label', '');
    v_amount_cents := (v_split->>'amount_cents')::bigint;

    IF v_amount_cents IS NULL OR v_amount_cents <= 0 THEN
      RAISE EXCEPTION 'INVALID_AMOUNT: each split amount must be positive (got %)', v_amount_cents;
    END IF;

    INSERT INTO prepay_credits (
      customer_id,
      season,
      original_amount_cents,
      balance_cents,
      payment_method,
      reference_number,
      notes,
      created_by,
      source_type,
      source_reference,
      bucket_label
    ) VALUES (
      p_customer_id,
      v_season,
      v_amount_cents,
      v_amount_cents,
      'check',
      p_reference_number,
      'Check #' || p_reference_number || COALESCE(' — ' || v_label, ''),
      v_actor,
      'check',
      p_reference_number,
      v_label
    )
    RETURNING id INTO v_credit_id;

    v_credit_ids  := v_credit_ids || v_credit_id;
    v_total_cents := v_total_cents + v_amount_cents;
  END LOOP;

  -- Atomically update customer aggregate balance
  UPDATE customers
     SET prepay_balance_cents = COALESCE(prepay_balance_cents, 0) + v_total_cents,
         updated_at = now()
   WHERE id = p_customer_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CUSTOMER_NOT_FOUND: %', p_customer_id;
  END IF;

  -- One audit-log summary row for the whole batch.
  -- entity_type 'prepay_credit' + operation 'prepay_credit_created' are both
  -- in the CHECK constraint allowed lists (verified pre-write).
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

GRANT EXECUTE ON FUNCTION public.create_prepay_check_splits(uuid, text, jsonb, uuid, text) TO authenticated;

-- ─── Verification ─────────────────────────────────────────────────────────

DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc
  WHERE proname = 'create_prepay_check_splits'
    AND pronamespace = 'public'::regnamespace;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'create_prepay_check_splits verification: function does not exist after migration';
  END IF;

  IF v_count > 1 THEN
    RAISE EXCEPTION 'create_prepay_check_splits verification: % overloads exist (should be 1)', v_count;
  END IF;

  RAISE NOTICE 'create_prepay_check_splits verification passed';
END;
$$;
