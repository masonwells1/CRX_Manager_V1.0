\set ON_ERROR_STOP on

DO $proof$
DECLARE
  v_legacy jsonb;
BEGIN
  BEGIN
    PERFORM public._calculate_product_pricing(
      'margin_driven', 0, 0.25, 0.20, 0.15, NULL, NULL, NULL
    );
    RAISE EXCEPTION 'margin-driven zero cost unexpectedly passed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'PRICING_COST_INVALID' THEN
      RAISE;
    END IF;
  END;

  v_legacy := public._calculate_product_pricing(
    'legacy_margin', 0, 0.25, 0.20, 0.15, 5.00, 6.00, 7.00
  );
  IF (v_legacy->>'tier1_price')::numeric IS DISTINCT FROM 5.00::numeric
     OR (v_legacy->>'tier2_price')::numeric IS DISTINCT FROM 6.00::numeric
     OR (v_legacy->>'tier3_price')::numeric IS DISTINCT FROM 7.00::numeric THEN
    RAISE EXCEPTION 'legacy zero-cost compatibility changed: %', v_legacy;
  END IF;
END;
$proof$;

\echo PHASE1A_ZERO_COST_GUARD_PASS
