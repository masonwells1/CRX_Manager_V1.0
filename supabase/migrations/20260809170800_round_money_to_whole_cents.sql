-- REISSUED 2026-08-09 with a forward timestamp.
--
-- Originally written as 20260808150400_round_money_to_whole_cents.sql, which
-- was merged to main but never applied. Live ledger row 20260809130108
-- (team_note_completion_rpc_and_assignment_notify) landed afterwards, putting
-- every 20260808* file BELOW the applied high-water mark, where
-- .claude/hooks/migration-ordering-lib.mjs correctly refuses it: an older
-- migration applied after a newer one is exactly the 2026-07-15 reversion that
-- guard exists to stop.
--
-- The executable SQL below is UNCHANGED from the reviewed original -- only the
-- filename timestamp and this header differ. The stale 20260808* file is deleted
-- in the same commit so a clean rebuild cannot apply the change twice (the same
-- remedy as docs/reference/migration-history.md row 808 -> live row 811).

-- Establish a single canonical rounding point for order_items.total_price and
-- commissions.commission_amount: whole cents, two decimal places.
--
-- Owner decision (Mason, 2026-08-08, docs/manual/DECISION_LOG.md): "2 decimals,
-- that should be .20" — the pending $5,245.195 commission resolves to
-- $5,245.20. That is ROUND(x, 2), which in PostgreSQL for numeric is half-up
-- away from zero, matching the decision exactly.
--
-- WHY A TRIGGER RATHER THAN EDITING THE WRITERS
-- Live inspection found 9 functions assigning total_price and 11 assigning
-- commission_amount — 20 rewrite targets, several inside 12KB lifecycle
-- functions, and that still would not cover direct writes from the frontend or
-- from a future function. A BEFORE INSERT OR UPDATE trigger is genuinely the
-- canonical point: one place, unconditionally applied to every writer, and it
-- cannot be bypassed by adding a new caller. Rewriting 20 functions would be a
-- far larger diff with a worse guarantee.
--
-- These columns are `numeric` dollars — the documented historical exception to
-- the money-is-bigint-cents rule (alongside payments.amount and
-- commission_payment_items.amount). This migration does NOT convert them to
-- cents; it only guarantees the values they hold are whole cents. Note that
-- purchase_orders.total_cost_cents is already GENERATED ... round(total_cost *
-- 100), so AP rounds at the same precision; this makes the sell side agree.
--
-- SCOPE — READ THIS BEFORE APPLYING
-- This migration is FORWARD-LOOKING ONLY. It rounds values as they are written
-- from now on. It deliberately does NOT touch the 46 existing
-- order_items.total_price rows or the 3 existing commissions.commission_amount
-- rows that already carry fractional cents — including the $5,245.195 pending
-- payout.
--
-- Correcting those 49 rows changes live financial data, which is a separate
-- act needing its own explicit approval. It is intentionally not bundled here
-- so that applying this migration cannot silently restate a pending payout.
-- The repair statement is recorded at the bottom of this file, commented out.
--
-- No CHECK constraint is added: a CHECK would immediately reject the 49
-- pre-existing rows and could block unrelated updates to them. The whole-cents
-- assertion belongs in the invariant sweeps instead, where a violation is
-- reported rather than fatal.
--
-- Forward-only.

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
  ELSIF TG_TABLE_NAME = 'commissions' THEN
    IF NEW.commission_amount IS NOT NULL THEN
      NEW.commission_amount := ROUND(NEW.commission_amount, 2);
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public._round_money_to_whole_cents() IS
  'Canonical rounding point for the numeric-dollar money columns: rounds to '
  'whole cents (2dp, half-up) on every write. Added 2026-08-08 per Mason''s '
  'decision; see the 2026-08-08 foundation ultra review §3 M3.';

DROP TRIGGER IF EXISTS trg_order_items_round_money ON public.order_items;
CREATE TRIGGER trg_order_items_round_money
  BEFORE INSERT OR UPDATE OF total_price ON public.order_items
  FOR EACH ROW
  EXECUTE FUNCTION public._round_money_to_whole_cents();

DROP TRIGGER IF EXISTS trg_commissions_round_money ON public.commissions;
CREATE TRIGGER trg_commissions_round_money
  BEFORE INSERT OR UPDATE OF commission_amount ON public.commissions
  FOR EACH ROW
  EXECUTE FUNCTION public._round_money_to_whole_cents();

-- ---------------------------------------------------------------------------
-- DELIBERATELY NOT EXECUTED — repair of the 49 pre-existing fractional rows.
-- Requires Mason's separate explicit approval because it restates live money,
-- including a pending commission payout. Run only when that approval is given.
--
--   UPDATE public.order_items
--      SET total_price = ROUND(total_price, 2)
--    WHERE total_price IS DISTINCT FROM ROUND(total_price, 2);
--
--   UPDATE public.commissions
--      SET commission_amount = ROUND(commission_amount, 2)
--    WHERE commission_amount IS DISTINCT FROM ROUND(commission_amount, 2);
-- ---------------------------------------------------------------------------
