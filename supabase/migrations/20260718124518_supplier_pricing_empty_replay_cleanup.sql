-- Remove the short-lived empty-catalog replay helper installed immediately
-- before the already-applied 20260718124517 Supplier Pricing correction.
-- The helper never writes Product data and has no production responsibility.

DROP TRIGGER IF EXISTS trigger_supplier_pricing_empty_replay_guard
  ON public.products;

DROP FUNCTION IF EXISTS public._supplier_pricing_empty_replay_guard();
