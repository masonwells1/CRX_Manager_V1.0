-- Reconcile the pending order-commission snapshots left stale by the applied
-- 20260810025159_backfill_stale_line_profit migration.
--
-- That backfill correctly re-derived stale order-item profit and caused
-- trg_recalc_order_totals to refresh the related order headers. It used direct
-- DML, however, so it did not execute update_order_items' separate commission
-- rescale step. A small exact set of still-pending, unbatched order commissions
-- therefore retains the pre-backfill order_profit snapshot and, where rounding
-- crosses a cent, the old commission_amount.
--
-- SCOPE. This migration deliberately matches the update_order_items business
-- rule: order-channel rows only; pending and not soft-deleted; and not frozen in
-- a non-voided commission-payment batch. Job/application commissions are
-- excluded because their intentional basis is chemical-line profit rather than
-- orders.total_profit. Paid, cancelled, deleted, and payment-batched rows are
-- immutable history and remain untouched.
--
-- APPROVED-SET BINDING. The target count, order count, mismatch counts, and a
-- SHA-256 fingerprint of every target identity plus its old/new money values
-- bind this write to the exact live set measured on 2026-08-10. If any target
-- changes before apply, the migration aborts before writing.
--
-- CONCURRENCY. Order headers are locked first, matching update_order_items, and
-- then commission rows are locked in UUID order. create_commission_payment also
-- locks commissions before snapshotting them. A concurrent order edit or payout
-- therefore completes before this capture or waits until after this atomic
-- repair; it cannot observe or commit a half-reconciled target.
--
-- ATOMICITY. The capture, write, and assertions share one DO statement with no
-- EXCEPTION clause. Any failure rolls the write back. The migration ledger is
-- the durable audit record; no financial_audit_log actor is forged for a
-- migration executed without an authenticated business user.

SET LOCAL lock_timeout = '10s';

DO $migration$
DECLARE
  v_commission_ids       uuid[];
  v_order_ids            uuid[];
  v_snapshot_text        text;
  v_snapshot_hash        text;
  v_target_count         integer;
  v_target_order_count   integer;
  v_stale_profit_count   integer;
  v_stale_amount_count   integer;
  v_written              integer;
  v_remaining            integer;
  v_ineligible           integer;
BEGIN
  -- Lock the order headers first, in deterministic order. The candidate scan
  -- is repeated under those locks when the commission rows are captured.
  PERFORM 1
  FROM public.orders o
  WHERE EXISTS (
    SELECT 1
    FROM public.commissions c
    WHERE c.order_id = o.id
      AND c.job_id IS NULL
      AND c.status = 'pending'
      AND c.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.commission_payment_items cpi
        JOIN public.commission_payments cp
          ON cp.id = cpi.commission_payment_id
        WHERE cpi.commission_id = c.id
          AND cp.status <> 'voided'
      )
      AND (
        c.order_profit IS DISTINCT FROM ROUND(COALESCE(o.total_profit, 0), 2)
        OR c.commission_amount IS DISTINCT FROM
           public.compute_commission_amount(o.total_profit, c.split_percentage)
      )
  )
  ORDER BY o.id
  FOR UPDATE OF o;

  -- Lock and capture the exact target once. All later writes and assertions
  -- descend from these captured ids; the mismatch predicate never widens the
  -- approved write set after this point.
  WITH locked AS (
    SELECT
      c.id,
      c.order_id,
      c.order_profit,
      ROUND(COALESCE(o.total_profit, 0), 2) AS expected_order_profit,
      c.commission_amount,
      public.compute_commission_amount(
        o.total_profit,
        c.split_percentage
      ) AS expected_commission_amount,
      c.split_percentage
    FROM public.commissions c
    JOIN public.orders o ON o.id = c.order_id
    WHERE c.order_id IS NOT NULL
      AND c.job_id IS NULL
      AND c.status = 'pending'
      AND c.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.commission_payment_items cpi
        JOIN public.commission_payments cp
          ON cp.id = cpi.commission_payment_id
        WHERE cpi.commission_id = c.id
          AND cp.status <> 'voided'
      )
      AND (
        c.order_profit IS DISTINCT FROM ROUND(COALESCE(o.total_profit, 0), 2)
        OR c.commission_amount IS DISTINCT FROM
           public.compute_commission_amount(o.total_profit, c.split_percentage)
      )
    ORDER BY c.id
    FOR UPDATE OF c
  )
  SELECT
    array_agg(id ORDER BY id),
    array_agg(DISTINCT order_id ORDER BY order_id),
    string_agg(
      concat_ws(
        '|',
        id::text,
        order_id::text,
        order_profit::text,
        expected_order_profit::text,
        commission_amount::text,
        expected_commission_amount::text,
        split_percentage::text
      ),
      E'\n' ORDER BY id
    ),
    count(*),
    count(DISTINCT order_id),
    count(*) FILTER (
      WHERE order_profit IS DISTINCT FROM expected_order_profit
    ),
    count(*) FILTER (
      WHERE commission_amount IS DISTINCT FROM expected_commission_amount
    )
  INTO
    v_commission_ids,
    v_order_ids,
    v_snapshot_text,
    v_target_count,
    v_target_order_count,
    v_stale_profit_count,
    v_stale_amount_count
  FROM locked;

  IF v_target_count = 0 THEN
    RAISE NOTICE
      'COMMISSION_SNAPSHOTS_ALREADY_RECONCILED: no eligible mismatch remains.';
    RETURN;
  END IF;

  v_snapshot_hash := encode(
    extensions.digest(v_snapshot_text, 'sha256'),
    'hex'
  );

  IF v_target_count <> 11
     OR v_target_order_count <> 10
     OR v_stale_profit_count <> 11
     OR v_stale_amount_count <> 9
     OR v_snapshot_hash <>
        'b1fc5bb0ed521ce36145d185ae62a6718d8a1bb081355d7d0f8fab007a9f8511' THEN
    RAISE EXCEPTION
      'APPROVED_COMMISSION_SET_DRIFTED: expected 11 rows / 10 orders / 11 stale profit / 9 stale amount / hash b1fc5bb0..., found % / % / % / % / %. Re-measure and obtain fresh approval.',
      v_target_count,
      v_target_order_count,
      v_stale_profit_count,
      v_stale_amount_count,
      v_snapshot_hash;
  END IF;

  IF v_commission_ids IS NULL
     OR array_length(v_commission_ids, 1) <> 11
     OR v_order_ids IS NULL
     OR array_length(v_order_ids, 1) <> 10 THEN
    RAISE EXCEPTION
      'COMMISSION_CAPTURE_INCOMPLETE: captured % commission id(s) / % order id(s); expected 11 / 10.',
      COALESCE(array_length(v_commission_ids, 1), 0),
      COALESCE(array_length(v_order_ids, 1), 0);
  END IF;

  -- Recheck the lifecycle/payment boundary under the commission row locks.
  SELECT count(*)
  INTO v_ineligible
  FROM public.commissions c
  WHERE c.id = ANY(v_commission_ids)
    AND (
      c.order_id IS NULL
      OR c.job_id IS NOT NULL
      OR c.status IS DISTINCT FROM 'pending'
      OR c.deleted_at IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM public.commission_payment_items cpi
        JOIN public.commission_payments cp
          ON cp.id = cpi.commission_payment_id
        WHERE cpi.commission_id = c.id
          AND cp.status <> 'voided'
      )
    );

  IF v_ineligible <> 0 THEN
    RAISE EXCEPTION
      'COMMISSION_TARGET_BECAME_INELIGIBLE: % captured row(s) crossed a lifecycle or payment boundary.',
      v_ineligible;
  END IF;

  UPDATE public.commissions c
  SET order_profit = ROUND(COALESCE(o.total_profit, 0), 2),
      commission_amount = public.compute_commission_amount(
        o.total_profit,
        c.split_percentage
      )
  FROM public.orders o
  WHERE c.id = ANY(v_commission_ids)
    AND o.id = c.order_id;

  GET DIAGNOSTICS v_written = ROW_COUNT;

  IF v_written <> 11 THEN
    RAISE EXCEPTION
      'COMMISSION_RECONCILE_ROWCOUNT: wrote % row(s); expected exactly 11.',
      v_written;
  END IF;

  SELECT count(*)
  INTO v_remaining
  FROM public.commissions c
  JOIN public.orders o ON o.id = c.order_id
  WHERE c.id = ANY(v_commission_ids)
    AND (
      c.order_profit IS DISTINCT FROM ROUND(COALESCE(o.total_profit, 0), 2)
      OR c.commission_amount IS DISTINCT FROM
         public.compute_commission_amount(o.total_profit, c.split_percentage)
    );

  IF v_remaining <> 0 THEN
    RAISE EXCEPTION
      'COMMISSION_RECONCILE_INCOMPLETE: % captured row(s) still disagree with the canonical order snapshot.',
      v_remaining;
  END IF;

  RAISE NOTICE
    'COMMISSION_SNAPSHOTS_RECONCILED: % pending row(s) across % order(s).',
    v_written,
    v_target_order_count;
END
$migration$;
