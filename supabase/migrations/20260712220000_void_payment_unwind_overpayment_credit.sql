-- ============================================================================
-- void_payment: fully unwind overpayment credit when the funding payment is
-- voided (Mason's Option B decision, 2026-07-11). v2 after Codex round-1
-- NEEDS-WORK: the legacy human-reference credit matcher (customer + season +
-- source_reference text) is not unique — duplicate check/reference numbers
-- could unwind ANOTHER payment's credit. v2 links the credit to its payment
-- with a real FK column and matches on that exactly.
--
-- Bug being fixed (hunt Phase 3, verifier + Codex both REAL): void_payment
-- neutralized an overpayment credit by setting ONLY balance_cents = 0,
-- leaving original_amount_cents at the full overpayment, and skipped credits
-- whose balance was already 0 (fully applied). The recompute trigger on
-- prepay_applications derives balance = original - SUM(applied), so a later
-- invoice void DELETEs an application row and resurrects the credit up to its
-- full original value — spendable money the customer never funded.
--
-- This migration:
--   1. Adds prepay_credits.allocation_set_id uuid REFERENCES allocation_sets
--      (nullable; manual/rollover credits keep NULL). prepay_credits is empty
--      live (0 rows), so no backfill and no legacy rows the FK matcher could
--      miss.
--   2. Re-emits allocate_payment byte-identical to live except the
--      overpayment mint now stamps allocation_set_id = v_set_id.
--   3. Re-emits void_payment byte-identical to live except five edits:
--      (a) the credit loop matches ON allocation_set_id = p_allocation_set_id
--          (deterministic; replaces the ambiguous source_reference match) and
--          no longer filters balance_cents > 0, so fully-applied credits are
--          unwound too;
--      (b) each credit's prepay_applications are reversed before it is
--          killed: per-invoice FOR UPDATE, prepay_applied_cents decreases
--          (GENERATED balance rises), paid status recomputed across all
--          levers incl. credit_applied_cents, application rows deleted;
--      (c) the credit is zeroed on BOTH balance_cents AND
--          original_amount_cents so the recompute trigger yields 0 forever;
--      (d) audit row + result payload gain prepay_applications_reversed_cents.
-- customers.prepay_balance_cents handling is unchanged: only the UNAPPLIED
-- balance is subtracted (the applied part left the aggregate at apply time
-- and must not return — the credit is dead).
-- No signature changes; CREATE OR REPLACE preserves ACLs on both functions.
-- ============================================================================

-- 1. FK link: credit -> the payment (allocation set) that minted it
ALTER TABLE public.prepay_credits
  ADD COLUMN allocation_set_id uuid REFERENCES public.allocation_sets(id);

CREATE INDEX idx_prepay_credits_allocation_set
  ON public.prepay_credits(allocation_set_id)
  WHERE allocation_set_id IS NOT NULL;

COMMENT ON COLUMN public.prepay_credits.allocation_set_id IS
  'The payment (allocation_sets row) whose overpayment minted this credit. Stamped by allocate_payment; void_payment unwinds credits by exact match on this column. NULL for manual/non-payment credits.';

-- 2. allocate_payment: stamp the FK on the overpayment mint
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
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'allocate_payment');
    IF v_cached_result IS NOT NULL THEN RETURN v_cached_result; END IF;
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
    PERFORM save_idempotency(p_idempotency_key, 'allocate_payment', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- 3. void_payment: deterministic FK match + full unwind + un-resurrectable zero
CREATE OR REPLACE FUNCTION public.void_payment(p_allocation_set_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_set              record;
  v_alloc            record;
  v_actor            uuid;
  v_reversed_cents   bigint := 0;
  v_invoice_count    int    := 0;
  v_prepay_reversed  bigint := 0;
  v_old_balance      bigint;
  v_credit           record;
  v_app              record;
  v_apps_reversed_cents bigint := 0;
  v_existing         jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND operation = 'void_payment';
    IF v_existing IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'allocation_set_id', p_allocation_set_id, 'idempotent', true);
    END IF;
  END IF;

  SELECT * INTO v_set FROM allocation_sets WHERE id = p_allocation_set_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Allocation set not found: %', p_allocation_set_id; END IF;
  IF NOT v_set.is_active THEN RAISE EXCEPTION 'Payment already voided'; END IF;

  PERFORM check_period_open(COALESCE(v_set.payment_date, CURRENT_DATE));

  FOR v_alloc IN
    SELECT ila.invoice_id, SUM(ila.amount_cents) AS total_amount
    FROM invoice_line_allocations ila
    WHERE ila.allocation_set_id = p_allocation_set_id AND ila.invoice_id IS NOT NULL
    GROUP BY ila.invoice_id
  LOOP
    UPDATE invoices
    SET paid_amount_cents = GREATEST(paid_amount_cents - v_alloc.total_amount, 0),
        status = CASE
          WHEN status IN ('paid', 'posted') THEN
            -- CREDIT-APPLY: include credit_applied_cents in the settled recompute
            CASE WHEN (total_amount_cents - (GREATEST(paid_amount_cents - v_alloc.total_amount, 0) + prepay_applied_cents + write_off_cents + credit_applied_cents)) <= 0
                 THEN 'paid' ELSE 'posted' END
          ELSE status
        END,
        updated_at = now()
    WHERE id = v_alloc.invoice_id;
    v_reversed_cents := v_reversed_cents + v_alloc.total_amount;
    v_invoice_count  := v_invoice_count + 1;
  END LOOP;

  FOR v_credit IN
    SELECT id, balance_cents
    FROM prepay_credits
    WHERE source_type = 'overpayment'
      AND customer_id = v_set.customer_id
      AND allocation_set_id = p_allocation_set_id
    FOR UPDATE
  LOOP
    FOR v_app IN
      SELECT pa.invoice_id, pa.applied_amount_cents
      FROM prepay_applications pa
      WHERE pa.prepay_credit_id = v_credit.id
    LOOP
      PERFORM 1 FROM invoices WHERE id = v_app.invoice_id FOR UPDATE;
      UPDATE invoices
      SET prepay_applied_cents = GREATEST(prepay_applied_cents - v_app.applied_amount_cents, 0),
          status = CASE
            WHEN status IN ('paid', 'posted') THEN
              CASE WHEN (total_amount_cents - (paid_amount_cents + GREATEST(prepay_applied_cents - v_app.applied_amount_cents, 0) + write_off_cents + credit_applied_cents)) <= 0
                   THEN 'paid' ELSE 'posted' END
            ELSE status
          END,
          updated_at = now()
      WHERE id = v_app.invoice_id;
      v_apps_reversed_cents := v_apps_reversed_cents + v_app.applied_amount_cents;
    END LOOP;

    DELETE FROM prepay_applications WHERE prepay_credit_id = v_credit.id;

    UPDATE prepay_credits
    SET balance_cents = 0, original_amount_cents = 0, notes = COALESCE(notes, '') || ' [VOIDED: ' || p_reason || ']', updated_at = now()
    WHERE id = v_credit.id;
    v_prepay_reversed := v_prepay_reversed + v_credit.balance_cents;
  END LOOP;

  IF v_prepay_reversed > 0 THEN
    UPDATE customers SET prepay_balance_cents = GREATEST(prepay_balance_cents - v_prepay_reversed, 0) WHERE id = v_set.customer_id;
  END IF;

  UPDATE allocation_sets SET is_active = false, notes = COALESCE(notes, '') || ' [VOIDED: ' || p_reason || ']', updated_at = now() WHERE id = p_allocation_set_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, old_values, new_values, total_impact_cents, description
  ) VALUES (
    'payment_voided', 'allocation_set', p_allocation_set_id, v_actor,
    jsonb_build_object('total_payment_cents', v_set.total_payment_cents, 'total_allocated_cents', v_set.total_allocated_cents, 'payment_method', v_set.payment_method, 'check_number', v_set.check_number, 'customer_id', v_set.customer_id),
    jsonb_build_object('reason', p_reason, 'invoices_reversed', v_invoice_count, 'prepay_reversed_cents', v_prepay_reversed, 'prepay_applications_reversed_cents', v_apps_reversed_cents),
    -1 * v_reversed_cents,
    'Voided payment ' || COALESCE(v_set.check_number, v_set.reference_number, v_set.id::text) || ' — ' || p_reason
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'void_payment', to_jsonb(p_allocation_set_id));
  END IF;

  RETURN jsonb_build_object('success', true, 'allocation_set_id', p_allocation_set_id, 'reversed_cents', v_reversed_cents, 'invoices_affected', v_invoice_count, 'prepay_reversed_cents', v_prepay_reversed, 'prepay_applications_reversed_cents', v_apps_reversed_cents);
END;
$function$;

-- ---------------------------------------------------------------------------
-- Post-emit verification
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_count int;
  v_ok boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'prepay_credits' AND column_name = 'allocation_set_id'
  ) THEN
    RAISE EXCEPTION 'void_payment-unwind verification: prepay_credits.allocation_set_id missing';
  END IF;

  FOR v_count IN
    SELECT count(*)::int FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname IN ('void_payment','allocate_payment')
    GROUP BY proname
  LOOP
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'void_payment-unwind verification: expected 1 overload, found %', v_count;
    END IF;
  END LOOP;

  SELECT prosrc LIKE '%allocation_set_id = p_allocation_set_id%'
         AND prosrc LIKE '%DELETE FROM prepay_applications WHERE prepay_credit_id%'
         AND prosrc LIKE '%original_amount_cents = 0%'
         AND prosrc NOT LIKE '%AND balance_cents > 0%'
    INTO v_ok
    FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'void_payment';
  IF NOT COALESCE(v_ok, false) THEN
    RAISE EXCEPTION 'void_payment-unwind verification: unwind/matcher edits missing after re-emit';
  END IF;

  SELECT prosrc LIKE '%source_type, source_reference, allocation_set_id, created_by%'
    INTO v_ok
    FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'allocate_payment';
  IF NOT COALESCE(v_ok, false) THEN
    RAISE EXCEPTION 'void_payment-unwind verification: allocate_payment mint does not stamp allocation_set_id';
  END IF;
END;
$verify$;
