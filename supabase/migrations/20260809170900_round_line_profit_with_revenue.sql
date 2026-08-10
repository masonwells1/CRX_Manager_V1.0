-- REISSUED 2026-08-09 with a forward timestamp.
--
-- Originally written as 20260808170000_round_line_profit_with_revenue.sql, added
-- on this branch in 76a6bee4 and never applied. Unlike the other four re-issued
-- files, that original was never merged to main -- it exists only in the PR #354
-- history, so an exact-base review sees this migration as entirely new.
-- Live ledger row 20260809130108
-- (team_note_completion_rpc_and_assignment_notify) landed afterwards, putting
-- every 20260808* file BELOW the applied high-water mark, where
-- .claude/hooks/migration-ordering-lib.mjs correctly refuses it: an older
-- migration applied after a newer one is exactly the 2026-07-15 reversion that
-- guard exists to stop.
--
-- THE EXECUTABLE SQL HAS CHANGED SINCE THE RE-ISSUE. Do not skip the diff.
-- Delta vs 20260808170000 (2026-08-09, after the RLS and drift reviewers): one
-- added REVOKE statement, below, plus a rewritten inline comment. The function body
-- and the trigger are byte-identical to the reviewed original.
--
-- The stale 20260808* file is deleted in the same commit so a clean rebuild cannot
-- apply the change twice (the same remedy as docs/reference/migration-history.md
-- row 808 -> live row 811).

-- Round order_items.profit to whole cents alongside total_price.
--
-- Follow-up to 20260809170800, which established the canonical rounding point
-- but rounded REVENUE only. Codex P2 on PR #348 caught the gap:
--
--   Two lines with raw totals of 10.005 and costs of 5 round to $10.01 each,
--   giving $20.02 of revenue and $10.02 of header profit — while the stored
--   line profits still hold 5.005 each and sum to 10.010, which
--   get_sales_detail_report renders as $10.01. A one-cent disagreement between
--   the header and the sum of its own lines, generated silently.
--
-- Forward-only, and written as a NEW migration rather than an edit to
-- 20260809170800, because the project rule is that database changes arrive as new
-- files. (The original wording said 170800 "is already merged to main". That is
-- false for the re-issued filename -- git ls-tree origin/main shows 20260808150100
-- through 150400 and no 2026080917* file at all. What was merged is 170800's
-- predecessor, 20260808150400.)
--
-- WHY profit AND NOT net_margin
--   profit is money and must be whole cents. net_margin is a PERCENTAGE, not
--   money — the existing lifecycle functions already ROUND it to 2 decimal
--   places for display, and forcing it through a money rule would be a category
--   error. It is deliberately left alone.
--
-- Ordering of operations matters: total_price and profit are rounded
-- independently from their own raw values. profit is NOT re-derived from the
-- rounded total_price, because profit is (price - cost) x quantity, not a
-- function of revenue — deriving it from rounded revenue would silently change
-- margin figures rather than just their precision.
--
-- KNOWN RESIDUAL — header vs. sum-of-lines is NARROWED, NOT CLOSED (Codex P2, PR #354)
--   trg_recalc_order_totals does not read order_items.profit. It recomputes the
--   header as ROUND(SUM(total_price) - SUM(cost_per_unit * total_units_needed), 2),
--   and that COST side is never rounded per line. So with fractional-cent unit
--   costs the header can still differ by a cent from SUM(order_items.profit) —
--   e.g. qty 1, price 10.005, cost 5.004 stores profit 5.00 while the header
--   computes 5.01.
--   Closing it means changing where the HEADER derives from (summing the rounded
--   line profits, or allocating the rounding residual across lines). That moves
--   live money on the order header, so it is Mason's call and is deliberately NOT
--   bundled here. This migration's claim is narrower than "drift eliminated": it
--   stops the stored line profit from carrying sub-cent precision at all.
--
-- Like 20260809170800 this is FORWARD-LOOKING ONLY. It does not repair existing
-- fractional rows; that restates live money and needs its own approval. The
-- fin-money-whole-cents invariant predicate should be extended to cover profit
-- once the repair is authorised.

CREATE OR REPLACE FUNCTION public._round_money_to_whole_cents()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF TG_TABLE_NAME = 'order_items' THEN
    IF NEW.total_price IS NOT NULL THEN
      NEW.total_price := ROUND(NEW.total_price, 2);
    END IF;
    -- Money, so round stored line profit to whole cents. This removes sub-cent
    -- precision from the stored value; it does NOT make SUM(line profit) equal
    -- the header profit, which derives from unrounded costs. See the residual
    -- note in the header of this file.
    IF NEW.profit IS NOT NULL THEN
      NEW.profit := ROUND(NEW.profit, 2);
    END IF;
  ELSIF TG_TABLE_NAME = 'commissions' THEN
    IF NEW.commission_amount IS NOT NULL THEN
      NEW.commission_amount := ROUND(NEW.commission_amount, 2);
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public._round_money_to_whole_cents() IS
  'Canonical rounding point for the numeric-dollar money columns: rounds '
  'order_items.total_price, order_items.profit, and commissions.commission_amount '
  'to whole cents (2dp, half-up) on every write. net_margin is a percentage and '
  'is deliberately excluded. Added 2026-08-08 per Mason''s decision; profit added '
  'the same day after Codex caught header-vs-line drift on PR #348.';

-- Re-asserted defensively. CREATE OR REPLACE preserves the ACL 20260809170800 set,
-- so on the normal path this is a genuine no-op. It is here so that the REVOKE can
-- never be separated from the CREATE by a future edit to either file.
--
-- It is deliberately NOT justified as "makes this file standalone-correct". It does
-- not: applied against a database that never ran 170800, this file would create the
-- function and the order_items trigger but NOT trg_commissions_round_money, so
-- commissions.commission_amount would silently go unrounded. 170900 is a follow-up
-- to 170800, not a replacement for it -- apply them in order. (Flagged by both
-- reviewers, 2026-08-09.)
REVOKE ALL ON FUNCTION public._round_money_to_whole_cents() FROM PUBLIC, anon, authenticated, service_role;

-- The trigger on order_items must now also fire when only `profit` changes;
-- 20260809170800 scoped it to UPDATE OF total_price.
--
-- NARROWS THE "FORWARD-LOOKING ONLY" PROMISE, deliberately (drift reviewer M4,
-- 2026-08-09). Widening the column scope means an UPDATE that touches only
-- `profit` now also fires the trigger, and the trigger rounds total_price too --
-- so on a historical row carrying a fractional total_price, an unrelated profit
-- write will now silently repair that total_price as a side effect. That is one
-- of the 46 rows the repair statement in 20260809170800 is deliberately holding
-- back. The rounding is the value Mason already decided on, so a row repaired
-- this way lands on the correct number; what is lost is the guarantee that ALL
-- 46 are repaired together in one authorised, auditable act. Accepted because
-- the alternative -- two separate triggers with disjoint column scopes -- adds a
-- second rounding point, which is the exact thing 170800 was written to remove.
--
-- commissions is NOT affected: trg_commissions_round_money is untouched below and
-- stays scoped to UPDATE OF commission_amount, so an ordinary status='paid' write
-- does not fire it and will NOT restate the pending $5,245.195 payout.
DROP TRIGGER IF EXISTS trg_order_items_round_money ON public.order_items;
CREATE TRIGGER trg_order_items_round_money
  BEFORE INSERT OR UPDATE OF total_price, profit ON public.order_items
  FOR EACH ROW
  EXECUTE FUNCTION public._round_money_to_whole_cents();
