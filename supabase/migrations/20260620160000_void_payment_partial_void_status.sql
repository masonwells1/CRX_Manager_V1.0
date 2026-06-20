-- Overnight bug-hunt MED: lifecycle:void_payment:partial-void-status-stuck-paid
--
-- BUG: when void_payment reverses a payment, it flips invoice status 'paid' -> 'posted'
-- ONLY when the resulting paid_amount_cents reaches exactly 0. So a PARTIAL void (the
-- invoice had multiple payments and one is voided, leaving paid_amount > 0 but balance
-- now > 0) leaves the invoice stuck at status='paid' even though it is no longer fully
-- paid. status-keyed AR/aging then misreports it as settled.
--
-- FIX: derive the status from the RESULTING balance — 'paid' iff
-- total_amount_cents - (new_paid + prepay_applied_cents + write_off_cents) <= 0, else
-- 'posted' — for invoices currently in ('paid','posted'). (paid->posted is already an
-- allowed transition; the live code performs it today, just only at paid=0. Cannot read
-- the generated balance_cents column mid-UPDATE, so compute from the new paid amount.)
-- 'overdue'/'voided'/'cancelled'/'draft'/'unposted' are left untouched, exactly as the
-- live guard does — the overdue cron re-evaluates a re-opened invoice.
--
-- Body reproduced verbatim from the live definition (read 2026-06-20) with ONLY the
-- status CASE changed — verified by a rolled-back line-level diff. Latent on live data
-- (0 posted/paid invoices, 0 allocation_sets).

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
  -- D53A<<< new loop variable for the multi-credit reversal (task_d53a1704)
  v_credit           record;
  -- >>>D53A
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
            CASE WHEN (total_amount_cents - (GREATEST(paid_amount_cents - v_alloc.total_amount, 0) + prepay_applied_cents + write_off_cents)) <= 0
                 THEN 'paid' ELSE 'posted' END
          ELSE status
        END,
        updated_at = now()
    WHERE id = v_alloc.invoice_id;
    v_reversed_cents := v_reversed_cents + v_alloc.total_amount;
    v_invoice_count  := v_invoice_count + 1;
  END LOOP;

  -- D53A<<< overpayment-credit reversal REWRITTEN (task_d53a1704; the
  -- replaced live block is quoted verbatim in the file header).
  -- allocate_payment writes source_reference = 'From payment ' ||
  -- COALESCE(reference_number, check_number, set_id::text); the live match
  -- on the bare set uuid could never hit it, stranding the overpayment in
  -- customers.prepay_balance_cents on every void. prepay_credits has no
  -- allocation-set FK column, so match BOTH historical source_reference
  -- formats; branch (a) is narrowed by customer + season (same-transaction
  -- invariants of allocate_payment), branch (b) is a globally-unique uuid
  -- string. Loop + per-row lock so MULTIPLE matching credits are summed and
  -- reversed consistently (the old code zeroed every match but credited the
  -- customer back only the first row's balance).
  FOR v_credit IN
    SELECT id, balance_cents
    FROM prepay_credits
    WHERE source_type = 'overpayment'
      AND customer_id = v_set.customer_id
      AND balance_cents > 0
      AND (
        (source_reference = 'From payment ' || COALESCE(v_set.reference_number, v_set.check_number, v_set.id::text)
         AND (v_set.season IS NULL OR season = v_set.season))
        OR source_reference = p_allocation_set_id::text
      )
    FOR UPDATE
  LOOP
    UPDATE prepay_credits
    SET balance_cents = 0, notes = COALESCE(notes, '') || ' [VOIDED: ' || p_reason || ']', updated_at = now()
    WHERE id = v_credit.id;
    v_prepay_reversed := v_prepay_reversed + v_credit.balance_cents;
  END LOOP;

  IF v_prepay_reversed > 0 THEN
    UPDATE customers SET prepay_balance_cents = GREATEST(prepay_balance_cents - v_prepay_reversed, 0) WHERE id = v_set.customer_id;
  END IF;
  -- >>>D53A

  UPDATE allocation_sets SET is_active = false, notes = COALESCE(notes, '') || ' [VOIDED: ' || p_reason || ']', updated_at = now() WHERE id = p_allocation_set_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, old_values, new_values, total_impact_cents, description
  ) VALUES (
    'payment_voided', 'allocation_set', p_allocation_set_id, v_actor,
    jsonb_build_object('total_payment_cents', v_set.total_payment_cents, 'total_allocated_cents', v_set.total_allocated_cents, 'payment_method', v_set.payment_method, 'check_number', v_set.check_number, 'customer_id', v_set.customer_id),
    jsonb_build_object('reason', p_reason, 'invoices_reversed', v_invoice_count, 'prepay_reversed_cents', v_prepay_reversed),
    -1 * v_reversed_cents,
    'Voided payment ' || COALESCE(v_set.check_number, v_set.reference_number, v_set.id::text) || ' — ' || p_reason
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'void_payment', to_jsonb(p_allocation_set_id));
  END IF;

  RETURN jsonb_build_object('success', true, 'allocation_set_id', p_allocation_set_id, 'reversed_cents', v_reversed_cents, 'invoices_affected', v_invoice_count, 'prepay_reversed_cents', v_prepay_reversed);
END;
$function$;
