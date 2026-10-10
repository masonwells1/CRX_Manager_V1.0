-- STATUS: NOT APPLIED.
-- Freeze soft-deleted orders, so nothing can move stock reservations on an order that no longer
-- exists in the app.
--
-- Why: before 2026-07-21 an order could be soft-deleted while still 'confirmed' (four such orders
-- remain: ORD-2026-0181/0184/0185/0187). Their reservations are released by the one-shot data
-- migration 20261007150200. After that, the app could still release them AGAIN:
--   * cancel_order / void_order release total_units_needed - quantity_delivered per line and check
--     only the order's status, never whether it is deleted — and OrderDetail loads an order by id
--     with no deleted filter, so a deleted order opened by URL still offers "Cancel Order";
--   * update_order_items lowers quantity_prebooked when a line is reduced or removed, also with no
--     deleted check; completing a delivery would move quantity_delivered.
-- Each would take units away from live open orders' reservations.
--
-- What this file does (schema only, no data change; checked read-only 2026-10-07: 8 soft-deleted
-- orders, none with an open delivery, a booking draw or active holds; nothing in the app restores a
-- deleted order):
--   1. guard_deleted_order_status_locked (BEFORE UPDATE OF status, deleted_at ON orders): refuses any
--      status change on a soft-deleted order, and un-deleting one (clearing deleted_at would
--      otherwise reopen it to cancel_order) — ORDER_DELETED_STATUS_LOCKED.
--   2. guard_deleted_order_lines_locked (BEFORE INSERT OR DELETE OR UPDATE OF the quantity and
--      identity columns ON order_items): refuses adding, removing, re-pointing or re-quantifying a
--      line of a soft-deleted order — ORDER_DELETED_LINES_LOCKED. Price and cost columns stay
--      editable (bulk reprice tools touch those). A cascade from a hard-deleted order is allowed:
--      the parent row is already gone when its lines are removed.
--   3. guard_deleted_order_deliveries_locked (BEFORE INSERT OR UPDATE OF status, order_id ON
--      deliveries): refuses creating a delivery on a soft-deleted order or changing the status of
--      one of its deliveries — ORDER_DELETED_DELIVERIES_LOCKED. cancel_delivery / void_delivery put
--      the delivered units back into quantity_prebooked and quantity_available BEFORE they touch the
--      order's lines, so on a deleted order with no lines left (ORD-2026-0345) they would slip past
--      guards 1 and 2 and re-reserve stock nobody owes. Consequence, accepted: a completed delivery
--      on a deleted order can no longer be cancelled or voided.
-- All three functions only read; the line and delivery guards are SECURITY DEFINER so a caller who
-- cannot see the parent order under RLS cannot slip past them.
--
-- Rollback (new reviewed migration): drop the three triggers and their functions.
-- ORDERING: after 20261007150000; before 20261007150200, which requires these triggers.

SET LOCAL lock_timeout = '5s';

DO $preflight$
DECLARE
  v_blocking text;
BEGIN
  -- An open delivery on a deleted order would be stranded: completing or cancelling it moves the
  -- order's status or its lines' quantities, which the locks below refuse. Restore or clean up
  -- such an order before applying.
  SELECT string_agg(o.order_number || '/' || d.delivery_number, ', ' ORDER BY o.order_number, d.delivery_number)
    INTO v_blocking
    FROM public.deliveries d JOIN public.orders o ON o.id = d.order_id
   WHERE o.deleted_at IS NOT NULL AND d.deleted_at IS NULL
     AND d.status IN ('scheduled', 'in_progress');
  IF v_blocking IS NOT NULL THEN
    RAISE EXCEPTION 'DELETED_ORDER_LOCK_PREFLIGHT: a soft-deleted order still has an open delivery: %', v_blocking;
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.refuse_deleted_order_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'ORDER_DELETED_STATUS_LOCKED: order % is deleted, so it cannot be restored or have its status changed',
    OLD.order_number;
END;
$function$;

ALTER FUNCTION public.refuse_deleted_order_status_change() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.refuse_deleted_order_status_change() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS guard_deleted_order_status_locked ON public.orders;
CREATE TRIGGER guard_deleted_order_status_locked
  BEFORE UPDATE OF status, deleted_at ON public.orders
  FOR EACH ROW
  WHEN (OLD.deleted_at IS NOT NULL AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.deleted_at IS NULL))
  EXECUTE FUNCTION public.refuse_deleted_order_status_change();

CREATE OR REPLACE FUNCTION public.refuse_deleted_order_line_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_order_number text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT o.order_number INTO v_order_number
      FROM public.orders o WHERE o.id = OLD.order_id AND o.deleted_at IS NOT NULL;
    IF FOUND THEN
      RAISE EXCEPTION 'ORDER_DELETED_LINES_LOCKED: order % is deleted, so its lines cannot change', v_order_number;
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT o.order_number INTO v_order_number
      FROM public.orders o WHERE o.id = NEW.order_id AND o.deleted_at IS NOT NULL;
    IF FOUND THEN
      RAISE EXCEPTION 'ORDER_DELETED_LINES_LOCKED: order % is deleted, so its lines cannot change', v_order_number;
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

ALTER FUNCTION public.refuse_deleted_order_line_change() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.refuse_deleted_order_line_change() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS guard_deleted_order_lines_locked ON public.order_items;
CREATE TRIGGER guard_deleted_order_lines_locked
  BEFORE INSERT OR DELETE OR UPDATE OF order_id, product_id, total_units_needed, quantity_delivered, quantity_remaining
  ON public.order_items
  FOR EACH ROW
  EXECUTE FUNCTION public.refuse_deleted_order_line_change();

CREATE OR REPLACE FUNCTION public.refuse_deleted_order_delivery_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_order_number text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.order_id IS NOT DISTINCT FROM OLD.order_id THEN
      RETURN NEW;
    END IF;
    SELECT o.order_number INTO v_order_number
      FROM public.orders o WHERE o.id = OLD.order_id AND o.deleted_at IS NOT NULL;
    IF FOUND THEN
      RAISE EXCEPTION 'ORDER_DELETED_DELIVERIES_LOCKED: order % is deleted, so its deliveries cannot change', v_order_number;
    END IF;
  END IF;
  SELECT o.order_number INTO v_order_number
    FROM public.orders o WHERE o.id = NEW.order_id AND o.deleted_at IS NOT NULL;
  IF FOUND THEN
    RAISE EXCEPTION 'ORDER_DELETED_DELIVERIES_LOCKED: order % is deleted, so its deliveries cannot change', v_order_number;
  END IF;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.refuse_deleted_order_delivery_change() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.refuse_deleted_order_delivery_change() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS guard_deleted_order_deliveries_locked ON public.deliveries;
CREATE TRIGGER guard_deleted_order_deliveries_locked
  BEFORE INSERT OR UPDATE OF status, order_id ON public.deliveries
  FOR EACH ROW
  EXECUTE FUNCTION public.refuse_deleted_order_delivery_change();

DO $postflight$
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'refuse_deleted_order_status_change'
         AND NOT p.prosecdef AND p.proowner = 'postgres'::regrole
         AND p.proconfig = ARRAY['search_path=public, pg_temp']) <> 1
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'refuse_deleted_order_line_change'
         AND p.prosecdef AND p.proowner = 'postgres'::regrole
         AND p.proconfig = ARRAY['search_path=public, pg_temp']) <> 1
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'refuse_deleted_order_delivery_change'
         AND p.prosecdef AND p.proowner = 'postgres'::regrole
         AND p.proconfig = ARRAY['search_path=public, pg_temp']) <> 1 THEN
    RAISE EXCEPTION 'DELETED_ORDER_LOCK_POSTFLIGHT: expected exactly one definition of each guard, with the intended security mode, owner and search_path';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.deliveries'::regclass
                  AND tgname = 'guard_deleted_order_deliveries_locked' AND tgenabled = 'O' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'DELETED_ORDER_LOCK_POSTFLIGHT: the delivery lock trigger is missing or disabled';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.orders'::regclass
                  AND tgname = 'guard_deleted_order_status_locked' AND tgenabled = 'O' AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.order_items'::regclass
                  AND tgname = 'guard_deleted_order_lines_locked' AND tgenabled = 'O' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'DELETED_ORDER_LOCK_POSTFLIGHT: a lock trigger is missing or disabled';
  END IF;
  IF has_function_privilege('authenticated', 'public.refuse_deleted_order_line_change()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.refuse_deleted_order_line_change()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.refuse_deleted_order_delivery_change()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.refuse_deleted_order_delivery_change()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.refuse_deleted_order_status_change()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.refuse_deleted_order_status_change()', 'EXECUTE') THEN
    RAISE EXCEPTION 'DELETED_ORDER_LOCK_POSTFLIGHT: a lock guard is executable by an API role';
  END IF;
END
$postflight$;
