-- Backfill: re-derive the stale order_items.profit values through the canonical rule.
--
-- The canonical rule is live (verified against pg_proc, not against a filename:
-- the migration that introduced it landed under a different version stamp than
-- the one its source file carries). The BEFORE trigger _round_money_to_whole_cents
-- discards whatever a caller passes in NEW.profit and computes
--
--   profit := ROUND(total_price, 2)
--             - ROUND(COALESCE(cost_per_unit, 0) * COALESCE(total_units_needed, 0), 2)
--
-- and trg_recalc_order_totals sums those same two rounded quantities into the
-- order header, so a correct header equals SUM(order_items.profit) exactly.
-- That fixed every write from that point on but did not touch rows written
-- before it existed. A set of older rows still carries a profit that matches
-- neither its own price and cost nor its order header.
--
-- Sales Reports read the line copy, so they currently understate profit. This
-- is a reporting correction, not a change to any amount owed: the header fields
-- this touches are total_price, total_cost, total_profit and total_margin_pct,
-- while accounts receivable is carried on invoices.balance_cents, which no
-- trigger in this path writes. (Figures are deliberately omitted -- this
-- repository is public; they live in the access-controlled session record.)
--
-- The UPDATE deliberately sets total_price to itself rather than computing a
-- new profit here. Re-deriving the value in this file would fork the rule: the
-- trigger stays the single definition of what a line profit is, and this
-- migration only makes the stale rows pass back through it.
--
-- Disclosed side effects, all measured before writing:
--   * Some of the stale rows carry a price with a sub-cent fraction. The same
--     trigger rounds total_price to whole cents, so those rows also move by up
--     to half a cent each. Mason approved that side effect explicitly on
--     2026-08-09 after being shown the per-row figures.
--   * Eleven order headers are restated by trg_recalc_order_totals, each moving
--     DOWNWARD by up to one cent. An earlier draft of this file claimed the
--     headers were already exact; that was wrong, and the claim is corrected
--     here because it is the sentence the approval was given against.
--   * Pending commission rows on some of these orders keep a snapshot derived
--     from the pre-backfill header. The rescale lives inside the
--     update_order_items RPC, not in a trigger, so a direct UPDATE does not
--     reach it. The drift is a fraction of a cent per row and is left alone
--     deliberately rather than triggering an unapproved commission rewrite.
--
-- Out of scope, deliberately untouched: the other sub-cent-price rows whose
-- profit is already correct, the separately parked pending-payout row, and one
-- fulfilled order whose header sits one cent above its own (already correct)
-- lines. That last one is the mirror of this bug -- a stale header rather than
-- stale lines -- and is reported separately rather than widened into this fix.
--
-- CONCURRENCY. Every statement in a PL/pgSQL block takes its own snapshot under
-- READ COMMITTED, so counting rows in one statement and re-evaluating the same
-- predicate in the UPDATE would let a concurrently-edited order join the write
-- after the count had already passed. Instead the affected rows are locked and
-- captured ONCE, and the UPDATE, the row-count check and both assertions are
-- all driven off those captured id arrays. The orders are locked before their
-- lines, matching the lock order update_order_items takes, so the two cannot
-- deadlock against each other.
--
-- ATOMICITY. Everything runs inside one DO block, which makes it a single
-- statement: if any assertion raises, the UPDATE cannot have committed,
-- regardless of whether the apply channel wraps statements in a transaction.
-- This holds ONLY because the block has no EXCEPTION clause -- adding one would
-- open a subtransaction and silently break the guarantee. Do not add one.
--
-- ENVIRONMENT-SPECIFIC BY DESIGN. The expected counts below are hard-coded to
-- bind this migration to the exact set Mason approved. Running it against a
-- clone, a staging copy or a restored backup will abort with
-- APPROVED_SET_DRIFTED. That is the intended behaviour, not a bug.
--
-- Idempotent: on a second run the capture finds zero stale rows and the
-- migration exits without writing.

DO $$
DECLARE
  v_item_ids   uuid[];
  v_order_ids  uuid[];
  v_rows       integer;
  v_orders     integer;
  v_fractional integer;
  v_written    integer;
  v_checked    integer;
  v_remaining  integer;
  v_mismatched integer;
BEGIN
  -- Lock the affected order headers FIRST, in the same order update_order_items
  -- takes them, so a concurrent line edit blocks here instead of deadlocking.
  PERFORM 1
  FROM public.orders
  WHERE id IN (
    SELECT DISTINCT order_id
    FROM public.order_items
    WHERE total_price IS NOT NULL
      AND profit IS DISTINCT FROM (
        ROUND(total_price, 2)
        - ROUND(COALESCE(cost_per_unit, 0) * COALESCE(total_units_needed, 0), 2)
      )
  )
  ORDER BY id
  FOR UPDATE;

  -- Now lock and capture the lines themselves. This single statement is the
  -- ONLY evaluation of the staleness predicate that drives a write: the counts,
  -- the UPDATE and both assertions all descend from these arrays.
  WITH locked AS (
    SELECT id, order_id, total_price
    FROM public.order_items
    WHERE total_price IS NOT NULL
      AND profit IS DISTINCT FROM (
        ROUND(total_price, 2)
        - ROUND(COALESCE(cost_per_unit, 0) * COALESCE(total_units_needed, 0), 2)
      )
    ORDER BY order_id, id
    FOR UPDATE
  )
  SELECT array_agg(id),
         array_agg(DISTINCT order_id),
         count(*),
         count(DISTINCT order_id),
         count(*) FILTER (WHERE total_price <> ROUND(total_price, 2))
    INTO v_item_ids, v_order_ids, v_rows, v_orders, v_fractional
  FROM locked;

  IF v_rows = 0 THEN
    RAISE NOTICE 'BACKFILL_ALREADY_APPLIED: no stale rows remain; nothing to do.';
    RETURN;
  END IF;

  -- The exact set Mason approved on 2026-08-09. Binding to it fail-closed means
  -- an order edited between approval and apply cannot silently ride along.
  IF v_rows <> 37 OR v_orders <> 17 OR v_fractional <> 11 THEN
    RAISE EXCEPTION
      'APPROVED_SET_DRIFTED: expected 37 rows / 17 orders / 11 fractional-price, found % / % / %. Re-measure and get fresh approval before applying.',
      v_rows, v_orders, v_fractional;
  END IF;

  -- array_agg returns NULL over zero rows, which would make every ANY() below
  -- match nothing and let the assertions pass vacuously. Put a floor under it.
  IF v_item_ids IS NULL OR array_length(v_item_ids, 1) <> 37
     OR v_order_ids IS NULL OR array_length(v_order_ids, 1) <> 17 THEN
    RAISE EXCEPTION
      'CAPTURE_INCOMPLETE: captured % line id(s) and % order id(s); expected 37 and 17.',
      COALESCE(array_length(v_item_ids, 1), 0), COALESCE(array_length(v_order_ids, 1), 0);
  END IF;

  -- Drive the write off the captured ids, never off a re-evaluated predicate.
  UPDATE public.order_items
  SET total_price = total_price
  WHERE id = ANY(v_item_ids);

  GET DIAGNOSTICS v_written = ROW_COUNT;
  IF v_written <> 37 THEN
    RAISE EXCEPTION
      'UNEXPECTED_ROW_COUNT: UPDATE wrote % row(s); expected exactly 37.', v_written;
  END IF;

  -- Fail closed: every row this migration wrote must now satisfy the canonical
  -- rule. Scoped to the captured ids so a row that went stale elsewhere during
  -- the apply cannot roll back a backfill that in fact succeeded.
  SELECT count(*) INTO v_remaining
  FROM public.order_items
  WHERE id = ANY(v_item_ids)
    AND profit IS DISTINCT FROM (
      ROUND(total_price, 2)
      - ROUND(COALESCE(cost_per_unit, 0) * COALESCE(total_units_needed, 0), 2)
    );

  IF v_remaining <> 0 THEN
    RAISE EXCEPTION
      'BACKFILL_INCOMPLETE: % order_items row(s) still disagree with the canonical profit rule', v_remaining;
  END IF;

  -- Fail closed: every order this migration touched must now equal the sum of
  -- its own lines. v_checked asserts COVERAGE -- counting only mismatches would
  -- pass silently if an order dropped out of the join entirely.
  SELECT count(*),
         count(*) FILTER (WHERE o.total_profit IS DISTINCT FROM li.line_profit)
    INTO v_checked, v_mismatched
  FROM public.orders o
  JOIN (
    SELECT order_id, SUM(profit) AS line_profit
    FROM public.order_items
    WHERE order_id = ANY(v_order_ids)
    GROUP BY order_id
  ) li ON li.order_id = o.id;

  IF v_checked <> 17 THEN
    RAISE EXCEPTION
      'HEADER_CHECK_INCOMPLETE: verified % order header(s); expected 17.', v_checked;
  END IF;

  IF v_mismatched <> 0 THEN
    RAISE EXCEPTION
      'HEADER_LINE_DISAGREEMENT: % repaired order(s) still disagree with their line items', v_mismatched;
  END IF;

  RAISE NOTICE 'BACKFILL_OK: % line(s) across % order(s) re-derived.', v_written, v_orders;
END
$$;
