-- Remove the short-lived empty-catalog adapter installed by the disposable
-- Supplier Pricing replay proof. This fixture is not a production migration.

DROP TRIGGER IF EXISTS trigger_supplier_pricing_empty_replay_guard
  ON public.products;

DROP FUNCTION IF EXISTS public._supplier_pricing_empty_replay_guard();
