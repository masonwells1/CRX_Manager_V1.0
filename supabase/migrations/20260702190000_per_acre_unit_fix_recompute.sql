-- Migration: per-acre unit fix + recompute (Structure Wave-2, P2-5 follow-up)
-- =============================================================================
-- PURPOSE
--   The trigger-maintained products.tier{1,2,3}_price_per_acre columns are wrong:
--   the old formula was  tierN_price * rate_per_acre / container_size  with NO
--   unit conversion (rate in oz, container_size in gal) — ~43% of active products
--   ended up >$500/acre, worst $16,373/acre (verified live 2026-07-03).
--
--   Owner (Mason) chose KEEP THE COLUMNS + UNIT-FIX + RECOMPUTE (not retire), and
--   wants these stored columns to be authoritative/usable — so they must stay
--   correct on EVERY product write path, not just the full-row save.
--
--   Per-acre now uses the SAME unit-aware formula as the frontend quote screen
--   (src/lib/quoteCalc.ts catalogPricePerAcre / recalcItem):
--
--       per_acre = tierPrice * (rate_per_acre * factor_oz(rate_unit))
--                             / factor_oz(inventory_unit ?? unit_size)
--
--   so the STORED column equals what the QuoteBuilder product picker (P2-5)
--   computes live. factor_oz is the case-insensitive unit_conversions lookup,
--   defaulting to 1 when a unit is absent/unknown (mirrors getConversionFactor).
--   Returns NULL when rate_per_acre is null/<=0 (never a fabricated number).
--
-- DESIGN — TWO TRIGGERS (keeps price semantics EXACT, keeps per-acre always fresh)
--   The old single trigger both derived tier prices from margins AND computed
--   per-acre. Watching the tier-price columns for per-acre freshness would let the
--   margin block re-run and CLOBBER a manually-set price on a partial
--   `UPDATE SET tierN_price`. So the two concerns are split:
--
--   * Trigger A  trigger_calculate_prices_from_margin  — margin -> tier price +
--     gross margin ONLY. Math byte-identical to live. Watches current_cost +
--     tier{1,2,3}_margin. (rate_per_acre / container_size dropped — the margin
--     block never used them; per-acre moved to B.) Preserves today's behavior:
--     a direct tier-price edit is NOT clobbered (A doesn't watch price columns),
--     and margin still wins on a full-row save (current_cost is present).
--
--   * Trigger B  trigger_recalc_product_price_per_acre  — per-acre ONLY, from the
--     FINAL tier price (getTierPrice's tier2/3 -> tier1 fallback). Watches the
--     UNION of everything that can change the output: current_cost + margins
--     (they change tier price via A), tier{1,2,3}_price (direct edits), and
--     rate_per_acre / rate_unit / inventory_unit / unit_size.
--     Fires AFTER A: BEFORE row triggers run in alphabetical name order and
--     'r'(ecalc) > 'c'(alculate), so B always reads A's finalized tier price.
--
--   This closes the gap Codex (gpt-5.5) flagged: partial tier-price-only updates
--   from BulkPricingImport (a CSV without a cost column) and the Products page
--   inline bulk edit (EditableDataTable sends only changed cells) previously left
--   per-acre stale. Now B refreshes it on those paths too, with no clobber.
--
-- WHAT CHANGES
--   1. NEW helper  public.product_price_per_acre(...)  — one source of truth for
--      the formula, used by trigger B and the one-time recompute.
--   2. REWRITE trigger fn  calculate_prices_from_margin  — margin math unchanged;
--      per-acre lines removed.
--   3. NEW trigger fn  recalc_product_price_per_acre  + its trigger (fires after A).
--   4. RE-BIND trigger A's watch list to current_cost + margins only.
--   5. RECOMPUTE all existing products once via the helper (fixes the live data).
--
-- SAFE: additive to behavior. Tier prices, margins, gross margins UNCHANGED. No
--   column added/dropped. No RLS change. No status/enum. The per-acre columns
--   already exist and are already typed in src/types/index.ts:63-65.
--
-- SMOKE  (rolled-back live DO-block, RAISE to roll back — nothing persisted; verified
--   live unchanged after: helper absent, Pramitol still 16373.76, 242 still >$500):
--   SMOKE| pram_stored=319.80 fullsave=319.80 price_kept=999 price_refreshed=4995.00
--   order_price=100.00 order_peracre=500.00 null_rate=NULL unknown=10.00 max_t1=443.00
--   cnt_t1=569 over_500=0 arith_mismatch=0 chk_a=0 chk_b=0 chk_h=0 ov_a=1 ov_b=1 ov_h=1
--   (price_kept=999 = partial tier-price edit NOT clobbered; price_refreshed=4995 = per-acre
--    refreshed by trigger B on that direct edit [Codex P2 fix]; order_peracre=500 [not 1000] =
--    B read A's margin-recomputed price => firing order A-before-B proven; live verified
--    unchanged after: helper/triggerB absent, Pramitol still 16373.76, 242 still >$500.)
-- CODEX  : R1 [P2] per-acre stale on direct tier-price edits (BulkPricingImport /
--   Products inline edit) -> FIXED via two-trigger design. R2 CLEAN (no discrete
--   correctness/security/maintainability bug). rls-security-reviewer + migration-drift-reviewer
--   both re-run on v2 -> 0 blockers (drift H1 version-stamp + M1 history-row are apply-time only).
-- APPLY-ORDER: standalone; no dependency on other parked migrations. At apply time
--   also refresh the (now-outdated) "wildly wrong" comment in src/lib/quoteCalc.ts
--   and add the migration-history.md row.
-- =============================================================================

-- 1. Helper: correct, unit-aware $/acre. STABLE (reads unit_conversions).
--    Mirrors src/lib/quoteCalc.ts catalogPricePerAcre exactly.
CREATE OR REPLACE FUNCTION public.product_price_per_acre(
  p_tier_price       numeric,
  p_rate_per_acre    numeric,
  p_rate_unit        text,
  p_inventory_unit   text,
  p_unit_size        text
) RETURNS numeric
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rate_factor numeric;
  v_inv_factor  numeric;
  v_inv_unit    text;
BEGIN
  -- No usable rate -> no per-acre figure (matches frontend: returns null).
  IF p_rate_per_acre IS NULL OR p_rate_per_acre <= 0 THEN
    RETURN NULL;
  END IF;

  -- rate unit -> oz factor (case-insensitive; default 1 when absent/unknown).
  v_rate_factor := COALESCE(
    (SELECT factor_oz FROM unit_conversions WHERE lower(unit) = lower(p_rate_unit) LIMIT 1),
    1);

  -- inventory unit falls back to unit_size when blank/null (JS: inventory_unit || unit_size).
  v_inv_unit := COALESCE(NULLIF(p_inventory_unit, ''), p_unit_size);
  v_inv_factor := COALESCE(
    (SELECT factor_oz FROM unit_conversions WHERE lower(unit) = lower(v_inv_unit) LIMIT 1),
    1);

  -- Guard divide-by-zero (mirrors frontend `inventoryUnitFactorOz > 0`).
  IF v_inv_factor IS NULL OR v_inv_factor <= 0 THEN
    RETURN NULL;
  END IF;

  RETURN ROUND(
    (COALESCE(p_tier_price, 0) * (p_rate_per_acre * v_rate_factor) / v_inv_factor)::numeric,
    2);
END;
$$;

REVOKE ALL ON FUNCTION public.product_price_per_acre(numeric, numeric, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.product_price_per_acre(numeric, numeric, text, text, text)
  TO authenticated, service_role;

-- 2. Trigger fn A: margin -> tier price + gross margin ONLY (per-acre removed).
--    Math is byte-identical to the live definition.
CREATE OR REPLACE FUNCTION public.calculate_prices_from_margin()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.current_cost IS NOT NULL AND NEW.current_cost > 0 THEN
    IF NEW.tier1_margin IS NOT NULL AND NEW.tier1_margin < 1 AND NEW.tier1_margin > 0 THEN
      NEW.tier1_price := ROUND(NEW.current_cost / (1 - NEW.tier1_margin), 2);
      NEW.tier1_gross_margin := ROUND(NEW.tier1_margin / (1 - NEW.tier1_margin), 4);
    ELSE
      NEW.tier1_gross_margin := NULL;
    END IF;

    IF NEW.tier2_margin IS NOT NULL AND NEW.tier2_margin < 1 AND NEW.tier2_margin > 0 THEN
      NEW.tier2_price := ROUND(NEW.current_cost / (1 - NEW.tier2_margin), 2);
      NEW.tier2_gross_margin := ROUND(NEW.tier2_margin / (1 - NEW.tier2_margin), 4);
    ELSE
      NEW.tier2_gross_margin := NULL;
    END IF;

    IF NEW.tier3_margin IS NOT NULL AND NEW.tier3_margin < 1 AND NEW.tier3_margin > 0 THEN
      NEW.tier3_price := ROUND(NEW.current_cost / (1 - NEW.tier3_margin), 2);
      NEW.tier3_gross_margin := ROUND(NEW.tier3_margin / (1 - NEW.tier3_margin), 4);
    ELSE
      NEW.tier3_gross_margin := NULL;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- 3. Trigger fn B: per-acre from the FINAL tier price (unit-aware, getTierPrice fallback).
CREATE OR REPLACE FUNCTION public.recalc_product_price_per_acre()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t1 numeric := COALESCE(NEW.tier1_price, 0);  -- getTierPrice fallback base
BEGIN
  NEW.tier1_price_per_acre := public.product_price_per_acre(
    v_t1,
    NEW.rate_per_acre, NEW.rate_unit, NEW.inventory_unit, NEW.unit_size);
  NEW.tier2_price_per_acre := public.product_price_per_acre(
    COALESCE(NULLIF(NEW.tier2_price, 0), v_t1),
    NEW.rate_per_acre, NEW.rate_unit, NEW.inventory_unit, NEW.unit_size);
  NEW.tier3_price_per_acre := public.product_price_per_acre(
    COALESCE(NULLIF(NEW.tier3_price, 0), v_t1),
    NEW.rate_per_acre, NEW.rate_unit, NEW.inventory_unit, NEW.unit_size);
  RETURN NEW;
END;
$function$;

-- 4. Re-bind trigger A to the columns the MARGIN math actually depends on.
DROP TRIGGER IF EXISTS trigger_calculate_prices_from_margin ON public.products;
CREATE TRIGGER trigger_calculate_prices_from_margin
  BEFORE INSERT OR UPDATE OF current_cost, tier1_margin, tier2_margin, tier3_margin
  ON public.products
  FOR EACH ROW
  EXECUTE FUNCTION public.calculate_prices_from_margin();

-- 5. Trigger B: per-acre freshness on EVERY output-affecting column. Name sorts
--    AFTER trigger A ('r' > 'c') so it reads A's finalized tier price.
DROP TRIGGER IF EXISTS trigger_recalc_product_price_per_acre ON public.products;
CREATE TRIGGER trigger_recalc_product_price_per_acre
  BEFORE INSERT OR UPDATE OF
    current_cost, tier1_margin, tier2_margin, tier3_margin,
    tier1_price, tier2_price, tier3_price,
    rate_per_acre, rate_unit, inventory_unit, unit_size
  ON public.products
  FOR EACH ROW
  EXECUTE FUNCTION public.recalc_product_price_per_acre();

-- 6. One-time recompute of existing products (fixes the live garbage immediately).
--    Sets only the per-acre columns (NOT watched by either trigger -> no re-entry);
--    tier prices/margins are left exactly as they are.
UPDATE public.products AS p
SET
  tier1_price_per_acre = public.product_price_per_acre(
    COALESCE(p.tier1_price, 0),
    p.rate_per_acre, p.rate_unit, p.inventory_unit, p.unit_size),
  tier2_price_per_acre = public.product_price_per_acre(
    COALESCE(NULLIF(p.tier2_price, 0), COALESCE(p.tier1_price, 0)),
    p.rate_per_acre, p.rate_unit, p.inventory_unit, p.unit_size),
  tier3_price_per_acre = public.product_price_per_acre(
    COALESCE(NULLIF(p.tier3_price, 0), COALESCE(p.tier1_price, 0)),
    p.rate_per_acre, p.rate_unit, p.inventory_unit, p.unit_size)
WHERE
  p.tier1_price_per_acre IS DISTINCT FROM public.product_price_per_acre(
    COALESCE(p.tier1_price, 0), p.rate_per_acre, p.rate_unit, p.inventory_unit, p.unit_size)
  OR p.tier2_price_per_acre IS DISTINCT FROM public.product_price_per_acre(
    COALESCE(NULLIF(p.tier2_price, 0), COALESCE(p.tier1_price, 0)), p.rate_per_acre, p.rate_unit, p.inventory_unit, p.unit_size)
  OR p.tier3_price_per_acre IS DISTINCT FROM public.product_price_per_acre(
    COALESCE(NULLIF(p.tier3_price, 0), COALESCE(p.tier1_price, 0)), p.rate_per_acre, p.rate_unit, p.inventory_unit, p.unit_size);
