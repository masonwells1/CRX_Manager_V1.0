-- Credit-memo apply — Migration 4 of 5: reversal + void/unapply/unpost/delete lifecycle
-- =====================================================================================
-- Codex blocker #4: the existing reversal paths don't know about the new credit lever and
-- would strand credits or violate the balance CHECK. This migration adds:
--   * _reverse_credit_memo_application  — internal mechanics (restore both sides, re-open target)
--   * reverse_credit_memo_application   — public RPC (undo one application)
-- and re-emits, credit-aware:
--   * void_invoice        — auto-reverse every active application touching the invoice, then zero
--   * unapply_credit_memo — reverse everything the memo handed out before voiding it
--   * unpost_invoice      — refuse to unpost while credit is applied (like the paid/prepay guard)
--   * delete_invoices     — defense-in-depth refusal if an active application still references it
-- The four re-emitted bodies are the exact live source (verified 2026-07-10) with ONLY the
-- credit-apply blocks inserted, marked  -- CREDIT-APPLY.

-- =====================================================================================
-- 1. Internal reversal mechanics. Assumes the CALLER has already authorized + period-checked.
--    Restores the memo's credit and the target's balance, re-opens a paid target to posted
--    (the enforcer allows paid→posted), and stamps the ledger row reversed (never deletes it).
-- =====================================================================================
CREATE OR REPLACE FUNCTION public._reverse_credit_memo_application(
  p_application_id uuid, p_actor uuid, p_actor_role text, p_reason text
) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_app    record;
  v_first  uuid;
  v_second uuid;
  v_memo   record;
  v_target record;
BEGIN
  -- idempotency-body-check: exempt
  -- Internal helper: all EXECUTE is revoked (client-uncallable). Idempotency is enforced by its
  -- two SECDEF callers (reverse_credit_memo_application + void_invoice/unapply loops), so a
  -- p_idempotency_key here would be redundant.
  SELECT * INTO v_app FROM credit_memo_applications WHERE id = p_application_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CREDIT_APPLICATION_NOT_FOUND: %', p_application_id; END IF;
  IF v_app.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'CREDIT_APPLICATION_ALREADY_REVERSED: %', p_application_id;
  END IF;

  -- lock both invoices by id order (deadlock-safe; re-entrant if a caller already locked one)
  IF v_app.credit_memo_id < v_app.target_invoice_id THEN
    v_first := v_app.credit_memo_id; v_second := v_app.target_invoice_id;
  ELSE
    v_first := v_app.target_invoice_id; v_second := v_app.credit_memo_id;
  END IF;
  PERFORM 1 FROM invoices WHERE id = v_first  FOR UPDATE;
  PERFORM 1 FROM invoices WHERE id = v_second FOR UPDATE;

  SELECT * INTO v_memo   FROM invoices WHERE id = v_app.credit_memo_id;
  SELECT * INTO v_target FROM invoices WHERE id = v_app.target_invoice_id;

  -- give the credit back to the memo (its balance falls back toward the issued amount)
  UPDATE invoices
     SET credit_applied_cents = credit_applied_cents - v_app.amount_cents,
         updated_at = now()
   WHERE id = v_app.credit_memo_id;

  -- restore the target's balance; re-open a fully-credited (paid) invoice to posted
  UPDATE invoices
     SET credit_applied_cents = credit_applied_cents - v_app.amount_cents,
         status = CASE
           WHEN status = 'paid'
             AND (total_amount_cents - paid_amount_cents - prepay_applied_cents - write_off_cents
                  - (credit_applied_cents - v_app.amount_cents)) > 0
           THEN 'posted' ELSE status END,
         updated_at = now()
   WHERE id = v_app.target_invoice_id;

  -- stamp the reversal (the immutability guard permits exactly this one-time transition)
  UPDATE credit_memo_applications
     SET reversed_at = now(), reversed_by = p_actor, reversal_reason = p_reason
   WHERE id = p_application_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'credit_memo_unapplied', 'credit_memo', p_application_id, p_actor, p_actor_role,
    jsonb_build_object(
      'kind', 'application_reversed',
      'application_id', p_application_id,
      'credit_memo_id', v_app.credit_memo_id,     'credit_memo_number', v_memo.invoice_number,
      'target_invoice_id', v_app.target_invoice_id, 'target_invoice_number', v_target.invoice_number,
      'amount_cents', v_app.amount_cents, 'reason', p_reason
    ),
    0,
    'Reversed $' || (v_app.amount_cents / 100.0)::numeric(12,2) || ' credit '
      || v_memo.invoice_number || ' from ' || v_target.invoice_number || ': ' || p_reason
  );
END;
$$;

REVOKE ALL ON FUNCTION public._reverse_credit_memo_application(uuid, uuid, text, text) FROM public;
REVOKE ALL ON FUNCTION public._reverse_credit_memo_application(uuid, uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public._reverse_credit_memo_application(uuid, uuid, text, text) FROM authenticated;
-- internal only: no client grant. Owner (postgres) + the SECDEF callers below reach it.

-- =====================================================================================
-- 2. Public reverse RPC — undo a single credit application.
-- =====================================================================================
CREATE OR REPLACE FUNCTION public.reverse_credit_memo_application(
  p_application_id  uuid,
  p_reason          text,
  p_performed_by    uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid;
  v_actor_role text;
  v_app        record;
  v_existing   jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true;
  -- Codex BLOCKER: NULL (inactive/absent profile) must be rejected — `NULL NOT IN (...)` is not true.
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: only active admins and sales reps can reverse credit applications';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED: a reason is required to reverse a credit application';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'reverse_credit_memo_application');
    IF v_existing IS NOT NULL THEN
      -- Codex HIGH: bind idempotency to the application id (mirror the apply RPC) so a key reused
      -- for a DIFFERENT application can't silently return the first application's success.
      IF (v_existing->>'application_id')::uuid IS DISTINCT FROM p_application_id THEN
        RAISE EXCEPTION 'IDEMPOTENCY_ARGUMENT_MISMATCH: key % was already used to reverse a different application', p_idempotency_key;
      END IF;
      RETURN v_existing;
    END IF;
  END IF;

  SELECT * INTO v_app FROM credit_memo_applications WHERE id = p_application_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CREDIT_APPLICATION_NOT_FOUND: %', p_application_id; END IF;
  IF v_app.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'CREDIT_APPLICATION_ALREADY_REVERSED: %', p_application_id;
  END IF;

  -- Codex HIGH: gate on the APPLICATION's own period (applied_at), NOT the memo's ISSUE date. Apply
  -- checks CURRENT_DATE, so an application made in an open period must stay reversible in it even if
  -- the memo was issued in a since-closed period (mirrors void_payment gating on payment_date).
  PERFORM check_period_open(v_app.applied_at::date);

  PERFORM _reverse_credit_memo_application(p_application_id, v_actor, v_actor_role, p_reason);

  v_existing := jsonb_build_object(
    'success', true, 'application_id', p_application_id,
    'credit_memo_id', v_app.credit_memo_id, 'target_invoice_id', v_app.target_invoice_id,
    'amount_cents', v_app.amount_cents
  );
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'reverse_credit_memo_application', v_existing);
  END IF;
  RETURN v_existing;
END;
$$;

REVOKE ALL ON FUNCTION public.reverse_credit_memo_application(uuid, text, uuid, text) FROM public;
REVOKE ALL ON FUNCTION public.reverse_credit_memo_application(uuid, text, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.reverse_credit_memo_application(uuid, text, uuid, text) TO authenticated;

-- =====================================================================================
-- 3. void_invoice — credit-aware. Exact live body + one inserted reversal block (CREDIT-APPLY)
--    and credit_applied_cents = 0 added to the final void UPDATE.
-- =====================================================================================
CREATE OR REPLACE FUNCTION public.void_invoice(p_invoice_id uuid, p_void_reason text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inv record; v_alloc record; v_total_allocations_reversed bigint := 0;
  v_total_prepay_restored bigint := 0; v_prepay_app record; v_actor_role text;
  v_allocation_set_ids uuid[]; v_commissions_cancelled integer := 0; v_existing jsonb;
  v_job record;  -- U6 #65: job-release locals
  v_capp record;  -- CREDIT-APPLY: active-application cursor
BEGIN
  SELECT role INTO v_actor_role FROM profiles WHERE id = auth.uid();
  IF v_actor_role IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'Only admin users can void invoices'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'void_invoice');
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found: %', p_invoice_id; END IF;
  IF v_inv.status = 'voided' THEN RAISE EXCEPTION 'Invoice already voided'; END IF;
  IF v_inv.status = 'cancelled' THEN RAISE EXCEPTION 'Cannot void a cancelled invoice'; END IF;

  -- draft/unposted invoices were never posted: no allocations/prepay/commissions to reverse,
  -- and the status trigger only allows →voided from posted/overdue. Route to 'cancelled'
  -- (draft→cancelled / unposted→cancelled are allowed transitions) and return.
  -- (A draft/unposted invoice can never carry a credit application — apply requires posted on
  --  both sides — so no credit reversal is needed on this branch.)
  IF v_inv.status IN ('draft', 'unposted') THEN
    UPDATE invoices SET status = 'cancelled', void_reason = p_void_reason, updated_at = now()
    WHERE id = p_invoice_id;

    IF v_inv.invoice_type = 'field_application' AND v_inv.job_id IS NOT NULL THEN
      SELECT * INTO v_job FROM jobs WHERE id = v_inv.job_id FOR UPDATE;
      IF FOUND AND v_job.status = 'invoiced' THEN
        IF EXISTS (SELECT 1 FROM invoices o
                   WHERE o.job_id = v_inv.job_id AND o.id <> p_invoice_id
                     AND o.invoice_type = 'field_application'
                     AND o.status NOT IN ('voided', 'cancelled') AND o.deleted_at IS NULL) THEN
          IF v_job.invoice_id IS NOT DISTINCT FROM p_invoice_id THEN
            UPDATE application_records SET invoice_id = (
              SELECT o.id FROM invoices o
               WHERE o.job_id = v_inv.job_id AND o.id <> p_invoice_id
                 AND o.invoice_type = 'field_application'
                 AND o.status NOT IN ('voided', 'cancelled') AND o.deleted_at IS NULL
               ORDER BY o.created_at, o.id LIMIT 1)
              WHERE source_type = 'job' AND source_id = v_inv.job_id AND invoice_id = p_invoice_id;
            SET LOCAL app.admin_override = 'true';
            UPDATE jobs SET invoice_id = (
              SELECT o.id FROM invoices o
               WHERE o.job_id = v_inv.job_id AND o.id <> p_invoice_id
                 AND o.invoice_type = 'field_application'
                 AND o.status NOT IN ('voided', 'cancelled') AND o.deleted_at IS NULL
               ORDER BY o.created_at, o.id LIMIT 1)
              WHERE id = v_inv.job_id;
            RESET app.admin_override;
          END IF;
        ELSE
          UPDATE application_records SET invoice_id = NULL
            WHERE source_type = 'job' AND source_id = v_inv.job_id AND invoice_id = p_invoice_id;
          SET LOCAL app.admin_override = 'true';
          UPDATE jobs SET status = 'completed', invoice_id = NULL WHERE id = v_inv.job_id;
          RESET app.admin_override;
        END IF;
      END IF;
    END IF;

    IF v_inv.invoice_type = 'field_application' AND v_inv.job_id IS NOT NULL THEN
      IF EXISTS (
        SELECT 1 FROM commissions c
        JOIN commission_payment_items cpi ON cpi.commission_id = c.id
        JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
        WHERE c.job_id = v_inv.job_id AND c.invoice_id = p_invoice_id
          AND c.status = 'pending' AND cp.status <> 'voided'
      ) THEN
        RAISE EXCEPTION 'JOB_HAS_BATCHED_COMMISSIONS: this job invoice''s pending commissions are in an active payout batch — void that commission payment first';
      END IF;
      IF EXISTS (
        SELECT 1 FROM commissions
        WHERE job_id = v_inv.job_id AND invoice_id = p_invoice_id AND status = 'paid'
      ) THEN
        INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
        SELECT p.id, 'Job invoice cancelled — commissions already paid',
          'Invoice ' || v_inv.invoice_number || ' was cancelled but its commissions were already paid out. Manual review needed before the job is re-invoiced.',
          'commission_review', 'invoice', p_invoice_id
        FROM profiles p WHERE p.role = 'admin' AND p.is_active = true;
      END IF;
      UPDATE commissions SET status = 'cancelled', commission_amount = 0
        WHERE job_id = v_inv.job_id AND invoice_id = p_invoice_id AND status = 'pending';
      GET DIAGNOSTICS v_commissions_cancelled = ROW_COUNT;
    END IF;

    INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, old_values, new_values, total_impact_cents, description)
    VALUES ('invoice_cancelled', 'invoice', p_invoice_id, v_actor_role,
      jsonb_build_object('status', v_inv.status, 'total_cents', v_inv.total_amount_cents),
      jsonb_build_object('status', 'cancelled', 'void_reason', p_void_reason, 'commissions_cancelled', v_commissions_cancelled),
      0,
      'Cancelled ' || v_inv.invoice_number || ' (was ' || v_inv.status || ') — ' || p_void_reason);

    INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
    VALUES ('invoice_cancelled',
      'Cancelled invoice ' || v_inv.invoice_number || ' — ' || p_void_reason,
      auth.uid(), 'invoice', p_invoice_id, v_inv.customer_id);

    IF p_idempotency_key IS NOT NULL THEN
      PERFORM save_idempotency(p_idempotency_key, 'void_invoice', jsonb_build_object(
        'success', true, 'invoice_id', p_invoice_id, 'status', 'cancelled',
        'allocations_reversed_cents', 0, 'prepay_restored_cents', 0, 'commissions_cancelled', v_commissions_cancelled));
    END IF;
    RETURN;
  END IF;

  IF v_inv.status = 'posted' THEN PERFORM check_period_open(v_inv.invoice_date); END IF;

  -- CREDIT-APPLY: reverse every active credit-memo application that touches this invoice
  -- (as the credit memo OR as the target) BEFORE zeroing its levers. This restores the other
  -- side and drains this invoice's credit_applied_cents to 0; without it a voided target would
  -- leave credit_applied_cents set and violate invoices_balance_non_negative, and a voided memo
  -- would strand the credit it handed out (Codex #4).
  -- Codex BLOCKER: the enclosing void only period-checks status='posted', but a credited target is
  -- 'paid'/'overdue'. Each application's reversal is a money movement, so gate it on THAT
  -- application's own period (applied_at) before touching it.
  -- Codex MED (accepted, not fixed): void locks THIS invoice first, then the helper locks both sides
  -- in id order — two concurrent voids of a memo and its target can deadlock. Postgres detects it and
  -- aborts one cleanly (money stays atomic; the operator retries). Rare + non-corrupting, so it is
  -- left as a safe-abort rather than a global pre-lock of all counterparties.
  FOR v_capp IN
    SELECT id, applied_at FROM credit_memo_applications
     WHERE reversed_at IS NULL
       AND (credit_memo_id = p_invoice_id OR target_invoice_id = p_invoice_id)
     ORDER BY id
  LOOP
    PERFORM check_period_open(v_capp.applied_at::date);
    PERFORM _reverse_credit_memo_application(v_capp.id, auth.uid(), v_actor_role,
      'Auto-reversed: invoice ' || v_inv.invoice_number || ' voided — ' || p_void_reason);
  END LOOP;

  SELECT ARRAY(SELECT DISTINCT allocation_set_id FROM invoice_line_allocations
    WHERE invoice_id = p_invoice_id AND allocation_set_id IS NOT NULL) INTO v_allocation_set_ids;

  FOR v_alloc IN SELECT ila.id, ila.amount_cents, ila.allocation_set_id FROM invoice_line_allocations ila
    WHERE ila.invoice_id = p_invoice_id LOOP
    v_total_allocations_reversed := v_total_allocations_reversed + v_alloc.amount_cents;
    DELETE FROM invoice_line_allocations WHERE id = v_alloc.id;
  END LOOP;

  IF v_total_allocations_reversed > 0 AND array_length(v_allocation_set_ids, 1) > 0 THEN
    UPDATE allocation_sets SET total_allocated_cents = (SELECT COALESCE(SUM(amount_cents), 0)
      FROM invoice_line_allocations WHERE allocation_set_id = allocation_sets.id),
      updated_at = now() WHERE id = ANY(v_allocation_set_ids);
  END IF;

  FOR v_prepay_app IN SELECT pa.id, pa.applied_amount_cents, pa.prepay_credit_id FROM prepay_applications pa
    WHERE pa.invoice_id = p_invoice_id LOOP
    v_total_prepay_restored := v_total_prepay_restored + v_prepay_app.applied_amount_cents;
    UPDATE prepay_credits SET balance_cents = balance_cents + v_prepay_app.applied_amount_cents,
      updated_at = now() WHERE id = v_prepay_app.prepay_credit_id;
    DELETE FROM prepay_applications WHERE id = v_prepay_app.id;
  END LOOP;

  IF v_total_prepay_restored > 0 THEN
    UPDATE customers SET prepay_balance_cents = COALESCE(prepay_balance_cents, 0) + v_total_prepay_restored,
      updated_at = now() WHERE id = v_inv.customer_id;
  END IF;

  -- CREDIT-APPLY: credit_applied_cents = 0 added (all applications reversed above → already 0;
  -- explicit for safety so the voided row's balance is unambiguously 0).
  UPDATE invoices SET status = 'voided', voided_by = auth.uid(), voided_at = now(),
    void_reason = p_void_reason, total_amount_cents = 0, paid_amount_cents = 0,
    prepay_applied_cents = 0, write_off_cents = 0, credit_applied_cents = 0, updated_at = now()
  WHERE id = p_invoice_id;

  -- Codex HIGH: a generic void of a CREDIT MEMO must also release its linked return (mirroring
  -- unapply_credit_memo), or the return stays 'credited' pointing at a voided memo and can never be
  -- re-credited. Regular invoices have no such link, so the guard scopes this to credit memos.
  IF v_inv.invoice_type = 'credit_memo' THEN
    PERFORM set_config('app.admin_override', 'true', true);
    UPDATE returns SET
      status = 'received', credit_invoice_id = NULL, total_credit_cents = 0,
      credited_at = NULL, credited_by = NULL, updated_at = now()
    WHERE credit_invoice_id = p_invoice_id;
    PERFORM set_config('app.admin_override', 'false', true);
  END IF;

  IF v_inv.invoice_type = 'field_application' AND v_inv.job_id IS NOT NULL THEN
    SELECT * INTO v_job FROM jobs WHERE id = v_inv.job_id FOR UPDATE;
    IF FOUND AND v_job.status = 'invoiced' THEN
      IF EXISTS (SELECT 1 FROM invoices o
                 WHERE o.job_id = v_inv.job_id AND o.id <> p_invoice_id
                   AND o.invoice_type = 'field_application'
                   AND o.status NOT IN ('voided', 'cancelled') AND o.deleted_at IS NULL) THEN
        IF v_job.invoice_id IS NOT DISTINCT FROM p_invoice_id THEN
          UPDATE application_records SET invoice_id = (
            SELECT o.id FROM invoices o
             WHERE o.job_id = v_inv.job_id AND o.id <> p_invoice_id
               AND o.invoice_type = 'field_application'
               AND o.status NOT IN ('voided', 'cancelled') AND o.deleted_at IS NULL
             ORDER BY o.created_at, o.id LIMIT 1)
            WHERE source_type = 'job' AND source_id = v_inv.job_id AND invoice_id = p_invoice_id;
          SET LOCAL app.admin_override = 'true';
          UPDATE jobs SET invoice_id = (
            SELECT o.id FROM invoices o
             WHERE o.job_id = v_inv.job_id AND o.id <> p_invoice_id
               AND o.invoice_type = 'field_application'
               AND o.status NOT IN ('voided', 'cancelled') AND o.deleted_at IS NULL
             ORDER BY o.created_at, o.id LIMIT 1)
            WHERE id = v_inv.job_id;
          RESET app.admin_override;
        END IF;
      ELSE
        UPDATE application_records SET invoice_id = NULL
          WHERE source_type = 'job' AND source_id = v_inv.job_id AND invoice_id = p_invoice_id;
        SET LOCAL app.admin_override = 'true';
        UPDATE jobs SET status = 'completed', invoice_id = NULL WHERE id = v_inv.job_id;
        RESET app.admin_override;
      END IF;
    END IF;
  END IF;

  IF v_inv.order_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM invoices WHERE order_id = v_inv.order_id
        AND id != p_invoice_id AND status NOT IN ('voided', 'cancelled') AND deleted_at IS NULL) THEN
      UPDATE commissions SET status = 'cancelled' WHERE order_id = v_inv.order_id AND status = 'pending';
      GET DIAGNOSTICS v_commissions_cancelled = ROW_COUNT;
    END IF;
  END IF;

  IF v_inv.invoice_type = 'field_application' AND v_inv.job_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM commissions c
      JOIN commission_payment_items cpi ON cpi.commission_id = c.id
      JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
      WHERE c.job_id = v_inv.job_id AND c.invoice_id = p_invoice_id
        AND c.status = 'pending' AND cp.status <> 'voided'
    ) THEN
      RAISE EXCEPTION 'JOB_HAS_BATCHED_COMMISSIONS: this job invoice''s pending commissions are in an active payout batch — void that commission payment first';
    END IF;
    IF EXISTS (
      SELECT 1 FROM commissions
      WHERE job_id = v_inv.job_id AND invoice_id = p_invoice_id AND status = 'paid'
    ) THEN
      INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
      SELECT p.id, 'Job invoice voided — commissions already paid',
        'Invoice ' || v_inv.invoice_number || ' was voided but its commissions were already paid out. Manual review needed before the job is re-invoiced.',
        'commission_review', 'invoice', p_invoice_id
      FROM profiles p WHERE p.role = 'admin' AND p.is_active = true;
    END IF;
    UPDATE commissions SET status = 'cancelled', commission_amount = 0
      WHERE job_id = v_inv.job_id AND invoice_id = p_invoice_id AND status = 'pending';
    GET DIAGNOSTICS v_commissions_cancelled = ROW_COUNT;
  END IF;

  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, old_values, new_values, total_impact_cents, description)
  VALUES ('invoice_voided', 'invoice', p_invoice_id, v_actor_role,
    jsonb_build_object('status', v_inv.status, 'total_cents', v_inv.total_amount_cents, 'paid_amount_cents', v_inv.paid_amount_cents, 'prepay_applied_cents', v_inv.prepay_applied_cents, 'write_off_cents', v_inv.write_off_cents),
    jsonb_build_object('status', 'voided', 'void_reason', p_void_reason, 'allocations_reversed_cents', v_total_allocations_reversed, 'prepay_restored_cents', v_total_prepay_restored, 'commissions_cancelled', v_commissions_cancelled),
    -1 * v_inv.total_amount_cents,
    'Voided ' || v_inv.invoice_number || ' — ' || p_void_reason ||
      CASE WHEN v_total_allocations_reversed > 0 THEN '. Reversed $' || (v_total_allocations_reversed / 100.0)::text || ' in allocations.' ELSE '' END ||
      CASE WHEN v_total_prepay_restored > 0 THEN ' Restored $' || (v_total_prepay_restored / 100.0)::text || ' in prepay credits.' ELSE '' END ||
      CASE WHEN v_commissions_cancelled > 0 THEN ' Cancelled ' || v_commissions_cancelled || ' pending commission(s).' ELSE '' END);

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_voided',
    'Voided invoice ' || v_inv.invoice_number || ' — ' || p_void_reason ||
      CASE WHEN v_total_allocations_reversed > 0 THEN '. Reversed $' || (v_total_allocations_reversed / 100.0)::text || ' in allocations.' ELSE '' END ||
      CASE WHEN v_total_prepay_restored > 0 THEN ' Restored $' || (v_total_prepay_restored / 100.0)::text || ' in prepay credits.' ELSE '' END ||
      CASE WHEN v_commissions_cancelled > 0 THEN ' Cancelled ' || v_commissions_cancelled || ' pending commission(s).' ELSE '' END,
    auth.uid(), 'invoice', p_invoice_id, v_inv.customer_id);

  IF v_total_allocations_reversed > 0 OR v_total_prepay_restored > 0 OR v_commissions_cancelled > 0 THEN
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    SELECT p.id, 'Invoice Voided — Allocations Reversed',
      'Invoice ' || v_inv.invoice_number || ' voided. $' ||
        (v_total_allocations_reversed / 100.0)::text || ' in allocations reversed, $' ||
        (v_total_prepay_restored / 100.0)::text || ' in prepay credits restored.' ||
        CASE WHEN v_commissions_cancelled > 0 THEN ' ' || v_commissions_cancelled || ' pending commission(s) cancelled.' ELSE '' END,
      'invoice_void_reversal', 'invoice', p_invoice_id
    FROM profiles p WHERE p.role = 'admin' AND p.is_active = true;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'void_invoice', jsonb_build_object(
      'success', true, 'invoice_id', p_invoice_id,
      'allocations_reversed_cents', v_total_allocations_reversed,
      'prepay_restored_cents', v_total_prepay_restored,
      'commissions_cancelled', v_commissions_cancelled));
  END IF;
END;
$function$;

-- =====================================================================================
-- 4. unapply_credit_memo — reverse everything the memo handed out before voiding it.
--    Exact live body + one inserted CREDIT-APPLY reversal loop.
-- =====================================================================================
CREATE OR REPLACE FUNCTION public.unapply_credit_memo(p_credit_memo_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor    uuid;
  v_invoice  record;
  v_return   record;
  v_existing jsonb;
  v_result   jsonb;
  v_capp     record;  -- CREDIT-APPLY: active-application cursor
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to unapply a credit memo';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key
       AND operation = 'unapply_credit_memo';
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  SELECT * INTO v_invoice
    FROM invoices
   WHERE id = p_credit_memo_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found: %', p_credit_memo_id;
  END IF;

  IF v_invoice.invoice_type != 'credit_memo' THEN
    RAISE EXCEPTION 'Invoice % is not a credit memo (type: %)', v_invoice.invoice_number, v_invoice.invoice_type;
  END IF;

  IF v_invoice.status != 'posted' THEN
    RAISE EXCEPTION 'Only posted credit memos can be unapplied (current status: %)', v_invoice.status;
  END IF;

  -- Preserved from LIVE (PARKED-001): unapply respects the ORIGINAL credit's booking period.
  -- NOT new in this migration — the on-disk base file (20260609190725) predates this live gate.
  PERFORM check_period_open(v_invoice.invoice_date);

  -- CREDIT-APPLY: reverse every active application this memo handed out, so each target becomes
  -- owed again and the ledger stays consistent, BEFORE the memo is voided below (Codex #4).
  FOR v_capp IN
    SELECT id, applied_at FROM credit_memo_applications
     WHERE credit_memo_id = p_credit_memo_id AND reversed_at IS NULL
     ORDER BY id
  LOOP
    -- drift HIGH: each application's reversal is a money movement — gate it on THAT application's
    -- own period (applied_at), matching void_invoice + reverse_credit_memo_application. The
    -- top-of-function check_period_open(v_invoice.invoice_date) only covers the memo's ISSUE date;
    -- an application that landed in a since-closed period must not be reversible without its gate.
    PERFORM check_period_open(v_capp.applied_at::date);
    PERFORM _reverse_credit_memo_application(v_capp.id, v_actor,
      (SELECT role FROM profiles WHERE id = v_actor),
      'Auto-reversed: credit memo ' || v_invoice.invoice_number || ' unapplied — ' || p_reason);
  END LOOP;

  SELECT * INTO v_return
    FROM returns
   WHERE credit_invoice_id = p_credit_memo_id
   FOR UPDATE;

  UPDATE invoices SET
    status      = 'voided',
    voided_by   = v_actor,
    voided_at   = now(),
    void_reason = p_reason,
    updated_at  = now()
  WHERE id = p_credit_memo_id;

  IF v_return.id IS NOT NULL THEN
    PERFORM set_config('app.admin_override', 'true', true);
    UPDATE returns SET
      status             = 'received',
      credit_invoice_id  = NULL,
      total_credit_cents = 0,
      credited_at        = NULL,
      credited_by        = NULL,
      updated_at         = now()
    WHERE id = v_return.id;
    PERFORM set_config('app.admin_override', 'false', true);
  END IF;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'credit_memo_unapplied', 'invoice', p_credit_memo_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('status', 'posted', 'total_amount_cents', v_invoice.total_amount_cents),
    jsonb_build_object(
      'status', 'voided',
      'return_reverted', CASE WHEN v_return.id IS NOT NULL THEN v_return.return_number ELSE NULL END
    ),
    -v_invoice.total_amount_cents,
    'Credit memo ' || v_invoice.invoice_number || ' unapplied: ' || p_reason
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'credit_memo_unapplied',
    'Credit memo ' || v_invoice.invoice_number || ' unapplied: ' || p_reason,
    v_actor, 'invoice', p_credit_memo_id, v_invoice.customer_id
  );

  v_result := jsonb_build_object(
    'success',         true,
    'credit_memo_id',  p_credit_memo_id,
    'invoice_number',  v_invoice.invoice_number,
    'return_id',       v_return.id,
    'return_reverted', v_return.id IS NOT NULL
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)
    VALUES (p_idempotency_key, 'unapply_credit_memo', v_result, now() + interval '24 hours')
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$function$;

-- =====================================================================================
-- 5. unpost_invoice — refuse while any credit is applied (target OR memo side).
--    Exact live body + credit_applied_cents added to the existing "payments/prepay/write-offs
--    applied" guard.
-- =====================================================================================
CREATE OR REPLACE FUNCTION public.unpost_invoice(p_invoice_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inv RECORD;
  v_actor_role text;
  v_existing jsonb;
  v_result jsonb;
  v_alloc_count int := 0;
  v_prepay_count int := 0;
  v_rup_voided int := 0;
  v_credit_app_count int := 0;  -- CREDIT-APPLY
BEGIN
  SELECT role INTO v_actor_role FROM profiles
    WHERE id = auth.uid() AND is_active = true AND role IN ('admin','sales_rep');
  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION 'Not authorized: requires admin,sales_rep role';
  END IF;
  IF p_performed_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match the authenticated user';
  END IF;
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'unpost_invoice');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found: %', p_invoice_id; END IF;
  IF v_inv.status NOT IN ('posted', 'overdue') THEN
    IF v_inv.status IN ('draft', 'unposted') THEN
      RAISE EXCEPTION 'Invoice % is not posted (status: %); there is nothing to unpost', v_inv.invoice_number, v_inv.status;
    ELSE
      RAISE EXCEPTION 'Cannot unpost a % invoice (%). Only a posted, unpaid invoice can be returned to the Unposted list.', v_inv.status, v_inv.invoice_number;
    END IF;
  END IF;

  SELECT count(*) INTO v_alloc_count FROM invoice_line_allocations WHERE invoice_id = p_invoice_id;
  SELECT count(*) INTO v_prepay_count FROM prepay_applications     WHERE invoice_id = p_invoice_id;
  -- CREDIT-APPLY: active applications where this invoice is the memo OR the target.
  SELECT count(*) INTO v_credit_app_count FROM credit_memo_applications
   WHERE reversed_at IS NULL AND (credit_memo_id = p_invoice_id OR target_invoice_id = p_invoice_id);
  IF v_alloc_count > 0
     OR v_prepay_count > 0
     OR v_credit_app_count > 0
     OR COALESCE(v_inv.paid_amount_cents, 0)    <> 0
     OR COALESCE(v_inv.prepay_applied_cents, 0) <> 0
     OR COALESCE(v_inv.write_off_cents, 0)      <> 0
     OR COALESCE(v_inv.credit_applied_cents, 0) <> 0
  THEN
    RAISE EXCEPTION 'Cannot unpost invoice % — it has payments, prepay, write-offs, or applied credit. Reverse those first (or void the invoice instead).', v_inv.invoice_number;
  END IF;

  PERFORM check_period_open(v_inv.invoice_date);

  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE invoices SET
    status      = 'unposted',
    posted_by   = NULL,
    posted_at   = NULL,
    updated_at  = now()
  WHERE id = p_invoice_id;
  PERFORM set_config('app.admin_override', 'false', true);

  UPDATE rup_sales_records SET
    voided_at  = now(),
    voided_by  = auth.uid(),
    void_reason = 'Invoice ' || v_inv.invoice_number || ' unposted'
  WHERE invoice_id = p_invoice_id
    AND voided_at IS NULL;
  GET DIAGNOSTICS v_rup_voided = ROW_COUNT;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'invoice_unposted', 'invoice', p_invoice_id, auth.uid(), v_actor_role,
    jsonb_build_object('status', v_inv.status, 'posted_at', v_inv.posted_at),
    jsonb_build_object('status', 'unposted', 'unposted_at', now()::text, 'rup_rows_voided', v_rup_voided),
    -1 * COALESCE(v_inv.total_amount_cents, 0),
    'Unposted ' || v_inv.invoice_number || ' (was ' || v_inv.status || ') — $' || (COALESCE(v_inv.total_amount_cents,0) / 100.0)::numeric(12,2)
      || CASE WHEN v_rup_voided > 0 THEN '; ' || v_rup_voided || ' RUP sale row(s) voided' ELSE '' END
  );

  IF v_rup_voided > 0 THEN
    INSERT INTO financial_audit_log (
      operation_type, entity_type, entity_id, actor_user_id, actor_role,
      new_values, total_impact_cents, description
    ) VALUES (
      'rup_sales_voided', 'invoice', p_invoice_id, auth.uid(), v_actor_role,
      jsonb_build_object('rows_voided', v_rup_voided, 'reason', 'invoice_unposted'),
      0,
      v_rup_voided || ' RUP sale row(s) voided for invoice ' || v_inv.invoice_number || ' on unpost'
    );
  END IF;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_unposted',
    'Unposted invoice ' || v_inv.invoice_number || ' — returned to the Unposted list',
    COALESCE(p_performed_by, auth.uid()), 'invoice', p_invoice_id, v_inv.customer_id);

  v_result := jsonb_build_object(
    'success', true,
    'invoice_id', p_invoice_id,
    'invoice_number', v_inv.invoice_number,
    'previous_status', v_inv.status,
    'status', 'unposted',
    'rup_rows_voided', v_rup_voided
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'unpost_invoice', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- =====================================================================================
-- 6. delete_invoices — defense-in-depth: refuse to soft-delete an invoice that still has an
--    active credit application. (In practice unreachable — only draft/unposted/voided are
--    deletable and none can carry a live application — but the FK is ON DELETE RESTRICT for
--    hard deletes only; a soft delete would otherwise bypass it.)
--    Exact live body + one inserted CREDIT-APPLY guard.
-- =====================================================================================
CREATE OR REPLACE FUNCTION public.delete_invoices(p_invoice_ids uuid[], p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inv        record;
  v_count      integer := 0;
  v_actor      uuid;
  v_actor_role text;
  v_existing   jsonb;
BEGIN
  PERFORM require_admin();  -- admin-only: matches invoices_update/invoices_delete RLS (is_admin())
  PERFORM check_rate_limit(auth.uid(), 'delete_invoices', 5, 60);
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'delete_invoices');
    IF v_existing IS NOT NULL THEN RETURN (v_existing->>'deleted_count')::integer; END IF;
  END IF;

  IF array_length(p_invoice_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No invoice IDs provided';
  END IF;

  FOR v_inv IN
    SELECT id, status, invoice_number, total_amount_cents, blend_ticket_id,
           invoice_type, job_id  -- U8 (Codex R3 P1): job-born invoice cleanup below
    FROM invoices
    WHERE id = ANY(p_invoice_ids) AND deleted_at IS NULL
    ORDER BY id
    FOR UPDATE
  LOOP
    -- Only draft / unposted / voided invoices are soft-deletable (matches the UI gates).
    IF v_inv.status NOT IN ('draft', 'unposted', 'voided') THEN CONTINUE; END IF;

    -- CREDIT-APPLY: never soft-delete an invoice that still has an active credit application on
    -- either side (would strand the ledger). Void reverses applications first, so a voided
    -- invoice reaching here is already clean; this is a belt-and-suspenders guard.
    IF EXISTS (
      SELECT 1 FROM credit_memo_applications
       WHERE reversed_at IS NULL
         AND (credit_memo_id = v_inv.id OR target_invoice_id = v_inv.id)
    ) THEN
      RAISE EXCEPTION 'INVOICE_HAS_ACTIVE_CREDIT_APPLICATIONS: reverse the credit application on % first', v_inv.invoice_number;
    END IF;

    UPDATE invoices SET deleted_at = now() WHERE id = v_inv.id;

    IF v_inv.blend_ticket_id IS NOT NULL THEN
      UPDATE blend_tickets SET payment_status = 'unbilled', updated_at = now()
      WHERE id = v_inv.blend_ticket_id AND payment_status = 'billed'
        AND NOT EXISTS (
          SELECT 1 FROM invoices i
          WHERE i.blend_ticket_id = v_inv.blend_ticket_id
            AND i.status NOT IN ('voided', 'cancelled')
            AND i.deleted_at IS NULL
        );
    END IF;

    IF v_inv.invoice_type = 'field_application' AND v_inv.job_id IS NOT NULL THEN
      IF EXISTS (
        SELECT 1 FROM commissions c
        JOIN commission_payment_items cpi ON cpi.commission_id = c.id
        JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
        WHERE c.job_id = v_inv.job_id AND c.invoice_id = v_inv.id
          AND c.status = 'pending' AND cp.status <> 'voided'
      ) THEN
        RAISE EXCEPTION 'JOB_HAS_BATCHED_COMMISSIONS: invoice % has pending commissions in an active payout batch — void that commission payment first', v_inv.invoice_number;
      END IF;
      IF EXISTS (
        SELECT 1 FROM commissions
        WHERE job_id = v_inv.job_id AND invoice_id = v_inv.id AND status = 'paid'
      ) THEN
        INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
        SELECT p.id, 'Job invoice deleted — commissions already paid',
          'Invoice ' || v_inv.invoice_number || ' was deleted but its commissions were already paid out. Manual review needed before the job is re-invoiced.',
          'commission_review', 'invoice', v_inv.id
        FROM profiles p WHERE p.role = 'admin' AND p.is_active = true;
      END IF;
      UPDATE commissions SET status = 'cancelled', commission_amount = 0
        WHERE job_id = v_inv.job_id AND invoice_id = v_inv.id AND status = 'pending';

      DECLARE
        v_job record;
      BEGIN
        SELECT * INTO v_job FROM jobs WHERE id = v_inv.job_id FOR UPDATE;
        IF FOUND AND v_job.status = 'invoiced' THEN
          IF EXISTS (SELECT 1 FROM invoices o
                     WHERE o.job_id = v_inv.job_id AND o.id <> v_inv.id
                       AND o.invoice_type = 'field_application'
                       AND o.status NOT IN ('voided', 'cancelled') AND o.deleted_at IS NULL) THEN
            IF v_job.invoice_id IS NOT DISTINCT FROM v_inv.id THEN
              UPDATE application_records SET invoice_id = (
                SELECT o.id FROM invoices o
                 WHERE o.job_id = v_inv.job_id AND o.id <> v_inv.id
                   AND o.invoice_type = 'field_application'
                   AND o.status NOT IN ('voided', 'cancelled') AND o.deleted_at IS NULL
                 ORDER BY o.created_at, o.id LIMIT 1)
                WHERE source_type = 'job' AND source_id = v_inv.job_id AND invoice_id = v_inv.id;
              SET LOCAL app.admin_override = 'true';
              UPDATE jobs SET invoice_id = (
                SELECT o.id FROM invoices o
                 WHERE o.job_id = v_inv.job_id AND o.id <> v_inv.id
                   AND o.invoice_type = 'field_application'
                   AND o.status NOT IN ('voided', 'cancelled') AND o.deleted_at IS NULL
                 ORDER BY o.created_at, o.id LIMIT 1)
                WHERE id = v_inv.job_id;
              RESET app.admin_override;
            END IF;
          ELSE
            UPDATE application_records SET invoice_id = NULL
              WHERE source_type = 'job' AND source_id = v_inv.job_id AND invoice_id = v_inv.id;
            SET LOCAL app.admin_override = 'true';
            UPDATE jobs SET status = 'completed', invoice_id = NULL WHERE id = v_inv.job_id;
            RESET app.admin_override;
          END IF;
        END IF;
      END;
    END IF;

    INSERT INTO financial_audit_log (
      operation_type, entity_type, entity_id, actor_role,
      old_values, new_values, total_impact_cents, description
    ) VALUES (
      'invoice_deleted', 'invoice', v_inv.id, v_actor_role,
      jsonb_build_object(
        'status', v_inv.status,
        'invoice_number', v_inv.invoice_number,
        'total_amount_cents', v_inv.total_amount_cents
      ),
      jsonb_build_object('deleted_at', now()),
      0,
      'Soft-deleted invoice ' || v_inv.invoice_number || ' (status ' || v_inv.status || ')'
    );

    v_count := v_count + 1;
  END LOOP;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'delete_invoices', jsonb_build_object('deleted_count', v_count));
  END IF;

  RETURN v_count;
END;
$function$;
