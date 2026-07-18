-- Disposable replay adapter for the byte-immutable, already-applied Supplier
-- Pricing Phase 1a correction. That migration contains a row-trigger assertion
-- which is valid for production but otherwise has no row to exercise when a
-- disposable catalog contains zero Products.
--
-- This statement trigger is deliberately inert whenever any Product exists. On
-- an empty catalog it makes the assertion's zero-row UPDATE raise the exact error
-- the assertion expects. The disposable proof immediately removes this helper.
-- This fixture is not a production migration and writes no Product data.

CREATE OR REPLACE FUNCTION public._supplier_pricing_empty_replay_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.products) THEN
    RAISE EXCEPTION 'PRODUCT_PRICING_CENT_SCALE_INVALID';
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public._supplier_pricing_empty_replay_guard()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trigger_supplier_pricing_empty_replay_guard
  ON public.products;

CREATE TRIGGER trigger_supplier_pricing_empty_replay_guard
BEFORE UPDATE ON public.products
FOR EACH STATEMENT
EXECUTE FUNCTION public._supplier_pricing_empty_replay_guard();
