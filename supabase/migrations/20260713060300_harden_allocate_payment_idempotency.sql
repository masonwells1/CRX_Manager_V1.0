-- ============================================================================
-- Fix D: make allocate_payment idempotency atomic before money side effects.
--
-- The old check_idempotency() -> mutation -> save_idempotency() sequence was a
-- check-then-act race: two transactions could both see no row, both move money,
-- and the losing save would silently do nothing. This version claims the
-- single-column UNIQUE idempotency key up front. PostgreSQL makes a concurrent
-- inserter wait on that UNIQUE key; after the winner commits, the loser reads
-- and returns the winner's cached response instead of executing the body.
--
-- New claims store a versioned request/response envelope so reuse of the same
-- key with different arguments raises IDEMPOTENCY_ARGUMENT_MISMATCH. Existing
-- legacy rows still replay their original bare result for compatibility.
--
-- No signature, money math, locking, status recompute, security attribute, or
-- ACL change. CREATE OR REPLACE preserves the function's existing grants.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.allocate_payment(p_customer_id uuid, p_total_cents bigint, p_payment_method text, p_reference_number text DEFAULT NULL::text, p_check_number text DEFAULT NULL::text, p_payment_date date DEFAULT CURRENT_DATE, p_notes text DEFAULT NULL::text, p_allocations jsonb DEFAULT '[]'::jsonb, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_cached_result jsonb;
  v_alloc jsonb;
  v_inv record;
  v_alloc_cents bigint;
  v_sum_allocated bigint := 0;
  v_set_id uuid;
  v_current_season integer;
  v_prepay_cents bigint;
  v_result jsonb;
  v_allocation_count integer := 0;
  v_next_version integer;
  v_customer_name text;
  v_idem_request jsonb;
  v_idem_row record;
  v_idem_claim_count integer := 0;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_idem_request := jsonb_build_object(
      'customer_id', p_customer_id,
      'total_cents', p_total_cents,
      'payment_method', p_payment_method,
      'reference_number', p_reference_number,
      'check_number', p_check_number,
      'payment_date', p_payment_date,
      'notes', p_notes,
      'allocations', p_allocations,
      'performed_by', p_performed_by,
      'authenticated_actor', v_actor
    );

    -- Preserve check_idempotency()'s expiry behavior before claiming the key.
    DELETE FROM idempotency_keys WHERE expires_at < now();

    -- Atomic claim. A concurrent INSERT for this key blocks on the UNIQUE
    -- constraint. If its transaction commits, this INSERT takes the conflict
    -- path; if it rolls back, this INSERT succeeds and owns the claim.
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (
      p_idempotency_key,
      'allocate_payment',
      jsonb_build_object(
        '_contract', 'allocate_payment_v1',
        'request', v_idem_request,
        'response', NULL
      )
    )
    ON CONFLICT (idempotency_key) DO NOTHING;

    GET DIAGNOSTICS v_idem_claim_count = ROW_COUNT;

    IF v_idem_claim_count = 0 THEN
      SELECT operation, result INTO v_idem_row
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'IDEMPOTENCY_CLAIM_LOST: key % disappeared after conflict', p_idempotency_key;
      END IF;

      IF v_idem_row.operation IS DISTINCT FROM 'allocate_payment' THEN
        RAISE EXCEPTION 'IDEMPOTENCY_CROSS_OP_KEY_REUSE: idempotency_key % is already in use for operation %; cannot reuse it for operation %',
          p_idempotency_key, v_idem_row.operation, 'allocate_payment';
      END IF;

      IF v_idem_row.result->>'_contract' = 'allocate_payment_v1' THEN
        IF v_idem_row.result->'request' IS DISTINCT FROM v_idem_request THEN
          RAISE EXCEPTION 'IDEMPOTENCY_ARGUMENT_MISMATCH: key % was already used for different allocate_payment arguments',
            p_idempotency_key;
        END IF;

        v_cached_result := v_idem_row.result->'response';
        IF v_cached_result IS NULL OR v_cached_result = 'null'::jsonb THEN
          RAISE EXCEPTION 'IDEMPOTENCY_RESULT_NOT_READY: key % has no committed allocate_payment result',
            p_idempotency_key;
        END IF;

        RETURN v_cached_result;
      END IF;

      -- Rows written before this migration contain the bare cached response
      -- and no request metadata. Keep their sequential replay behavior.
      IF v_idem_row.result IS NOT NULL THEN
        RETURN v_idem_row.result;
      END IF;

      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_NOT_READY: legacy key % has no cached allocate_payment result',
        p_idempotency_key;
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to allocate payments';
  END IF;

  IF p_total_cents <= 0 THEN RAISE EXCEPTION 'Payment amount must be positive'; END IF;

  PERFORM check_period_open(p_payment_date);

  SELECT farm_name INTO v_customer_name FROM customers WHERE id = p_customer_id;

  v_current_season := CASE WHEN extract(month FROM CURRENT_DATE) >= 10
    THEN extract(year FROM CURRENT_DATE)::integer + 1
    ELSE extract(year FROM CURRENT_DATE)::integer END;

  SELECT COALESCE(MAX(version), 0) + 1 INTO v_next_version
  FROM allocation_sets WHERE entity_type = 'payment' AND entity_id = p_customer_id;

  INSERT INTO allocation_sets (
    entity_type, entity_id, version,
    customer_id, total_payment_cents, payment_method,
    reference_number, check_number, payment_date,
    notes, season, created_by
  ) VALUES (
    'payment', p_customer_id, v_next_version,
    p_customer_id, p_total_cents, p_payment_method,
    p_reference_number, p_check_number, p_payment_date,
    p_notes, v_current_season, v_actor
  ) RETURNING id INTO v_set_id;

  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations)
  LOOP
    v_alloc_cents := (v_alloc->>'amount_cents')::bigint;
    IF v_alloc_cents <= 0 THEN CONTINUE; END IF;

    SELECT * INTO v_inv FROM invoices
    WHERE id = (v_alloc->>'invoice_id')::uuid
      AND customer_id = p_customer_id
      AND status IN ('posted', 'overdue')
      AND deleted_at IS NULL
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invoice % not found or not eligible for payment', (v_alloc->>'invoice_id');
    END IF;

    IF v_alloc_cents > v_inv.balance_cents THEN
      RAISE EXCEPTION 'Allocation ($%) exceeds balance ($%) on invoice %',
        v_alloc_cents, v_inv.balance_cents, v_inv.invoice_number;
    END IF;

    INSERT INTO invoice_line_allocations (
      allocation_set_id, invoice_id, amount_cents,
      bill_to_customer_id, split_percentage
    ) VALUES (
      v_set_id, v_inv.id, v_alloc_cents, p_customer_id, 100
    );

    UPDATE invoices SET
      paid_amount_cents = paid_amount_cents + v_alloc_cents,
      status = CASE
        -- CREDIT-APPLY: include credit_applied_cents in the →paid recompute
        WHEN (total_amount_cents - (paid_amount_cents + v_alloc_cents) - prepay_applied_cents - write_off_cents - credit_applied_cents) <= 0
        THEN 'paid'
        ELSE status
      END,
      updated_at = now()
    WHERE id = v_inv.id;

    v_sum_allocated := v_sum_allocated + v_alloc_cents;
    v_allocation_count := v_allocation_count + 1;
  END LOOP;

  IF v_sum_allocated > p_total_cents THEN
    RAISE EXCEPTION 'OVER_ALLOCATED: allocations total $% but payment is only $%',
      (v_sum_allocated / 100.0)::numeric(12,2), (p_total_cents / 100.0)::numeric(12,2);
  END IF;

  UPDATE allocation_sets SET
    total_allocated_cents = v_sum_allocated,
    updated_at = now()
  WHERE id = v_set_id;

  v_prepay_cents := p_total_cents - v_sum_allocated;
  IF v_prepay_cents > 0 THEN
    INSERT INTO prepay_credits (
      customer_id, season, original_amount_cents, balance_cents,
      source_type, source_reference, allocation_set_id, created_by
    ) VALUES (
      p_customer_id, v_current_season, v_prepay_cents, v_prepay_cents,
      'overpayment', 'From payment ' || COALESCE(p_reference_number, p_check_number, v_set_id::text),
      v_set_id,
      v_actor
    );
    UPDATE customers SET
      prepay_balance_cents = COALESCE(prepay_balance_cents, 0) + v_prepay_cents,
      updated_at = now()
    WHERE id = p_customer_id;
  END IF;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'payment_allocated',
    'Payment of $' || (p_total_cents / 100.0)::text || ' allocated (' || v_allocation_count || ' invoices)',
    v_actor, 'allocation_set', v_set_id, p_customer_id
  );

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'payment_allocated', 'allocation_set', v_set_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object(
      'customer_id', p_customer_id,
      'customer_name', v_customer_name,
      'payment_method', p_payment_method,
      'reference_number', p_reference_number,
      'total_cents', p_total_cents,
      'allocated_cents', v_sum_allocated,
      'prepay_cents', v_prepay_cents,
      'invoices_paid', v_allocation_count
    ),
    p_total_cents,
    'Payment $' || (p_total_cents / 100.0)::numeric(12,2) || ' from ' ||
    COALESCE(v_customer_name, 'customer') || ' via ' || p_payment_method ||
    CASE WHEN v_prepay_cents > 0 THEN ' ($' || (v_prepay_cents / 100.0)::numeric(12,2) || ' to prepay)' ELSE '' END
  );

  v_result := jsonb_build_object(
    'success', true,
    'allocation_set_id', v_set_id,
    'total_allocated_cents', v_sum_allocated,
    'prepay_created_cents', v_prepay_cents,
    'invoices_paid', v_allocation_count
  );

  IF p_idempotency_key IS NOT NULL THEN
    UPDATE idempotency_keys
    SET result = jsonb_build_object(
      '_contract', 'allocate_payment_v1',
      'request', v_idem_request,
      'response', v_result
    )
    WHERE idempotency_key = p_idempotency_key
      AND operation = 'allocate_payment';
  END IF;

  RETURN v_result;
END;
$function$;

-- Close the latent anon/PUBLIC EXECUTE exposure on this money RPC (RLS reviewer H2).
-- Live ACL currently includes PUBLIC + anon; it is inert (the body raises
-- 'Not authenticated' when auth.uid() IS NULL) but should not be granted at all.
-- caller-analysis: allocate_payment :: UI callers src/pages/InvoiceDetail.tsx:820, src/pages/PaymentAllocation.tsx:286, and src/lib/offlineSync.ts:162 call via an authenticated Supabase session and retain EXECUTE (granted to authenticated). The REVOKE strips only PUBLIC/anon (never a legitimate caller) — zero impact on the authenticated callers.
REVOKE ALL ON FUNCTION public.allocate_payment(uuid, bigint, text, text, text, date, text, jsonb, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.allocate_payment(uuid, bigint, text, text, text, date, text, jsonb, uuid, text) TO authenticated, service_role;

