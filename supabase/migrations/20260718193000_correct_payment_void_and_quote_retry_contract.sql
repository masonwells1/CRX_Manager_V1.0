-- Forward-only correction for PR #168 review findings.
--
-- 1. void_payment intentionally retains invoice_line_allocations after it marks
--    the parent payment allocation set inactive. The prior void_invoice guard
--    treated those historical rows as still-applied cash and its cleanup would
--    delete them. Only active payment sets now block voiding; all payment
--    allocations remain immutable history.
-- 2. record_invoice_payment is a retired legacy path with no compatible reversal
--    workflow. The live table is empty and the UI uses allocate_payment, so the
--    function is replaced with a non-mutating tombstone and every execution grant
--    is removed. The migration aborts if a payment row appears before apply.
-- 3. get_customer_transaction_review ignores inactive payment history, so a
--    reversed payment cannot appear as a phantom credit after invoice void.
-- 4. revert_quote_status now uses the shared advisory-lock idempotency helper
--    and binds cached results to the quote, reason, and actor.
-- 5. Reopening a cancelled whole-conversion quote now fails closed if any
--    cancelled order has delivered inventory, a completed delivery, a posted
--    financial document, or a paid commission. The unused legacy
--    restore_cancelled_order path is retired and ungranted because it restored
--    only the status while leaving released inventory, cancelled commissions,
--    and cancelled invoices unreconstructed.
--
-- No business rows are modified by this migration.

DO $preflight$
BEGIN
  -- Serialize with every legacy INSERT. If an in-flight caller commits a row,
  -- this waits and then aborts instead of retiring the only writer around data
  -- that would need forensic reconciliation.
  LOCK TABLE public.payments IN ACCESS EXCLUSIVE MODE;

  IF EXISTS (SELECT 1 FROM public.payments) THEN
    RAISE EXCEPTION 'LEGACY_PAYMENT_RETIREMENT_BLOCKED: payments contains rows; reconcile them before retiring record_invoice_payment';
  END IF;
END;
$preflight$;

-- Re-emit the live void_invoice body with two narrow corrections: active
-- payment allocation sets block the void, while every payment allocation row
-- is excluded from generic cleanup so inactive reversal history survives.

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
  SELECT role INTO v_actor_role FROM profiles WHERE id = auth.uid() AND is_active = true;
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

  -- Forward correction: only ACTIVE payment allocation sets represent cash that
  -- is still applied. void_payment intentionally retains invoice-line allocations
  -- as immutable history after marking the parent payment set inactive, so those
  -- historical rows must neither block a later invoice void nor be deleted below.
  IF v_inv.paid_amount_cents > 0
     OR EXISTS (
       SELECT 1
       FROM invoice_line_allocations ila
       JOIN allocation_sets aset ON aset.id = ila.allocation_set_id
       WHERE ila.invoice_id = p_invoice_id
         AND aset.entity_type = 'payment'
         AND aset.is_active = true
     ) THEN
    RAISE EXCEPTION 'INVOICE_HAS_APPLIED_PAYMENTS: invoice % has $% in active applied payments — void or unapply those payments first (that re-banks the cash as prepay), then void the invoice',
      v_inv.invoice_number, (v_inv.paid_amount_cents / 100.0)::numeric(12,2);
  END IF;

  IF v_inv.status IN ('posted', 'paid', 'overdue') THEN PERFORM check_period_open(v_inv.invoice_date); END IF;

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

  -- Preserve every payment allocation as history. Active payment sets were
  -- rejected above; inactive sets are the audit trail left by void_payment.
  SELECT ARRAY(
    SELECT DISTINCT ila.allocation_set_id
    FROM invoice_line_allocations ila
    JOIN allocation_sets aset ON aset.id = ila.allocation_set_id
    WHERE ila.invoice_id = p_invoice_id
      AND aset.entity_type <> 'payment'
  ) INTO v_allocation_set_ids;

  FOR v_alloc IN
    SELECT ila.id, ila.amount_cents, ila.allocation_set_id
    FROM invoice_line_allocations ila
    JOIN allocation_sets aset ON aset.id = ila.allocation_set_id
    WHERE ila.invoice_id = p_invoice_id
      AND aset.entity_type <> 'payment'
  LOOP
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


-- Historical payment allocation rows remain in the ledger after void_payment.
-- The transaction-review report must count only active payment sets, matching
-- the AR source-of-truth and preventing a voided invoice from showing a phantom
-- credit after its payment was reversed.
CREATE OR REPLACE FUNCTION public.get_customer_transaction_review(p_customer_id uuid, p_start_date date, p_end_date date)
 RETURNS TABLE(transaction_date date, transaction_type text, reference_number text, description text, debit_cents bigint, credit_cents bigint, running_balance_cents bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM require_admin();
  RETURN QUERY
  WITH all_transactions AS (
    SELECT i.invoice_date AS tx_date,
           'Invoice' AS tx_type,
           i.invoice_number AS ref_num,
           CASE i.invoice_type
             WHEN 'chemical_sale' THEN 'Chemical Sale'
             WHEN 'field_application' THEN 'Field Application'
             WHEN 'misc_charge' THEN 'Misc Charge'
             ELSE COALESCE(i.invoice_type, 'Invoice')
           END AS descr,
           i.total_amount_cents AS debit,
           0::bigint AS credit
      FROM public.invoices i
     WHERE i.customer_id = p_customer_id
       AND i.status IN ('posted', 'paid', 'overdue')
       AND i.deleted_at IS NULL
       AND i.invoice_date BETWEEN p_start_date AND p_end_date

    UNION ALL

    SELECT als.payment_date AS tx_date,
           'Payment' AS tx_type,
           COALESCE(als.reference_number, als.check_number, 'PMT-' || LEFT(als.id::text, 8)) AS ref_num,
           COALESCE(als.payment_method, 'Payment') ||
             CASE WHEN als.check_number IS NOT NULL THEN ' #' || als.check_number ELSE '' END ||
             COALESCE(' — ' || als.notes, '') AS descr,
           0::bigint AS debit,
           ila.amount_cents AS credit
      FROM public.allocation_sets als
      JOIN public.invoice_line_allocations ila ON ila.allocation_set_id = als.id
     WHERE als.customer_id = p_customer_id
       AND als.entity_type = 'payment'
       AND als.is_active = true
       AND als.payment_date BETWEEN p_start_date AND p_end_date

    UNION ALL

    SELECT pa.applied_at::date AS tx_date,
           'Prepay Applied' AS tx_type,
           'PP-' || LEFT(pa.id::text, 8) AS ref_num,
           'Prepay credit applied' AS descr,
           0::bigint AS debit,
           pa.applied_amount_cents AS credit
      FROM public.prepay_applications pa
      JOIN public.invoices i ON i.id = pa.invoice_id
     WHERE i.customer_id = p_customer_id
       AND i.deleted_at IS NULL
       AND pa.applied_at::date BETWEEN p_start_date AND p_end_date

    UNION ALL

    SELECT w.created_at::date AS tx_date,
           'Write-Off' AS tx_type,
           'WO-' || LEFT(w.id::text, 8) AS ref_num,
           COALESCE(w.reason, 'Write-off') AS descr,
           0::bigint AS debit,
           w.amount_cents AS credit
      FROM public.write_offs w
     WHERE w.customer_id = p_customer_id
       AND w.created_at::date BETWEEN p_start_date AND p_end_date
  )
  SELECT t.tx_date AS transaction_date,
         t.tx_type AS transaction_type,
         t.ref_num AS reference_number,
         t.descr AS description,
         t.debit AS debit_cents,
         t.credit AS credit_cents,
         (SUM(t.debit - t.credit) OVER (ORDER BY t.tx_date, t.tx_type, t.ref_num))::bigint AS running_balance_cents
    FROM all_transactions t
   ORDER BY t.tx_date, t.tx_type, t.ref_num;
END;
$function$;


-- The frontend has used allocate_payment since 2026-07-11. Keep the signature
-- for a clear caller-facing error while removing the unreversible mutation.
CREATE OR REPLACE FUNCTION public.record_invoice_payment(
  p_invoice_id uuid,
  p_amount_cents bigint,
  p_payment_method text,
  p_reference_number text DEFAULT NULL::text,
  p_notes text DEFAULT NULL::text,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RAISE EXCEPTION 'RECORD_INVOICE_PAYMENT_RETIRED: use allocate_payment';
END;
$function$;

REVOKE ALL ON FUNCTION public.record_invoice_payment(uuid, bigint, text, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- B2 (Live Foundation Gauntlet 2026-07-18) — escape hatch for a quote stranded
-- at 'accepted' after its whole-conversion order was cancelled.
--
-- Background: convert_quote_to_order (whole path) parks the quote at 'accepted'
-- and writes quote_product_draws = fully drawn. Cancelling that order does NOT
-- reopen the quote (the cancel path's draw-reversal is gated on booking_draw,
-- which a whole conversion leaves false) — matching the deliberate "a converted
-- booking stays closed" semantic the void path also uses (smoke-draw-ledger-
-- reversal.sql S3). But there was then NO way out: revert_quote_status refused
-- because *an order exists*, and a re-convert returned the cancelled order
-- ('already_converted'). The quote was permanently dead-ended.
--
-- Safe fix (admin-driven, does NOT change default cancel/void behavior): let
-- revert_quote_status rescue such a quote.
--   1. The accepted-quote guard now blocks only when a NON-cancelled order
--      exists (a cancelled order no longer permanently locks the quote).
--   2. When reverting an accepted quote, release its draw ledger
--      (quote_product_draws -> 0) so the restored booking is genuinely
--      re-convertible; the cancel already released the prebook/holds, so this
--      only reconciles the booking accounting. Done BEFORE the planned-hold
--      rebuild so holds are computed against a clean (0-drawn) ledger.
--
-- Re-emit the live body with the shared retry helper and a versioned
-- request/response envelope, preserving compatibility with prior raw results.

CREATE OR REPLACE FUNCTION public.revert_quote_status(p_quote_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor    uuid;
  v_quote    record;
  v_existing jsonb;
  v_request  jsonb;
  v_result   jsonb;
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
    RAISE EXCEPTION 'Reason is required to revert quote status';
  END IF;

  v_request := jsonb_build_object(
    'version', 1,
    'quote_id', p_quote_id,
    'reason', trim(p_reason),
    'actor_id', v_actor
  );

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'revert_quote_status');
    IF v_existing IS NOT NULL THEN
      IF v_existing ? 'request' AND v_existing ? 'response' THEN
        IF v_existing->'request' IS DISTINCT FROM v_request THEN
          RAISE EXCEPTION 'IDEMPOTENCY_ARGUMENT_MISMATCH: revert_quote_status key was already used for a different quote, reason, or actor';
        END IF;
        RETURN v_existing->'response';
      END IF;

      -- Backward compatibility for a pre-migration raw result. The old format
      -- records quote_id but not reason/actor, so bind every field it can prove.
      IF (v_existing->>'quote_id')::uuid IS DISTINCT FROM p_quote_id THEN
        RAISE EXCEPTION 'IDEMPOTENCY_ARGUMENT_MISMATCH: revert_quote_status key was already used for a different quote';
      END IF;
      RETURN v_existing;
    END IF;
  END IF;

  SELECT * INTO v_quote
    FROM quotes
   WHERE id = p_quote_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote not found: %', p_quote_id;
  END IF;

  IF v_quote.status NOT IN ('declined', 'expired', 'cancelled', 'accepted') THEN
    RAISE EXCEPTION 'Cannot revert quote in status "%" — only declined, expired, cancelled, or accepted quotes can be reverted', v_quote.status;
  END IF;

  IF v_quote.status = 'accepted' THEN
    -- Only an ACTIVE (non-cancelled) order locks the quote outright. A quote
    -- whose only order was safely cancelled may be rescued below.
    IF EXISTS (SELECT 1 FROM orders WHERE quote_id = p_quote_id AND status <> 'cancelled') THEN
      RAISE EXCEPTION 'QUOTE_REOPEN_ACTIVE_ORDER: cannot revert accepted quote % while an active order exists', v_quote.quote_number;
    END IF;

    -- A cancelled order can retain delivered quantities. Re-converting the
    -- full quote would book those units again and duplicate inventory demand.
    IF EXISTS (
      SELECT 1
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
       WHERE o.quote_id = p_quote_id
         AND COALESCE(oi.quantity_delivered, 0) > 0
    ) OR EXISTS (
      SELECT 1
        FROM orders o
        JOIN deliveries d ON d.order_id = o.id
       WHERE o.quote_id = p_quote_id
         AND d.status = 'completed'
    ) THEN
      RAISE EXCEPTION 'QUOTE_REOPEN_DELIVERED_ACTIVITY: quote % has delivered inventory on a cancelled order; reconcile the original order instead of converting again', v_quote.quote_number;
    END IF;

    -- cancel_order intentionally leaves posted/paid/overdue invoices and paid
    -- commissions for manual review. A new full order would duplicate those
    -- financial obligations, so the escape hatch must remain closed.
    IF EXISTS (
      SELECT 1
        FROM orders o
        JOIN invoices i ON i.order_id = o.id
       WHERE o.quote_id = p_quote_id
         AND i.deleted_at IS NULL
         AND i.status IN ('posted', 'paid', 'overdue')
    ) THEN
      RAISE EXCEPTION 'QUOTE_REOPEN_POSTED_INVOICE: quote % has a posted, paid, or overdue invoice on a cancelled order', v_quote.quote_number;
    END IF;

    IF EXISTS (
      SELECT 1
        FROM orders o
        JOIN commissions c ON c.order_id = o.id
       WHERE o.quote_id = p_quote_id
         AND c.status = 'paid'
    ) THEN
      RAISE EXCEPTION 'QUOTE_REOPEN_PAID_COMMISSION: quote % has a paid commission on a cancelled order', v_quote.quote_number;
    END IF;
  END IF;

  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE quotes SET
    status     = 'sent',
    updated_at = now()
  WHERE id = p_quote_id;
  PERFORM set_config('app.admin_override', 'false', true);

  -- B2 fix: releasing an accepted quote means its draw ledger (written by the
  -- now-cancelled conversion/draw order) must be zeroed, or a re-convert would
  -- see it as fully drawn and return the cancelled order. The cancel already
  -- released the prebook and holds, so this only reconciles the booking
  -- accounting. Runs BEFORE the planned-hold rebuild below.
  IF v_quote.status = 'accepted' THEN
    UPDATE quote_product_draws
       SET quantity_drawn = 0, updated_at = now()
     WHERE quote_id = p_quote_id AND quantity_drawn <> 0;
  END IF;

  -- >>> Codex round-9 P2 (atomic planned-reopen holds) — the ONLY change vs live.
  -- A planned booking's holds were released when it went terminal; reopening to 'sent'
  -- must rebuild them or it reserves no inventory. Atomic in this txn: if this raises,
  -- the revert rolls back and the quote stays terminal (no sent-without-holds state).
  IF v_quote.is_planned THEN
    PERFORM create_planned_holds(p_quote_id, v_actor, NULL);
  END IF;
  -- <<< end Codex round-9 P2 change.

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, description
  ) VALUES (
    'quote_status_reverted', 'quote', p_quote_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('status', v_quote.status),
    jsonb_build_object('status', 'sent'),
    'Quote ' || v_quote.quote_number || ' reverted from ' || v_quote.status || ' to sent: ' || p_reason
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'quote_status_reverted',
    'Quote ' || v_quote.quote_number || ' reverted from ' || v_quote.status || ' to sent: ' || p_reason,
    v_actor, 'quote', p_quote_id, v_quote.customer_id
  );

  v_result := jsonb_build_object(
    'success',       true,
    'quote_id',      p_quote_id,
    'quote_number',  v_quote.quote_number,
    'old_status',    v_quote.status,
    'new_status',    'sent'
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)
    VALUES (
      p_idempotency_key,
      'revert_quote_status',
      jsonb_build_object('request', v_request, 'response', v_result),
      now() + interval '24 hours'
    )
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$function$;

-- Retire the unused restore path instead of preserving a status-only repair.
-- cancel_order releases inventory, deactivates holds, cancels/zeros pending
-- commissions, and cancels/zeros draft invoices; the legacy restore function
-- rebuilt none of those effects. There is no repository caller. Keep the
-- signature as a non-mutating tombstone so stale direct clients fail explicitly.

CREATE OR REPLACE FUNCTION public.restore_cancelled_order(
  p_order_id uuid,
  p_reason text,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'RESTORE_CANCELLED_ORDER_RETIRED: reopen the quote through the reviewed escape hatch or create a new explicit correction workflow';
END;
$function$;

REVOKE ALL ON FUNCTION public.restore_cancelled_order(uuid, text, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;


DO $postflight$
DECLARE
  v_void_source text;
  v_review_source text;
  v_quote_source text;
  v_restore_source text;
  v_payment_source text;
BEGIN
  SELECT prosrc INTO v_void_source
  FROM pg_proc
  WHERE oid = 'public.void_invoice(uuid, text, text)'::regprocedure;

  IF v_void_source NOT LIKE '%aset.entity_type = ''payment''%'
     OR v_void_source NOT LIKE '%aset.is_active = true%'
     OR v_void_source NOT LIKE '%aset.entity_type <> ''payment''%' THEN
    RAISE EXCEPTION 'VOID_INVOICE_POSTFLIGHT_FAILED: active-payment guard or history preservation missing';
  END IF;

  SELECT prosrc INTO v_review_source
  FROM pg_proc
  WHERE oid = 'public.get_customer_transaction_review(uuid, date, date)'::regprocedure;

  IF v_review_source NOT LIKE '%als.entity_type = ''payment''%'
     OR v_review_source NOT LIKE '%als.is_active = true%' THEN
    RAISE EXCEPTION 'TRANSACTION_REVIEW_POSTFLIGHT_FAILED: active-payment filter missing';
  END IF;

  SELECT prosrc INTO v_quote_source
  FROM pg_proc
  WHERE oid = 'public.revert_quote_status(uuid, text, uuid, text)'::regprocedure;

  IF v_quote_source NOT LIKE '%check_idempotency(p_idempotency_key, ''revert_quote_status'')%'
     OR v_quote_source NOT LIKE '%IDEMPOTENCY_ARGUMENT_MISMATCH%'
     OR v_quote_source NOT LIKE '%QUOTE_REOPEN_DELIVERED_ACTIVITY%'
     OR v_quote_source NOT LIKE '%QUOTE_REOPEN_POSTED_INVOICE%'
     OR v_quote_source NOT LIKE '%QUOTE_REOPEN_PAID_COMMISSION%'
     OR v_quote_source NOT LIKE '%jsonb_build_object(''request'', v_request, ''response'', v_result)%' THEN
    RAISE EXCEPTION 'REVERT_QUOTE_POSTFLIGHT_FAILED: lifecycle guard or bound shared-idempotency contract missing';
  END IF;

  SELECT prosrc INTO v_restore_source
  FROM pg_proc
  WHERE oid = 'public.restore_cancelled_order(uuid, text, uuid, text)'::regprocedure;

  IF v_restore_source NOT LIKE '%RESTORE_CANCELLED_ORDER_RETIRED:%' THEN
    RAISE EXCEPTION 'RESTORE_ORDER_POSTFLIGHT_FAILED: retired tombstone missing';
  END IF;

  IF has_function_privilege('anon', 'public.restore_cancelled_order(uuid, text, uuid, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.restore_cancelled_order(uuid, text, uuid, text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.restore_cancelled_order(uuid, text, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'RESTORE_ORDER_POSTFLIGHT_FAILED: execute grant remains';
  END IF;

  SELECT prosrc INTO v_payment_source
  FROM pg_proc
  WHERE oid = 'public.record_invoice_payment(uuid, bigint, text, text, text, text)'::regprocedure;

  IF v_payment_source NOT LIKE '%RECORD_INVOICE_PAYMENT_RETIRED: use allocate_payment%' THEN
    RAISE EXCEPTION 'RECORD_PAYMENT_POSTFLIGHT_FAILED: tombstone missing';
  END IF;

  IF EXISTS (SELECT 1 FROM public.payments) THEN
    RAISE EXCEPTION 'RECORD_PAYMENT_POSTFLIGHT_FAILED: legacy payment row appeared during retirement';
  END IF;

  IF has_function_privilege('anon', 'public.record_invoice_payment(uuid, bigint, text, text, text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.record_invoice_payment(uuid, bigint, text, text, text, text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.record_invoice_payment(uuid, bigint, text, text, text, text)', 'EXECUTE') THEN
    -- anon inherits PUBLIC, so an implicit/default PUBLIC grant also trips the
    -- anon check above.
    RAISE EXCEPTION 'RECORD_PAYMENT_POSTFLIGHT_FAILED: execute grant remains';
  END IF;
END;
$postflight$;
