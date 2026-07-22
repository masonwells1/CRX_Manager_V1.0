-- Guard inventory location moves and restrict quick-receive matcher grants.
--
-- Section 3 live-foundation gauntlet follow-up:
-- 1. Prevent direct UPDATE inventory.location from moving nonzero stock outside
--    a reviewed transfer workflow.
-- 2. Remove anon/PUBLIC EXECUTE from match_quick_receive_items(jsonb, text).

CREATE OR REPLACE FUNCTION public._guard_inventory_location_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.location IS DISTINCT FROM OLD.location
     AND (
       COALESCE(OLD.quantity_available, 0) <> 0
       OR COALESCE(OLD.quantity_prebooked, 0) <> 0
       OR COALESCE(OLD.quantity_on_order, 0) <> 0
       OR COALESCE(NEW.quantity_available, 0) <> 0
       OR COALESCE(NEW.quantity_prebooked, 0) <> 0
       OR COALESCE(NEW.quantity_on_order, 0) <> 0
     )
  THEN
    RAISE EXCEPTION
      USING
        ERRCODE = 'P0001',
        MESSAGE = 'INVENTORY_LOCATION_TRANSFER_REQUIRED',
        DETAIL = 'Nonzero inventory rows must be transferred through a reviewed stock-move workflow, not by directly editing inventory.location.';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public._guard_inventory_location_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._guard_inventory_location_change() FROM anon;
REVOKE ALL ON FUNCTION public._guard_inventory_location_change() FROM authenticated;

DROP TRIGGER IF EXISTS guard_inventory_location_change ON public.inventory;
CREATE TRIGGER guard_inventory_location_change
BEFORE UPDATE OF location ON public.inventory
FOR EACH ROW
EXECUTE FUNCTION public._guard_inventory_location_change();

REVOKE EXECUTE ON FUNCTION public.match_quick_receive_items(jsonb, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.match_quick_receive_items(jsonb, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.match_quick_receive_items(jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.match_quick_receive_items(jsonb, text) TO service_role;

DO $verify$
DECLARE
  v_trigger_count integer;
BEGIN
  SELECT count(*)
  INTO v_trigger_count
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'inventory'
    AND t.tgname = 'guard_inventory_location_change'
    AND NOT t.tgisinternal;

  IF v_trigger_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly one guard_inventory_location_change trigger, found %', v_trigger_count;
  END IF;

  IF has_function_privilege('anon', 'public.match_quick_receive_items(jsonb, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not execute public.match_quick_receive_items(jsonb, text)';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.match_quick_receive_items(jsonb, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must execute public.match_quick_receive_items(jsonb, text)';
  END IF;
END;
$verify$;
