-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ PARKED MIGRATION — NOT YET APPLIED. Awaiting Mason's approval.            ║
-- ║ Nightly Debug Mission · Cycle 4 · 2026-06-16                              ║
-- ║ Finding: money:order_shares:no-aggregate-100pct-constraint                 ║
-- ║ Severity: MEDIUM (bill-split can exceed 100%, only client JS guards it)    ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- WHAT'S WRONG (verified live, project rhyzpcqhnizqbxphqdkr):
--   order_shares has a per-ROW CHECK (split_percentage > 0 AND <= 100) and a posted-lock
--   trigger, but NO constraint/trigger capping SUM(split_percentage) per order at 100.
--   Bill-share writes go through a direct `supabase.from('order_shares').insert(...)` (no
--   RPC); the insert RLS WITH CHECK is just is_admin() OR is_sales_rep(). The 100% total is
--   enforced ONLY in React (handleAddShare, OrderDetail.tsx). Two racing "Add Share" clicks,
--   or any direct PostgREST write, can push an order's bill-split allocation over 100% —
--   mis-stating each co-op/landlord's share and their amount_cents.
--   Live census: order_shares = 0 rows, 0 orders over 100%, only trg_order_shares_lock_when_posted.
--
-- THE FIX (ADDITIVE — new trigger, no reproduction):
--   A BEFORE INSERT/UPDATE trigger that sums split_percentage across the order (other rows +
--   NEW) and raises ORDER_SHARES_OVER_100 if the total would exceed 100 (1% tolerance for the
--   numeric rounding the per-row CHECK already allows). Mirrors validate_commission_split_json.
--   SECURITY DEFINER + a FOR UPDATE lock on the parent order (Codex cross-review P2): the DEFINER
--   context makes the aggregate see ALL of the order's shares regardless of the caller's RLS (a
--   sales_rep's row-visibility could otherwise under-count and let the total exceed 100), and the
--   per-order lock serializes concurrent inserts so two racing writes can't each read a pre-commit
--   total and both pass.
--
-- VALIDATION: function + trigger compiled against the live schema inside a rolled-back
--   transaction (sentinel VALIDATION_OK). 0 existing rows violate, so no backfill conflict.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trg_validate_order_shares_total ON public.order_shares;
--   DROP FUNCTION IF EXISTS public._validate_order_shares_total();

CREATE OR REPLACE FUNCTION public._validate_order_shares_total()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_total numeric;
BEGIN
  -- Serialize concurrent share writes for this order (Codex P2 race fix): lock the parent
  -- order row so two inserts can't each read a pre-commit total and both pass.
  PERFORM 1 FROM orders WHERE id = NEW.order_id FOR UPDATE;
  -- SECURITY DEFINER (above) so the aggregate sees ALL shares for the order, RLS-independent.
  SELECT COALESCE(SUM(split_percentage), 0) INTO v_total
  FROM order_shares
  WHERE order_id = NEW.order_id
    AND id <> NEW.id;
  v_total := v_total + NEW.split_percentage;
  IF v_total > 100.01 THEN
    RAISE EXCEPTION 'ORDER_SHARES_OVER_100: order % bill-split total would be % (max 100)',
      NEW.order_id, v_total;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_validate_order_shares_total ON public.order_shares;
CREATE TRIGGER trg_validate_order_shares_total
  BEFORE INSERT OR UPDATE OF split_percentage, order_id ON public.order_shares
  FOR EACH ROW EXECUTE FUNCTION public._validate_order_shares_total();
