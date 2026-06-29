-- 20260629140000_convert_to_gl_lb_gallon_aliases.sql
--
-- FIELD-APP PARITY remediation (Wave 2a, FIX 3 — P2 MONEY-DISPLAY).
--
-- THE BUG (proven live before this migration):
--   convert_to_gl_lb(10, 'GAL', 'liquid') returned 0.078, NOT 10.
--   The liquid branch matched ONLY the literal 'GL' for gallons. Every other
--   gallon spelling the field app actually emits — 'Gal' / 'gal' / 'Gallon' /
--   'GALLON' — fell to the liquid ELSE and was divided by 128 (treated as fluid
--   ounces), so 10 gallons displayed as 10/128 = 0.078 "gallons". This figure
--   feeds invoice_items.total_applied_gl_lb and the loader/applicator PDFs, so a
--   gallon line read ~128x too SMALL. (Display only — the per-unit cents math is
--   computed elsewhere and is unaffected; this is the gal/lb EQUIVALENT shown for
--   tank planning.)
--
-- THE FIX (faithful CREATE OR REPLACE — the live body reproduced verbatim, only
-- the two CASE statements changed):
--   1. LIQUID branch: recognize all gallon spellings —
--        WHEN 'GL','GAL','GALLON','GALLONS' THEN p_total_applied
--      (upper() already folds case, so this covers Gal/gal/Gallon/GALLON too).
--   2. UNRECOGNIZED unit (either branch): instead of silently dividing by 128
--      (liquid) or passing the number through unchanged (dry) — both of which
--      invent a number we don't actually know — set converted_value AND
--      converted_unit to NULL. The UI helper (src/lib/chemCalculator.ts,
--      toGallonOrLbEquivalent) ALREADY returns null for an unrecognized /
--      form-mismatched unit and renders a dash; this aligns the server with it,
--      so screen == saved == PDF (a dash, never a guessed quantity).
--
-- WHY THIS IS SAFE / ADDITIVE-ONLY:
--   * No signature change, single overload (verified: 1 row in pg_proc). Pure
--     IMMUTABLE function, no data migration, no policy/table touched.
--   * Every PREVIOUSLY-RECOGNIZED unit returns the SAME value as before:
--       liquid OZ=q/128, PT=q/8, QT=q/4, GL=q (unchanged); GAL/GALLON/GALLONS
--       are NEW correct matches (were the wrong /128 ELSE before).
--       dry    OZ=q/16, LB=q (unchanged).
--     ONLY the formerly-wrong ELSE outputs change (junk /128 or pass-through ->
--     an honest NULL/dash). Existing saved rows are recomputed on next read/save;
--     no backfill needed.
--   * Mirrors the original migration 20260219200000 (liquid branch lines 203-213)
--     plus the live definition; em-dashes below are real U+2014.

CREATE OR REPLACE FUNCTION public.convert_to_gl_lb(
  p_total_applied numeric,
  p_rate_unit text,
  p_product_form text
)
RETURNS TABLE(converted_value numeric, converted_unit text)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
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
      WHEN 'PT' THEN converted_value := p_total_applied / 8.0;   converted_unit := 'GL';
      WHEN 'QT' THEN converted_value := p_total_applied / 4.0;   converted_unit := 'GL';
      -- All gallon spellings (upper() folds Gal/gal/Gallon/GALLON) — the bug fix.
      WHEN 'GL', 'GAL', 'GALLON', 'GALLONS' THEN converted_value := p_total_applied; converted_unit := 'GL';
      -- Unrecognized liquid unit: don't guess (was wrongly /128) — NULL + dash.
      ELSE converted_value := NULL; converted_unit := NULL;
    END CASE;
  END IF;

  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.convert_to_gl_lb(numeric, text, text) IS
  'Field-app gal/lb equivalent for tank planning (display only). Liquid: OZ=q/128, '
  'PT=q/8, QT=q/4, GL/GAL/GALLON/GALLONS=q. Dry: OZ=q/16, LB=q. An unrecognized unit '
  'returns NULL value+unit (UI shows a dash) — never a guessed number. Matches '
  'src/lib/chemCalculator.ts toGallonOrLbEquivalent.';
