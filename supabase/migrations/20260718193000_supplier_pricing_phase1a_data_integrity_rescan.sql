-- Supplier Pricing Phase 1a — post-cutover data-integrity rescan (2026-07-18).
--
-- Adversarial-review follow-up on the enforcement cutover
-- (20260718190000_supplier_pricing_phase1a_cutover). The cutover locks FUTURE
-- pricing writes to the governed RPC but does not itself re-validate rows that
-- already existed. The additive compatibility window (before cutover) allowed
-- legacy direct writes whose guard did not enforce finite / non-negative /
-- cent-scale money, so in principle an invalid cost or tier price written after
-- the harden scan (20260718124517) and before cutover could have survived.
--
-- This forward-only migration closes that gap durably: it takes a SHARE lock on
-- public.products and fails closed — naming the offending product ids — if any
-- current_cost or tier1/2/3_price is NaN/Infinity, negative, or not cent-scale.
-- Live verification on 2026-07-18 (read-only) found ZERO such rows, so this
-- passes cleanly today; it exists so the invariant is a permanent, enforced part
-- of the migration history rather than a one-time out-of-band check. Scan-only:
-- no schema, grant, policy, or data change.

DO $rescan$
DECLARE
  v_invalid_product_ids uuid[];
BEGIN
  LOCK TABLE public.products IN SHARE MODE;

  SELECT array_agg(p.id ORDER BY p.id)
  INTO v_invalid_product_ids
  FROM public.products p
  WHERE p.current_cost::text IN ('NaN', 'Infinity', '-Infinity')
     OR p.tier1_price::text IN ('NaN', 'Infinity', '-Infinity')
     OR p.tier2_price::text IN ('NaN', 'Infinity', '-Infinity')
     OR p.tier3_price::text IN ('NaN', 'Infinity', '-Infinity')
     OR p.current_cost < 0
     OR p.tier1_price < 0
     OR p.tier2_price < 0
     OR p.tier3_price < 0
     OR round(p.current_cost::numeric, 2) IS DISTINCT FROM p.current_cost
     OR round(p.tier1_price::numeric, 2) IS DISTINCT FROM p.tier1_price
     OR round(p.tier2_price::numeric, 2) IS DISTINCT FROM p.tier2_price
     OR round(p.tier3_price::numeric, 2) IS DISTINCT FROM p.tier3_price;

  IF v_invalid_product_ids IS NOT NULL THEN
    RAISE EXCEPTION
      'PHASE1A_INVALID_PRODUCT_PRICING_SURVIVED_CUTOVER: product_ids=%',
      v_invalid_product_ids;
  END IF;
END;
$rescan$;
