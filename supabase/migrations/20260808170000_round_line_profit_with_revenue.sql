-- Round order_items.profit to whole cents alongside total_price.
--
-- Follow-up to 20260808150400, which established the canonical rounding point
-- but rounded REVENUE only. Codex P2 on PR #348 caught the gap:
--
--   Two lines with raw totals of 10.005 and costs of 5 round to $10.01 each,
--   giving $20.02 of revenue and $10.02 of header profit — while the stored
--   line profits still hold 5.005 each and sum to 10.010, which
--   get_sales_detail_report renders as $10.01. A one-cent disagreement between
--   the header and the sum of its own lines, generated silently.
--
-- Forward-only, and written as a NEW migration rather than an edit to
-- 20260808150400: that file is already merged to main, and the project rule is
-- that database changes arrive as new files.
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
-- Like 20260808150400 this is FORWARD-LOOKING ONLY. It does not repair existing
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
    -- Money, so it rounds with revenue. Keeps SUM(line profit) in agreement
    -- with the rounded header profit instead of drifting a cent per line.
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

-- The trigger on order_items must now also fire when only `profit` changes;
-- 20260808150400 scoped it to UPDATE OF total_price.
DROP TRIGGER IF EXISTS trg_order_items_round_money ON public.order_items;
CREATE TRIGGER trg_order_items_round_money
  BEFORE INSERT OR UPDATE OF total_price, profit ON public.order_items
  FOR EACH ROW
  EXECUTE FUNCTION public._round_money_to_whole_cents();
