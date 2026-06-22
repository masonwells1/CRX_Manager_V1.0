-- 20260622050000_void_reversal_check_period_open.sql
--
-- OVERNIGHT BUG HUNT Run 2 cycle 2, finding #2 (HIGH — both adversarial verifier + Codex; Hard Red Line).
-- dedupeKey: lifecycle:void_payment-reverse_write_off:no-period-gate
--
-- WHAT WAS WRONG
-- The Hard Red Line "NEVER bypass check_period_open()" was violated by the two financial
-- REVERSAL RPCs. void_payment and reverse_write_off both reverse cash/credit (paid_amount_cents,
-- prepay_credits, customers.prepay_balance_cents, invoices.write_off_cents) and write the
-- append-only financial_audit_log — but neither called check_period_open. Every FORWARD op
-- (post_invoice, allocate_payment, apply_write_off, issue_return_credit) AND the sibling reversal
-- void_invoice (PERFORM check_period_open(v_inv.invoice_date)) gate it; these two were the gap.
-- So an admin could void a payment / reverse a write-off dated into a CLOSED accounting period,
-- retroactively changing closed-month AR and the tamper-evident ledger.
--
-- THE FIX
-- Add a check_period_open gate to each, on the date of the financial event being reversed:
--   - void_payment       -> the payment's date (allocation_sets.payment_date)
--   - reverse_write_off   -> the write-off's booked date (write_offs.created_at::date)
-- Both bodies are otherwise reproduced verbatim from the live definitions; the ONLY addition is
-- the single "PERFORM check_period_open(...)" line in each (marked OVERNIGHT FIX).
--
-- Proven by rolled-back live smoke: with a closed period covering the event date, both RPCs now
-- RAISE "Date ... falls in closed accounting period" instead of proceeding. Rolled back.
--
-- ROLLBACK: remove the two marked PERFORM check_period_open lines.

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

  -- OVERNIGHT FIX (finding #2): a payment void retroactively changes AR and writes the append-only
  -- ledger, so it must respect closed accounting periods (Hard Red Line). Gate on the payment's date.
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

CREATE OR REPLACE FUNCTION public.reverse_write_off(p_write_off_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor          uuid;
  v_wo             record;
  v_existing       jsonb;
  v_new_balance    bigint;
  v_old_status     text;
  v_due_date       date;
  v_new_status     text;
  v_status_changed boolean;
  v_result         jsonb;
BEGIN
  -- Strict-actor: derive from JWT, never trust a client-supplied UUID.
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  IF (SELECT role FROM profiles WHERE id = v_actor AND is_active = true) != 'admin' THEN
    RAISE EXCEPTION 'Admin access required to reverse write-offs';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to reverse a write-off';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key
       AND operation = 'reverse_write_off';
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  SELECT * INTO v_wo
    FROM write_offs
   WHERE id = p_write_off_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Write-off not found: %', p_write_off_id;
  END IF;

  IF v_wo.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Write-off has already been reversed';
  END IF;

  -- OVERNIGHT FIX (finding #2): reversing a write-off retroactively changes AR and writes the
  -- append-only ledger; gate on the write-off's booked date so a closed period blocks it
  -- (Hard Red Line: never bypass check_period_open).
  PERFORM check_period_open(v_wo.created_at::date);

  SELECT status, due_date INTO v_old_status, v_due_date
    FROM invoices
   WHERE id = v_wo.invoice_id
   FOR UPDATE;

  IF v_old_status IS NULL THEN
    RAISE EXCEPTION 'Invoice not found for write-off %: %', p_write_off_id, v_wo.invoice_id;
  END IF;

  UPDATE invoices
     SET write_off_cents = GREATEST(COALESCE(write_off_cents, 0) - v_wo.amount_cents, 0),
         updated_at      = now()
   WHERE id = v_wo.invoice_id;

  SELECT balance_cents INTO v_new_balance
    FROM invoices
   WHERE id = v_wo.invoice_id;

  IF v_old_status = 'paid' AND v_new_balance > 0 THEN
    IF v_due_date IS NOT NULL AND v_due_date < CURRENT_DATE THEN
      v_new_status := 'overdue';
    ELSE
      v_new_status := 'posted';
    END IF;
    UPDATE invoices
       SET status     = v_new_status,
           updated_at = now()
     WHERE id = v_wo.invoice_id;
    v_status_changed := true;
  ELSE
    v_new_status := v_old_status;
    v_status_changed := false;
  END IF;

  UPDATE write_offs
     SET reversed_at     = now(),
         reversed_by     = v_actor,
         reversed_reason = p_reason
   WHERE id = p_write_off_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'write_off_reversed', 'write_off', p_write_off_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object(
      'amount_cents',   v_wo.amount_cents,
      'reversed_at',    null,
      'invoice_status', v_old_status
    ),
    jsonb_build_object(
      'reversed_at',       now(),
      'reverse_reason',    p_reason,
      'invoice_status',    v_new_status,
      'new_balance_cents', v_new_balance
    ),
    v_wo.amount_cents,
    'Write-off of ' || (v_wo.amount_cents::numeric / 100)::text ||
      ' reversed on invoice ' || v_wo.invoice_id::text || ': ' || p_reason
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'write_off_reversed',
    'Write-off of $' || (v_wo.amount_cents::numeric / 100)::text || ' reversed: ' || p_reason,
    v_actor, 'invoice', v_wo.invoice_id, v_wo.customer_id
  );

  v_result := jsonb_build_object(
    'success',           true,
    'write_off_id',      p_write_off_id,
    'amount_cents',      v_wo.amount_cents,
    'invoice_id',        v_wo.invoice_id,
    'new_balance_cents', v_new_balance,
    'status_changed',    v_status_changed,
    'new_status',        v_new_status
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)
    VALUES (p_idempotency_key, 'reverse_write_off', v_result, now() + interval '24 hours')
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$function$;
