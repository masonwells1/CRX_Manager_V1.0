-- Product label-data corrections — SAFE/unambiguous subset (Mason-approved 2026-06-15)
-- Source: 2026-06-14 parallel label-research agents (each value web-sourced + verified
-- against the current EPA label). Scope is deliberately limited to the two fixes with
-- zero ambiguity; the generic-name cleanup and REI/PHI/follow-up loading are SEPARATE
-- follow-ups (generics' EPA # is per-manufacturer and ties to the catalog rename).
--
-- Idempotent: each UPDATE is guarded on the current value, so a re-run is a no-op.
-- Verify after apply:
--   SELECT product_name, epa_registration, is_rup FROM products
--   WHERE product_name LIKE 'Trivapro%'
--      OR product_name IN ('Gen Baythroid XL: (Cryptoid XL) - 1 Gal',
--                          'Gen Leverage 360: (Cryptonyx 360) - 1 Gal');

-- 1) Trivapro EPA # was WRONG (100-1567); current label + Greenbook confirm 100-1613.
UPDATE public.products
   SET epa_registration = '100-1613'
 WHERE product_name LIKE 'Trivapro%'
   AND epa_registration = '100-1567';

-- 2) Flag the two beta-cyfluthrin generics as Restricted Use (their labels carry the
--    "RESTRICTED USE PESTICIDE" statement; RUP is a property of the active ingredient,
--    so this is correct regardless of which manufacturer's brand is stocked).
--    NOTE: this activates the B1 RUP point-of-sale warnings for these two products.
UPDATE public.products
   SET is_rup = true
 WHERE product_name IN (
         'Gen Baythroid XL: (Cryptoid XL) - 1 Gal',   -- Atticus Cryptoid XL, EPA 91234-295
         'Gen Leverage 360: (Cryptonyx 360) - 1 Gal'  -- Atticus Cryptonyx 360, EPA 91234-292
       )
   AND is_rup = false;
