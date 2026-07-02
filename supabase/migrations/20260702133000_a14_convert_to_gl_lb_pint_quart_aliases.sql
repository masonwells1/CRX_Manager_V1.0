-- ============================================================================
-- PARKED DRAFT — DO NOT APPLY (structure-fix loop, Wave A / A14). 2026-07-02.
-- Mason applies via the DRAFT/APPLY protocol after review.
--
-- WHAT: convert_to_gl_lb accepts full-word pint(s)/quart(s), not just PT/QT.
-- WHY:  The TS client helper (chemCalculator.ts LIQUID_TO_GALLONS) accepts
--       'pint'/'pints'/'quart'/'quarts', but the live SQL fn only matches 'PT'/'QT'
--       → a rate_unit of 'pint' previews a gallon-equivalent on screen but SAVES as
--       NULL (client-shows-value / server-saves-NULL). Additive alias only.
-- SCOPE: SURGICAL — rebuilt verbatim from live pg_get_functiondef (20260629140000);
--        the ONLY change is adding 'PINT','PINTS' to the PT case and 'QUART','QUARTS'
--        to the QT case in the LIQUID branch. Dry branch untouched (pt/qt are liquid).
-- SAFE:  additive; IMMUTABLE; no signature change. Existing 'PT'/'QT' rows unchanged;
--        previously-NULL 'pint'/'quart' rows now compute the correct gallon value.
--
-- SMOKE (2026-07-02, live rolled-back BEGIN…ROLLBACK + plpgsql_check + FUNCTIONAL value checks): PASS —
--   created in a tx, CALLED with real values: pint(8)=1.0 GL, pints(16)=2.0, quart(4)=1.0, quarts(8)=2.0;
--   existing PT(8)=1.0 / QT(4)=1.0 / Gallon(3)=3 unchanged; plpgsql_check CLEAN; tx aborted (no persist;
--   live fn confirmed still lacks PINT, position()=0; 1 overload).
-- CODEX: CLEAN — "did not find a discrete correctness issue in the changed function body."
-- ============================================================================

CREATE OR REPLACE FUNCTION public.convert_to_gl_lb(p_total_applied numeric, p_rate_unit text, p_product_form text)
 RETURNS TABLE(converted_value numeric, converted_unit text)
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_total_applied IS NULL OR p_rate_unit IS NULL THEN
    RETURN QUERY SELECT NULL::numeric, NULL::text;
    RETURN;
  END IF;

  IF p_product_form = 'dry' THEN
    -- Convert to LB. Mirror the client helper DRY_TO_POUNDS spellings so screen == saved
    -- (oz/ounce/ounces = q/16; lb/lbs/pound/pounds = q; ton/tons = q*2000).
    CASE upper(p_rate_unit)
      WHEN 'OZ', 'OUNCE', 'OUNCES' THEN converted_value := p_total_applied / 16.0; converted_unit := 'LB';
      WHEN 'LB', 'LBS', 'POUND', 'POUNDS' THEN converted_value := p_total_applied;  converted_unit := 'LB';
      WHEN 'TON', 'TONS' THEN converted_value := p_total_applied * 2000.0;          converted_unit := 'LB';
      -- Unrecognized dry unit: don't guess — NULL value + unit so the UI shows a dash.
      ELSE converted_value := NULL; converted_unit := NULL;
    END CASE;
  ELSE
    -- Liquid: Convert to GL. Fluid-ounce spellings (OZ/FL OZ/FLOZ/FLUID OUNCE) all = q/128
    -- to match the client helper LIQUID_TO_GALLONS (which lists every fl-oz spelling).
    CASE upper(p_rate_unit)
      WHEN 'OZ', 'FL OZ', 'FLOZ', 'FLUID OUNCE' THEN converted_value := p_total_applied / 128.0; converted_unit := 'GL';
      -- A14: accept full-word pint/pints (8 pt = 1 gal) to match the TS client helper.
      WHEN 'PT', 'PINT', 'PINTS' THEN converted_value := p_total_applied / 8.0;   converted_unit := 'GL';
      -- A14: accept full-word quart/quarts (4 qt = 1 gal) to match the TS client helper.
      WHEN 'QT', 'QUART', 'QUARTS' THEN converted_value := p_total_applied / 4.0;   converted_unit := 'GL';
      -- All gallon spellings (upper() folds Gal/gal/Gallon/GALLON) — the bug fix.
      WHEN 'GL', 'GAL', 'GALLON', 'GALLONS' THEN converted_value := p_total_applied; converted_unit := 'GL';
      -- Unrecognized liquid unit: don't guess (was wrongly /128) — NULL + dash.
      ELSE converted_value := NULL; converted_unit := NULL;
    END CASE;
  END IF;

  RETURN NEXT;
END;
$function$;
