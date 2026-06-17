-- Fix (MEDIUM): order_shares has a per-ROW CHECK (split_percentage 0..100) and a posted-lock
-- trigger, but NO constraint capping SUM(split_percentage) per order at 100. Bill-share writes go
-- through a direct supabase.from('order_shares').insert (no RPC; RLS = is_admin() OR is_sales_rep()),
-- so two racing "Add Share" clicks or a direct PostgREST write can push an order's bill-split over
-- 100%, mis-stating each party's share and amount_cents.
--
-- Fix (ADDITIVE): a BEFORE INSERT/UPDATE trigger summing split_percentage across the order
-- (other rows + NEW), raising ORDER_SHARES_OVER_100 if it would exceed 100 (1% tolerance for the
-- numeric rounding the per-row CHECK already allows). SECURITY DEFINER + a FOR UPDATE lock on the
-- parent order (Codex cross-review P2): DEFINER lets the aggregate see ALL shares regardless of the
-- caller's RLS (a sales_rep's row-visibility could otherwise under-count), and the per-order lock
-- serializes concurrent inserts so two racing writes can't each read a pre-commit total and both pass.
-- Source: nightly-debug (PARKED-04). Live census: 0 order_shares rows, 0 orders over 100%, only the
-- existing posted-lock trigger. Validated: fn+trigger compile against live rolled back.
-- Rollback: DROP TRIGGER trg_validate_order_shares_total ON order_shares; DROP FUNCTION _validate_order_shares_total();

CREATE OR REPLACE FUNCTION public._validate_order_shares_total()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_total numeric;
BEGIN
  -- Serialize concurrent share writes for this order (race fix): lock the parent order row.
  PERFORM 1 FROM orders WHERE id = NEW.order_id FOR UPDATE;
  -- SECURITY DEFINER so the aggregate sees ALL shares for the order, RLS-independent.
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
