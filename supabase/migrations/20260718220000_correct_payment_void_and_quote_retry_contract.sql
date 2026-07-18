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
--    cancelled order has delivered inventory, a completed delivery, any active
--    financial document, or a paid commission. The unused legacy
--    restore_cancelled_order path is retired and ungranted because it restored
--    only the status while leaving released inventory, cancelled commissions,
--    and cancelled invoices unreconstructed.
-- 6. Every order-linked invoice insert (mono, split, save_invoice, or direct)
--    locks its source order and rejects deleted/cancelled/voided orders. The mono
--    creator also fails early under its existing order row lock. A matching
--    completed-delivery recovery remains valid only through its capability-marked
--    RPC; recovered items/lineage are immutable and posting revalidates exact data.
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

-- A cancelled order is a terminal historical record. The prior creator locked
-- the order but did not inspect its status, so it could create a late draft
-- after cancellation or after its quote was safely reopened. Re-emit the latest
-- body with one fail-closed terminal-status check immediately after that lock.
CREATE OR REPLACE FUNCTION public.create_invoice_from_order(p_order_id uuid, p_salesman_id uuid DEFAULT NULL::uuid, p_invoice_type text DEFAULT 'chemical_sale'::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor          uuid := auth.uid();
  v_order          record;
  v_invoice_id     uuid;
  v_item           record;
  v_total_cents    bigint := 0;
  v_cost_cents     bigint := 0;
  v_existing       jsonb;
  v_existing_count int;
  v_delivery_count int;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to create invoices from orders';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'create_invoice_from_order');
    IF v_existing IS NOT NULL THEN RETURN (v_existing->>'invoice_id')::uuid; END IF;
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found: %', p_order_id; END IF;
  IF v_order.status IN ('cancelled', 'voided') THEN
    RAISE EXCEPTION 'ORDER_INVOICE_TERMINAL: cannot create an invoice from % order %', v_order.status, v_order.order_number;
  END IF;

  SELECT COUNT(*) INTO v_existing_count
    FROM invoices
   WHERE order_id = p_order_id
     AND status NOT IN ('voided', 'cancelled');
  IF v_existing_count > 0 THEN
    RAISE EXCEPTION 'Active invoice already exists for order % (% existing invoice(s)). Void or cancel the existing invoice first if you need to recreate.', v_order.order_number, v_existing_count;
  END IF;

  SELECT COUNT(*) INTO v_delivery_count
    FROM deliveries
   WHERE order_id = p_order_id
     AND status NOT IN ('cancelled', 'voided');
  IF v_delivery_count > 0 THEN
    RAISE EXCEPTION 'Cannot create an order-level invoice for order % — it has % active delivery(ies); invoices are created per delivery on completion. Cancel/void those deliveries first to bill the whole order manually.', v_order.order_number, v_delivery_count;
  END IF;

  INSERT INTO invoices (
    order_id, customer_id, invoice_type, status, season,
    salesman_id, created_by, total_amount_cents, invoice_date
  ) VALUES (
    p_order_id, v_order.customer_id, p_invoice_type, 'draft',
    COALESCE(v_order.season, (SELECT current_season())),
    COALESCE(p_salesman_id, v_order.salesman_id),
    v_actor, 0, CURRENT_DATE
  )
  RETURNING id INTO v_invoice_id;

  FOR v_item IN
    SELECT * FROM order_items WHERE order_id = p_order_id ORDER BY sort_order NULLS LAST, id
  LOOP
    INSERT INTO invoice_items (
      invoice_id, order_item_id, product_id, description,
      quantity, unit_price_cents, extended_cents, cost_cents,
      sort_order, rate_per_acre, acres, unit_size
    ) VALUES (
      v_invoice_id, v_item.id, v_item.product_id,
      COALESCE(v_item.product_name, ''),
      v_item.total_units_needed,
      round(v_item.price_per_unit * 100)::bigint,
      round(v_item.total_price * 100)::bigint,
      round(v_item.cost_per_unit * 100)::bigint,
      COALESCE(v_item.sort_order, 0),
      v_item.actual_rate,
      v_item.acres,
      v_item.unit_size
    );
    v_total_cents := v_total_cents + round(v_item.total_price * 100)::bigint;
    v_cost_cents := v_cost_cents + round(COALESCE(v_item.cost_per_unit, 0) * v_item.total_units_needed * 100)::bigint;
  END LOOP;

  UPDATE invoices SET total_amount_cents = v_total_cents, total_cost_cents = v_cost_cents WHERE id = v_invoice_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'invoice_created', 'invoice', v_invoice_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object(
      'invoice_number', (SELECT invoice_number FROM invoices WHERE id = v_invoice_id),
      'order_number', v_order.order_number,
      'customer_id', v_order.customer_id,
      'total_cents', v_total_cents
    ),
    v_total_cents,
    'Invoice created from order ' || v_order.order_number
  );

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_created',
    'Invoice created from order ' || v_order.order_number,
    v_actor, 'invoice', v_invoice_id, v_order.customer_id
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_invoice_from_order', jsonb_build_object('invoice_id', v_invoice_id));
  END IF;

  RETURN v_invoice_id;
END;
$function$;

-- Owner-only, transaction-scoped capability rows cannot be forged by SQL-capable
-- anon/authenticated/service roles: the table has RLS, a deny-all policy, and no grants.
-- Rows exist only while the audited writer/poster is executing and are removed
-- before it returns (or rolled back with the failed statement).
CREATE TABLE public.invoice_delivery_recovery_capabilities (
  transaction_id bigint NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('writer', 'poster')),
  delivery_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (transaction_id, purpose)
);

ALTER TABLE public.invoice_delivery_recovery_capabilities ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoice_delivery_recovery_capabilities_deny_all
ON public.invoice_delivery_recovery_capabilities
FOR ALL
TO PUBLIC
USING (false)
WITH CHECK (false);
REVOKE ALL ON TABLE public.invoice_delivery_recovery_capabilities
  FROM PUBLIC, anon, authenticated, service_role;

-- Preserve the public completed-delivery recovery RPC while giving its invoice
-- header/item writes the private capability above. The mature implementation
-- remains owner-only behind a same-signature wrapper, so callers/result stay stable.
ALTER FUNCTION public.create_invoice_for_unbilled_delivery(uuid, uuid, text)
  RENAME TO _create_invoice_for_unbilled_delivery_impl_20260718;

REVOKE ALL ON FUNCTION public._create_invoice_for_unbilled_delivery_impl_20260718(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.create_invoice_for_unbilled_delivery(
  p_delivery_id uuid,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  DELETE FROM public.invoice_delivery_recovery_capabilities
   WHERE transaction_id = txid_current() AND purpose = 'writer';
  INSERT INTO public.invoice_delivery_recovery_capabilities (
    transaction_id, purpose, delivery_id, actor_id
  ) VALUES (txid_current(), 'writer', p_delivery_id, v_actor);

  BEGIN
    v_result := public._create_invoice_for_unbilled_delivery_impl_20260718(
      p_delivery_id, p_performed_by, p_idempotency_key
    );
  EXCEPTION WHEN OTHERS THEN
    DELETE FROM public.invoice_delivery_recovery_capabilities
     WHERE transaction_id = txid_current() AND purpose = 'writer';
    RAISE;
  END;

  DELETE FROM public.invoice_delivery_recovery_capabilities
   WHERE transaction_id = txid_current() AND purpose = 'writer';
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_invoice_for_unbilled_delivery(uuid, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_invoice_for_unbilled_delivery(uuid, uuid, text)
  TO authenticated, service_role;

-- Central money invariant: every current and future invoice writer must pass
-- through the same terminal-order gate. FOR UPDATE makes invoice creation and
-- cancel/void serialize in order -> invoice lock order, without adding the
-- quote -> order lock inversion that would deadlock with cancel_order.
CREATE OR REPLACE FUNCTION public.guard_invoice_terminal_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_order_status text;
  v_order_number text;
  v_order_deleted_at timestamptz;
  v_valid_completed_delivery boolean := false;
  v_valid_delivery_lineage boolean := false;
  v_has_writer_capability boolean := false;
  v_has_poster_capability boolean := false;
  v_canonical_cancel_cleanup boolean := false;
  v_canonical_void_cleanup boolean := false;
  v_lock_order boolean := true;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.order_id IS DISTINCT FROM OLD.order_id
       OR NEW.delivery_id IS DISTINCT FROM OLD.delivery_id THEN
      RAISE EXCEPTION 'INVOICE_SOURCE_LINEAGE_IMMUTABLE: order_id and delivery_id cannot change after invoice creation';
    END IF;
    -- The row update already owns the invoice lock. Never take an order lock
    -- afterwards; cancel_order owns the canonical order -> invoice sequence.
    v_lock_order := false;
  END IF;

  IF NEW.order_id IS NULL THEN
    IF NEW.delivery_id IS NOT NULL THEN
      RAISE EXCEPTION 'INVOICE_DELIVERY_ORDER_REQUIRED: a delivery-linked invoice must retain its source order';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT v_lock_order THEN
    -- save_invoice already holds the invoice row before an existing-row edit.
    -- Do not reverse the canonical order -> invoice lock order here: a concurrent
    -- cancel holds the order, waits for this invoice, then cancels it safely.
    SELECT o.status, o.order_number, o.deleted_at
      INTO v_order_status, v_order_number, v_order_deleted_at
      FROM public.orders o
     WHERE o.id = NEW.order_id;
  ELSE
    -- INSERT: serialize against cancel/void first.
    SELECT o.status, o.order_number, o.deleted_at
      INTO v_order_status, v_order_number, v_order_deleted_at
      FROM public.orders o
     WHERE o.id = NEW.order_id
     FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_INVOICE_TERMINAL: cannot attach an invoice to missing order %', NEW.order_id;
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.invoice_delivery_recovery_capabilities c
     WHERE c.transaction_id = txid_current()
       AND c.purpose = 'writer'
       AND c.delivery_id = NEW.delivery_id
       AND c.actor_id = auth.uid()
  ) INTO v_has_writer_capability;

  SELECT EXISTS (
    SELECT 1
      FROM public.invoice_delivery_recovery_capabilities c
     WHERE c.transaction_id = txid_current()
       AND c.purpose = 'poster'
       AND c.delivery_id = NEW.delivery_id
       AND c.actor_id = auth.uid()
  ) INTO v_has_poster_capability;

  v_canonical_cancel_cleanup :=
    TG_OP = 'UPDATE'
    AND v_order_status = 'cancelled'
    AND OLD.status IN ('draft', 'unposted')
    AND NEW.status = 'cancelled'
    AND NEW.total_amount_cents = 0
    AND NEW.paid_amount_cents = 0
    AND NEW.prepay_applied_cents = 0
    AND NEW.write_off_cents = 0
    AND NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id
    AND NEW.invoice_number IS NOT DISTINCT FROM OLD.invoice_number
    AND NEW.invoice_type IS NOT DISTINCT FROM OLD.invoice_type
    AND NEW.total_cost_cents IS NOT DISTINCT FROM OLD.total_cost_cents;

  v_canonical_void_cleanup :=
    TG_OP = 'UPDATE'
    AND OLD.status NOT IN ('cancelled', 'voided')
    AND NEW.status = 'voided'
    AND NEW.total_amount_cents = 0
    AND NEW.paid_amount_cents = 0
    AND NEW.prepay_applied_cents = 0
    AND NEW.write_off_cents = 0
    AND NEW.credit_applied_cents = 0
    AND NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id
    AND NEW.invoice_number IS NOT DISTINCT FROM OLD.invoice_number
    AND NEW.invoice_type IS NOT DISTINCT FROM OLD.invoice_type
    AND NEW.total_cost_cents IS NOT DISTINCT FROM OLD.total_cost_cents;

  -- Once a source order is terminal, its invoice lineage and principal money
  -- cannot be rewritten. The audited recovery writer may set exact delivered
  -- totals while it constructs a cancelled-order recovery draft.
  IF TG_OP = 'UPDATE'
     AND (v_order_status IN ('cancelled', 'voided') OR v_order_deleted_at IS NOT NULL)
     AND NOT v_has_writer_capability
     AND NOT v_canonical_cancel_cleanup
     AND NOT v_canonical_void_cleanup
     AND (
       NEW.customer_id IS DISTINCT FROM OLD.customer_id
       OR NEW.invoice_number IS DISTINCT FROM OLD.invoice_number
       OR NEW.invoice_type IS DISTINCT FROM OLD.invoice_type
       OR NEW.total_amount_cents IS DISTINCT FROM OLD.total_amount_cents
       OR NEW.total_cost_cents IS DISTINCT FROM OLD.total_cost_cents
     ) THEN
    RAISE EXCEPTION 'TERMINAL_ORDER_INVOICE_PRINCIPAL_IMMUTABLE: source, type, customer, and principal cents cannot change';
  END IF;

  -- Canonical cancel/void/delete cleanup must keep working after the parent
  -- order is made terminal. Principal fields were frozen immediately above.
  IF TG_OP = 'UPDATE'
     AND (v_order_status IN ('cancelled', 'voided') OR v_order_deleted_at IS NOT NULL)
     AND (NEW.status IN ('cancelled', 'voided') OR NEW.deleted_at IS NOT NULL) THEN
    RETURN NEW;
  END IF;

  IF v_order_deleted_at IS NOT NULL OR v_order_status = 'voided' THEN
    RAISE EXCEPTION 'ORDER_INVOICE_TERMINAL: cannot attach or update a nonterminal invoice on deleted or voided order %', COALESCE(v_order_number, NEW.order_id::text);
  END IF;

  IF NEW.delivery_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.deliveries d
       WHERE d.id = NEW.delivery_id
         AND d.order_id = NEW.order_id
         AND d.customer_id = NEW.customer_id
         AND d.deleted_at IS NULL
    ) INTO v_valid_delivery_lineage;
    IF NOT v_valid_delivery_lineage THEN
      RAISE EXCEPTION 'INVOICE_DELIVERY_LINEAGE_INVALID: delivery, order, and customer must match';
    END IF;
  END IF;

  -- Cancelling an undelivered remainder must not erase the legitimate recovery
  -- path for product already delivered but not yet billed. Only a real completed,
  -- non-deleted delivery with matching order/customer lineage gets this exception.
  IF v_order_status = 'cancelled' THEN
    IF TG_OP = 'INSERT' OR OLD.status IN ('draft', 'unposted') THEN
      SELECT EXISTS (
        SELECT 1
          FROM public.deliveries d
         WHERE d.id = NEW.delivery_id
           AND d.order_id = NEW.order_id
           AND d.customer_id = NEW.customer_id
           AND d.status = 'completed'
           AND d.deleted_at IS NULL
      ) INTO v_valid_completed_delivery;

      IF NOT v_valid_completed_delivery THEN
        RAISE EXCEPTION 'CANCELLED_DELIVERY_INVOICE_WRITER_REQUIRED: cancelled order % accepts only the audited completed-delivery recovery writer', COALESCE(v_order_number, NEW.order_id::text);
      END IF;

      IF TG_OP = 'INSERT' THEN
        IF auth.uid() IS NULL OR NOT v_has_writer_capability THEN
          RAISE EXCEPTION 'CANCELLED_DELIVERY_INVOICE_WRITER_REQUIRED: cancelled order % accepts only the audited completed-delivery recovery writer', COALESCE(v_order_number, NEW.order_id::text);
        END IF;
      ELSIF auth.uid() IS NULL
         OR (NOT v_has_writer_capability AND NOT v_has_poster_capability) THEN
        RAISE EXCEPTION 'CANCELLED_DELIVERY_INVOICE_HEADER_IMMUTABLE: use the audited recovery/posting RPCs';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_invoice_terminal_order()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_guard_invoice_terminal_order ON public.invoices;
CREATE TRIGGER trg_guard_invoice_terminal_order
BEFORE INSERT OR UPDATE ON public.invoices
FOR EACH ROW
EXECUTE FUNCTION public.guard_invoice_terminal_order();

-- Keep the recovery draft byte-faithful to delivered items after creation. The
-- private writer capability remains set while its mature implementation inserts
-- invoice_items, then the public wrapper clears it before returning to the caller.
CREATE OR REPLACE FUNCTION public.guard_cancelled_delivery_invoice_items()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_old_order_status text;
  v_new_order_status text;
  v_old_delivery_id uuid;
  v_new_delivery_id uuid;
  v_old_has_writer_capability boolean := false;
  v_new_has_writer_capability boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT o.status, i.delivery_id
      INTO v_old_order_status, v_old_delivery_id
      FROM public.invoices i
      JOIN public.orders o ON o.id = i.order_id
     WHERE i.id = OLD.invoice_id;
    SELECT EXISTS (
      SELECT 1 FROM public.invoice_delivery_recovery_capabilities c
       WHERE c.transaction_id = txid_current()
         AND c.purpose = 'writer'
         AND c.delivery_id = v_old_delivery_id
         AND c.actor_id = auth.uid()
    ) INTO v_old_has_writer_capability;
    IF v_old_order_status = 'cancelled'
       AND (auth.uid() IS NULL OR NOT v_old_has_writer_capability) THEN
      RAISE EXCEPTION 'CANCELLED_DELIVERY_INVOICE_ITEMS_IMMUTABLE: use the audited completed-delivery recovery writer';
    END IF;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    SELECT o.status, i.delivery_id
      INTO v_new_order_status, v_new_delivery_id
      FROM public.invoices i
      JOIN public.orders o ON o.id = i.order_id
     WHERE i.id = NEW.invoice_id;
    SELECT EXISTS (
      SELECT 1 FROM public.invoice_delivery_recovery_capabilities c
       WHERE c.transaction_id = txid_current()
         AND c.purpose = 'writer'
         AND c.delivery_id = v_new_delivery_id
         AND c.actor_id = auth.uid()
    ) INTO v_new_has_writer_capability;
    IF v_new_order_status = 'cancelled'
       AND (auth.uid() IS NULL OR NOT v_new_has_writer_capability) THEN
      RAISE EXCEPTION 'CANCELLED_DELIVERY_INVOICE_ITEMS_IMMUTABLE: use the audited completed-delivery recovery writer';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_cancelled_delivery_invoice_items()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_guard_cancelled_delivery_invoice_items ON public.invoice_items;
CREATE TRIGGER trg_guard_cancelled_delivery_invoice_items
BEFORE INSERT OR UPDATE OR DELETE ON public.invoice_items
FOR EACH ROW
EXECUTE FUNCTION public.guard_cancelled_delivery_invoice_items();

-- The delivery-recovery exception must reach posted revenue, not strand a
-- correct draft. Re-emit the canonical posting helper with the same narrow
-- completed-delivery lineage check. This helper already runs after the public
-- wrapper locks the invoice, so its order/delivery reads deliberately do not
-- take a reverse order lock.
CREATE OR REPLACE FUNCTION public._post_invoice_impl_20260714(p_invoice_id uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_inv record; v_order_status text; v_order_pricing text; v_order_deleted_at timestamptz; v_existing jsonb; v_terms_days integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'Not authorized to post invoices';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'post_invoice');
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found: %', p_invoice_id; END IF;
  PERFORM check_period_open(v_inv.invoice_date);
  IF v_inv.status NOT IN ('draft', 'unposted') THEN RAISE EXCEPTION 'Cannot post invoice with status: %', v_inv.status; END IF;
  IF v_inv.pricing_pending THEN RAISE EXCEPTION 'PRICING_INCOMPLETE'; END IF;
  IF v_inv.order_id IS NOT NULL THEN
    SELECT status, pricing_status, deleted_at
      INTO v_order_status, v_order_pricing, v_order_deleted_at
      FROM orders WHERE id = v_inv.order_id;
    IF v_order_status = 'voided' OR v_order_deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'ORDER_INVOICE_TERMINAL: cannot post an invoice linked to a deleted or voided order';
    END IF;
    IF v_order_status = 'cancelled' THEN
      IF v_inv.delivery_id IS NULL
         OR NOT EXISTS (
           SELECT 1
             FROM deliveries d
            WHERE d.id = v_inv.delivery_id
              AND d.order_id = v_inv.order_id
              AND d.customer_id = v_inv.customer_id
              AND d.status = 'completed'
              AND d.deleted_at IS NULL
         ) THEN
        RAISE EXCEPTION 'CANCELLED_ORDER_DELIVERY_BILLING_ONLY: cancelled order % permits only a matching completed-delivery invoice', v_inv.order_id;
      END IF;

      -- Defense in depth: the trusted creator writes exact delivered quantities
      -- and prices. Refuse posting if header or lines drifted before posting.
      IF NOT EXISTS (
           SELECT 1 FROM delivery_items di
           WHERE di.delivery_id = v_inv.delivery_id
             AND COALESCE(di.quantity_delivered, 0) > 0
         )
         OR v_inv.total_amount_cents IS DISTINCT FROM (
           SELECT COALESCE(SUM(ROUND(di.quantity_delivered * oi.price_per_unit * 100)::bigint), 0)
           FROM delivery_items di
           JOIN order_items oi ON oi.id = di.order_item_id
           WHERE di.delivery_id = v_inv.delivery_id
             AND COALESCE(di.quantity_delivered, 0) > 0
         )
         OR v_inv.total_cost_cents IS DISTINCT FROM (
           SELECT COALESCE(SUM(ROUND(di.quantity_delivered * COALESCE(oi.cost_per_unit, 0) * 100)::bigint), 0)
           FROM delivery_items di
           JOIN order_items oi ON oi.id = di.order_item_id
           WHERE di.delivery_id = v_inv.delivery_id
             AND COALESCE(di.quantity_delivered, 0) > 0
         )
         OR EXISTS (
           WITH delivered AS (
             SELECT di.order_item_id, di.product_id,
                    SUM(di.quantity_delivered) AS quantity,
                    SUM(ROUND(di.quantity_delivered * oi.price_per_unit * 100)::bigint) AS extended_cents,
                    ROUND(MAX(oi.price_per_unit) * 100)::bigint AS unit_price_cents,
                    ROUND(MAX(COALESCE(oi.cost_per_unit, 0)) * 100)::bigint AS cost_cents
             FROM delivery_items di
             JOIN order_items oi ON oi.id = di.order_item_id
             WHERE di.delivery_id = v_inv.delivery_id
               AND COALESCE(di.quantity_delivered, 0) > 0
             GROUP BY di.order_item_id, di.product_id
           ), billed AS (
             SELECT ii.order_item_id, ii.product_id,
                    SUM(ii.quantity) AS quantity,
                    SUM(ii.extended_cents) AS extended_cents,
                    MIN(ii.unit_price_cents) AS min_unit_price_cents,
                    MAX(ii.unit_price_cents) AS max_unit_price_cents,
                    MIN(ii.cost_cents) AS min_cost_cents,
                    MAX(ii.cost_cents) AS max_cost_cents
             FROM invoice_items ii
             WHERE ii.invoice_id = p_invoice_id
             GROUP BY ii.order_item_id, ii.product_id
           )
           SELECT 1
           FROM delivered d
           FULL JOIN billed b
             ON b.order_item_id = d.order_item_id
            AND b.product_id = d.product_id
           WHERE d.order_item_id IS NULL
              OR b.order_item_id IS NULL
              OR d.quantity IS DISTINCT FROM b.quantity
              OR d.extended_cents IS DISTINCT FROM b.extended_cents
              OR d.unit_price_cents IS DISTINCT FROM b.min_unit_price_cents
              OR d.unit_price_cents IS DISTINCT FROM b.max_unit_price_cents
              OR d.cost_cents IS DISTINCT FROM b.min_cost_cents
              OR d.cost_cents IS DISTINCT FROM b.max_cost_cents
         ) THEN
        RAISE EXCEPTION 'DELIVERY_INVOICE_CONTENT_MISMATCH: completed-delivery invoice no longer matches delivered quantities and cents';
      END IF;
    END IF;
    IF v_order_pricing = 'needs_pricing' THEN RAISE EXCEPTION 'PRICING_INCOMPLETE'; END IF;
  END IF;

  SELECT parse_payment_terms_days(COALESCE(NULLIF(btrim(v_inv.payment_terms), ''), c.payment_terms))
    INTO v_terms_days
  FROM customers c WHERE c.id = v_inv.customer_id;

  IF v_order_status = 'cancelled' THEN
    DELETE FROM public.invoice_delivery_recovery_capabilities
     WHERE transaction_id = txid_current() AND purpose = 'poster';
    INSERT INTO public.invoice_delivery_recovery_capabilities (
      transaction_id, purpose, delivery_id, actor_id
    ) VALUES (txid_current(), 'poster', v_inv.delivery_id, auth.uid());
  END IF;

  BEGIN
    SET LOCAL app.admin_override = 'true';
    UPDATE invoices SET status = 'posted', posted_by = auth.uid(), posted_at = now(), updated_at = now(),
      due_date = COALESCE(due_date, (v_inv.invoice_date + (v_terms_days || ' days')::interval)::date)
      WHERE id = p_invoice_id;
  EXCEPTION WHEN OTHERS THEN
    IF v_order_status = 'cancelled' THEN
      DELETE FROM public.invoice_delivery_recovery_capabilities
       WHERE transaction_id = txid_current() AND purpose = 'poster';
    END IF;
    RAISE;
  END;

  IF v_order_status = 'cancelled' THEN
    DELETE FROM public.invoice_delivery_recovery_capabilities
     WHERE transaction_id = txid_current() AND purpose = 'poster';
  END IF;
  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, old_values, new_values, total_impact_cents, description)
  VALUES ('invoice_posted', 'invoice', p_invoice_id, (SELECT role FROM profiles WHERE id = auth.uid()), jsonb_build_object('status', v_inv.status), jsonb_build_object('status', 'posted', 'posted_at', now()::text), v_inv.total_amount_cents, 'Posted ' || v_inv.invoice_number || ' for $' || (v_inv.total_amount_cents / 100.0)::numeric(12,2));
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_posted', 'Posted invoice ' || v_inv.invoice_number || ' — $' || (v_inv.total_amount_cents / 100.0)::numeric(12,2), auth.uid(), 'invoice', p_invoice_id, v_inv.customer_id);
  PERFORM generate_rup_sales_records(p_invoice_id);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'post_invoice', jsonb_build_object('success', true, 'invoice_id', p_invoice_id));
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public._post_invoice_impl_20260714(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._post_invoice_impl_20260714(uuid, text)
  TO service_role;

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

    -- cancel_order intentionally leaves posted/paid/overdue invoices for manual
    -- review, and create_invoice_from_order can also create a late draft after
    -- cancellation. Any nonterminal invoice would give the cancelled and
    -- replacement orders parallel financial lineages, so fail closed.
    IF EXISTS (
      SELECT 1
        FROM orders o
        JOIN invoices i ON i.order_id = o.id
       WHERE o.quote_id = p_quote_id
         AND i.deleted_at IS NULL
         AND i.status NOT IN ('voided', 'cancelled')
    ) THEN
      RAISE EXCEPTION 'QUOTE_REOPEN_ACTIVE_INVOICE: quote % has a nonterminal invoice on a cancelled order', v_quote.quote_number;
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
  v_invoice_creator_source text;
  v_invoice_guard_source text;
  v_delivery_wrapper_source text;
  v_delivery_item_guard_source text;
  v_post_invoice_source text;
  v_restore_source text;
  v_payment_source text;
BEGIN
  IF NOT EXISTS (
       SELECT 1
         FROM pg_class c
        WHERE c.oid = 'public.invoice_delivery_recovery_capabilities'::regclass
          AND c.relrowsecurity
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_policies p
        WHERE p.schemaname = 'public'
          AND p.tablename = 'invoice_delivery_recovery_capabilities'
          AND p.policyname = 'invoice_delivery_recovery_capabilities_deny_all'
          AND p.cmd = 'ALL'
     )
     OR has_table_privilege('anon', 'public.invoice_delivery_recovery_capabilities', 'SELECT')
     OR has_table_privilege('anon', 'public.invoice_delivery_recovery_capabilities', 'INSERT')
     OR has_table_privilege('anon', 'public.invoice_delivery_recovery_capabilities', 'UPDATE')
     OR has_table_privilege('anon', 'public.invoice_delivery_recovery_capabilities', 'DELETE')
     OR has_table_privilege('authenticated', 'public.invoice_delivery_recovery_capabilities', 'SELECT')
     OR has_table_privilege('authenticated', 'public.invoice_delivery_recovery_capabilities', 'INSERT')
     OR has_table_privilege('authenticated', 'public.invoice_delivery_recovery_capabilities', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.invoice_delivery_recovery_capabilities', 'DELETE')
     OR has_table_privilege('service_role', 'public.invoice_delivery_recovery_capabilities', 'SELECT')
     OR has_table_privilege('service_role', 'public.invoice_delivery_recovery_capabilities', 'INSERT')
     OR has_table_privilege('service_role', 'public.invoice_delivery_recovery_capabilities', 'UPDATE')
     OR has_table_privilege('service_role', 'public.invoice_delivery_recovery_capabilities', 'DELETE') THEN
    RAISE EXCEPTION 'DELIVERY_RECOVERY_CAPABILITY_POSTFLIGHT_FAILED: RLS, deny policy, or private grants missing';
  END IF;

  SELECT prosrc INTO v_void_source
  FROM pg_proc
  WHERE oid = 'public.void_invoice(uuid, text, text)'::regprocedure;

  IF v_void_source IS NULL
     OR v_void_source NOT LIKE '%aset.entity_type = ''payment''%'
     OR v_void_source NOT LIKE '%aset.is_active = true%'
     OR v_void_source NOT LIKE '%aset.entity_type <> ''payment''%' THEN
    RAISE EXCEPTION 'VOID_INVOICE_POSTFLIGHT_FAILED: active-payment guard or history preservation missing';
  END IF;

  SELECT prosrc INTO v_review_source
  FROM pg_proc
  WHERE oid = 'public.get_customer_transaction_review(uuid, date, date)'::regprocedure;

  IF v_review_source IS NULL
     OR v_review_source NOT LIKE '%als.entity_type = ''payment''%'
     OR v_review_source NOT LIKE '%als.is_active = true%' THEN
    RAISE EXCEPTION 'TRANSACTION_REVIEW_POSTFLIGHT_FAILED: active-payment filter missing';
  END IF;

  SELECT prosrc INTO v_quote_source
  FROM pg_proc
  WHERE oid = 'public.revert_quote_status(uuid, text, uuid, text)'::regprocedure;

  IF v_quote_source IS NULL
     OR v_quote_source NOT LIKE '%check_idempotency(p_idempotency_key, ''revert_quote_status'')%'
     OR v_quote_source NOT LIKE '%IDEMPOTENCY_ARGUMENT_MISMATCH%'
     OR v_quote_source NOT LIKE '%QUOTE_REOPEN_DELIVERED_ACTIVITY%'
     OR v_quote_source NOT LIKE '%QUOTE_REOPEN_ACTIVE_INVOICE%'
     OR v_quote_source NOT LIKE '%QUOTE_REOPEN_PAID_COMMISSION%'
     OR v_quote_source NOT LIKE '%jsonb_build_object(''request'', v_request, ''response'', v_result)%' THEN
    RAISE EXCEPTION 'REVERT_QUOTE_POSTFLIGHT_FAILED: lifecycle guard or bound shared-idempotency contract missing';
  END IF;

  SELECT prosrc INTO v_invoice_creator_source
  FROM pg_proc
  WHERE oid = 'public.create_invoice_from_order(uuid, uuid, text, text)'::regprocedure;

  IF v_invoice_creator_source IS NULL
     OR v_invoice_creator_source NOT LIKE '%v_order.status IN (''cancelled'', ''voided'')%'
     OR v_invoice_creator_source NOT LIKE '%ORDER_INVOICE_TERMINAL:%' THEN
    RAISE EXCEPTION 'CREATE_ORDER_INVOICE_POSTFLIGHT_FAILED: terminal-order guard missing';
  END IF;

  SELECT p.prosrc INTO v_invoice_guard_source
  FROM pg_trigger t
  JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE t.tgrelid = 'public.invoices'::regclass
    AND t.tgname = 'trg_guard_invoice_terminal_order'
    AND NOT t.tgisinternal
    AND t.tgenabled <> 'D';

  IF v_invoice_guard_source IS NULL
     OR v_invoice_guard_source NOT LIKE '%FOR UPDATE%'
     OR v_invoice_guard_source NOT LIKE '%ORDER_INVOICE_TERMINAL:%'
     OR v_invoice_guard_source NOT LIKE '%INVOICE_SOURCE_LINEAGE_IMMUTABLE:%'
     OR v_invoice_guard_source NOT LIKE '%INVOICE_DELIVERY_ORDER_REQUIRED:%'
     OR v_invoice_guard_source NOT LIKE '%INVOICE_DELIVERY_LINEAGE_INVALID:%'
     OR v_invoice_guard_source NOT LIKE '%TG_OP = ''UPDATE''%'
     OR v_invoice_guard_source NOT LIKE '%NEW.order_id IS DISTINCT FROM OLD.order_id%'
     OR v_invoice_guard_source NOT LIKE '%NEW.delivery_id IS DISTINCT FROM OLD.delivery_id%'
     OR v_invoice_guard_source NOT LIKE '%v_order_status IN (''cancelled'', ''voided'')%'
     OR v_invoice_guard_source NOT LIKE '%v_valid_completed_delivery%'
     OR v_invoice_guard_source NOT LIKE '%v_valid_delivery_lineage%'
     OR v_invoice_guard_source NOT LIKE '%auth.uid() IS NULL%'
     OR v_invoice_guard_source NOT LIKE '%d.status = ''completed''%'
     OR v_invoice_guard_source NOT LIKE '%invoice_delivery_recovery_capabilities%'
     OR v_invoice_guard_source NOT LIKE '%purpose = ''writer''%'
     OR v_invoice_guard_source NOT LIKE '%purpose = ''poster''%'
     OR v_invoice_guard_source NOT LIKE '%CANCELLED_DELIVERY_INVOICE_WRITER_REQUIRED:%'
     OR v_invoice_guard_source NOT LIKE '%CANCELLED_DELIVERY_INVOICE_HEADER_IMMUTABLE:%'
     OR v_invoice_guard_source NOT LIKE '%TERMINAL_ORDER_INVOICE_PRINCIPAL_IMMUTABLE:%'
     OR NOT EXISTS (
       SELECT 1 FROM pg_trigger t
        WHERE t.tgrelid = 'public.invoices'::regclass
          AND t.tgname = 'trg_guard_invoice_terminal_order'
          AND NOT t.tgisinternal
          AND t.tgenabled <> 'D'
          AND t.tgtype = 23
     ) THEN
    RAISE EXCEPTION 'INVOICE_TERMINAL_ORDER_TRIGGER_POSTFLIGHT_FAILED: serialized central guard missing';
  END IF;

  SELECT prosrc INTO v_delivery_wrapper_source
  FROM pg_proc
  WHERE oid = 'public.create_invoice_for_unbilled_delivery(uuid, uuid, text)'::regprocedure;

  IF v_delivery_wrapper_source IS NULL
     OR v_delivery_wrapper_source NOT LIKE '%invoice_delivery_recovery_capabilities%'
     OR v_delivery_wrapper_source NOT LIKE '%purpose = ''writer''%'
     OR v_delivery_wrapper_source NOT LIKE '%_create_invoice_for_unbilled_delivery_impl_20260718%'
     OR has_function_privilege('anon', 'public.create_invoice_for_unbilled_delivery(uuid, uuid, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.create_invoice_for_unbilled_delivery(uuid, uuid, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._create_invoice_for_unbilled_delivery_impl_20260718(uuid, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'DELIVERY_RECOVERY_WRAPPER_POSTFLIGHT_FAILED: capability wrapper or grants missing';
  END IF;

  SELECT p.prosrc INTO v_delivery_item_guard_source
  FROM pg_trigger t
  JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE t.tgrelid = 'public.invoice_items'::regclass
    AND t.tgname = 'trg_guard_cancelled_delivery_invoice_items'
    AND NOT t.tgisinternal
    AND t.tgenabled <> 'D';

  IF v_delivery_item_guard_source IS NULL
     OR v_delivery_item_guard_source NOT LIKE '%invoice_delivery_recovery_capabilities%'
     OR v_delivery_item_guard_source NOT LIKE '%purpose = ''writer''%'
     OR v_delivery_item_guard_source NOT LIKE '%OLD.invoice_id%'
     OR v_delivery_item_guard_source NOT LIKE '%NEW.invoice_id%'
     OR v_delivery_item_guard_source NOT LIKE '%auth.uid() IS NULL%'
     OR v_delivery_item_guard_source NOT LIKE '%CANCELLED_DELIVERY_INVOICE_ITEMS_IMMUTABLE:%'
     OR NOT EXISTS (
       SELECT 1 FROM pg_trigger t
        WHERE t.tgrelid = 'public.invoice_items'::regclass
          AND t.tgname = 'trg_guard_cancelled_delivery_invoice_items'
          AND NOT t.tgisinternal
          AND t.tgenabled <> 'D'
          AND t.tgtype = 31
     ) THEN
    RAISE EXCEPTION 'DELIVERY_RECOVERY_ITEM_GUARD_POSTFLIGHT_FAILED: item capability guard missing';
  END IF;

  SELECT prosrc INTO v_post_invoice_source
  FROM pg_proc
  WHERE oid = 'public._post_invoice_impl_20260714(uuid, text)'::regprocedure;

  IF v_post_invoice_source IS NULL
     OR v_post_invoice_source NOT LIKE '%CANCELLED_ORDER_DELIVERY_BILLING_ONLY:%'
     OR v_post_invoice_source NOT LIKE '%ORDER_INVOICE_TERMINAL:%'
     OR v_post_invoice_source NOT LIKE '%invoice_delivery_recovery_capabilities%'
     OR v_post_invoice_source NOT LIKE '%purpose = ''poster''%'
     OR v_post_invoice_source NOT LIKE '%d.status = ''completed''%'
     OR v_post_invoice_source NOT LIKE '%d.order_id = v_inv.order_id%'
     OR v_post_invoice_source NOT LIKE '%d.customer_id = v_inv.customer_id%'
     OR v_post_invoice_source NOT LIKE '%DELIVERY_INVOICE_CONTENT_MISMATCH:%'
     OR v_post_invoice_source LIKE '%orders WHERE id = v_inv.order_id FOR UPDATE%' THEN
    RAISE EXCEPTION 'POST_INVOICE_DELIVERY_EXCEPTION_POSTFLIGHT_FAILED: safe completed-delivery posting contract missing';
  END IF;

  SELECT prosrc INTO v_restore_source
  FROM pg_proc
  WHERE oid = 'public.restore_cancelled_order(uuid, text, uuid, text)'::regprocedure;

  IF v_restore_source IS NULL OR v_restore_source NOT LIKE '%RESTORE_CANCELLED_ORDER_RETIRED:%' THEN
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

  IF v_payment_source IS NULL OR v_payment_source NOT LIKE '%RECORD_INVOICE_PAYMENT_RETIRED: use allocate_payment%' THEN
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
