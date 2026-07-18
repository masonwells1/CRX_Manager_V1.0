-- Supplier Pricing Phase 1a pre-deploy zero-cost guard.
--
-- Owner-approved for a separately reviewed live migration after the additive
-- bootstrap is live and before the RPC pricing frontend is deployed.
-- This is compatibility-safe for the deployed legacy Product editor because
-- legacy_margin behavior is unchanged. It closes the temporary window where a
-- governed margin-driven request could turn a zero cost into zero sell prices.

DO $preflight$
DECLARE
  v_overload_count integer;
  v_body_md5 text;
BEGIN
  SELECT
    count(*),
    max(
      CASE
        WHEN p.oid = to_regprocedure(
          'public._calculate_product_pricing(text,numeric,numeric,numeric,numeric,numeric,numeric,numeric)'
        ) THEN md5(p.prosrc)
        ELSE NULL
      END
    )
  INTO v_overload_count, v_body_md5
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = '_calculate_product_pricing';

  IF v_overload_count <> 1
     OR v_body_md5 IS DISTINCT FROM '58b71cb8c69963cb88fe7c97d1b9ff0e' THEN
    RAISE EXCEPTION 'PRICING_CALCULATOR_BASELINE_MISMATCH';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public._calculate_product_pricing(
  p_mode text,
  p_current_cost numeric,
  p_tier1_margin numeric,
  p_tier2_margin numeric,
  p_tier3_margin numeric,
  p_tier1_price numeric,
  p_tier2_price numeric,
  p_tier3_price numeric
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_t1_margin numeric := p_tier1_margin;
  v_t2_margin numeric := p_tier2_margin;
  v_t3_margin numeric := p_tier3_margin;
  v_t1_price numeric := p_tier1_price;
  v_t2_price numeric := p_tier2_price;
  v_t3_price numeric := p_tier3_price;
  v_t1_gross numeric;
  v_t2_gross numeric;
  v_t3_gross numeric;
BEGIN
  IF p_mode NOT IN ('legacy_margin', 'margin_driven', 'price_driven') THEN
    RAISE EXCEPTION 'PRICING_MODE_INVALID';
  END IF;
  IF (p_mode <> 'legacy_margin' AND p_current_cost IS NULL)
     OR p_current_cost::text IN ('NaN', 'Infinity', '-Infinity')
     OR p_current_cost < 0
     OR (p_mode = 'margin_driven' AND p_current_cost = 0) THEN
    RAISE EXCEPTION 'PRICING_COST_INVALID';
  END IF;

  IF p_mode IN ('legacy_margin', 'margin_driven') THEN
    IF p_mode = 'margin_driven' AND (
      v_t1_margin IS NULL OR v_t2_margin IS NULL OR v_t3_margin IS NULL
      OR v_t1_margin::text IN ('NaN', 'Infinity', '-Infinity')
      OR v_t2_margin::text IN ('NaN', 'Infinity', '-Infinity')
      OR v_t3_margin::text IN ('NaN', 'Infinity', '-Infinity')
      OR v_t1_margin < 0 OR v_t1_margin >= 1
      OR v_t2_margin < 0 OR v_t2_margin >= 1
      OR v_t3_margin < 0 OR v_t3_margin >= 1
    ) THEN
      RAISE EXCEPTION 'PRICING_MARGIN_INVALID';
    END IF;

    -- legacy_margin deliberately preserves the exact pre-Phase-1a behavior:
    -- only positive margins on a positive cost overwrite the matching price.
    IF (p_mode = 'margin_driven' OR p_current_cost > 0)
       AND v_t1_margin IS NOT NULL AND v_t1_margin >= 0 AND v_t1_margin < 1
       AND (p_mode = 'margin_driven' OR v_t1_margin > 0) THEN
      v_t1_price := round(p_current_cost / (1 - v_t1_margin), 2);
      v_t1_gross := CASE WHEN v_t1_margin = 1 THEN NULL
                         ELSE round(v_t1_margin / (1 - v_t1_margin), 4) END;
    ELSE
      v_t1_gross := NULL;
    END IF;
    IF (p_mode = 'margin_driven' OR p_current_cost > 0)
       AND v_t2_margin IS NOT NULL AND v_t2_margin >= 0 AND v_t2_margin < 1
       AND (p_mode = 'margin_driven' OR v_t2_margin > 0) THEN
      v_t2_price := round(p_current_cost / (1 - v_t2_margin), 2);
      v_t2_gross := CASE WHEN v_t2_margin = 1 THEN NULL
                         ELSE round(v_t2_margin / (1 - v_t2_margin), 4) END;
    ELSE
      v_t2_gross := NULL;
    END IF;
    IF (p_mode = 'margin_driven' OR p_current_cost > 0)
       AND v_t3_margin IS NOT NULL AND v_t3_margin >= 0 AND v_t3_margin < 1
       AND (p_mode = 'margin_driven' OR v_t3_margin > 0) THEN
      v_t3_price := round(p_current_cost / (1 - v_t3_margin), 2);
      v_t3_gross := CASE WHEN v_t3_margin = 1 THEN NULL
                         ELSE round(v_t3_margin / (1 - v_t3_margin), 4) END;
    ELSE
      v_t3_gross := NULL;
    END IF;
  ELSE
    IF v_t1_price IS NULL OR v_t2_price IS NULL OR v_t3_price IS NULL
       OR v_t1_price::text IN ('NaN', 'Infinity', '-Infinity')
       OR v_t2_price::text IN ('NaN', 'Infinity', '-Infinity')
       OR v_t3_price::text IN ('NaN', 'Infinity', '-Infinity')
       OR v_t1_price < 0 OR v_t2_price < 0 OR v_t3_price < 0
       OR round(v_t1_price, 2) IS DISTINCT FROM v_t1_price
       OR round(v_t2_price, 2) IS DISTINCT FROM v_t2_price
       OR round(v_t3_price, 2) IS DISTINCT FROM v_t3_price THEN
      RAISE EXCEPTION 'PRICING_PRICE_INVALID';
    END IF;
    IF (v_t1_price = 0 AND p_current_cost > 0)
       OR (v_t2_price = 0 AND p_current_cost > 0)
       OR (v_t3_price = 0 AND p_current_cost > 0) THEN
      RAISE EXCEPTION 'PRICING_ZERO_PRICE_BELOW_COST';
    END IF;

    v_t1_margin := CASE WHEN v_t1_price = 0 THEN 0
                        ELSE round((v_t1_price - p_current_cost) / v_t1_price, 8) END;
    v_t2_margin := CASE WHEN v_t2_price = 0 THEN 0
                        ELSE round((v_t2_price - p_current_cost) / v_t2_price, 8) END;
    v_t3_margin := CASE WHEN v_t3_price = 0 THEN 0
                        ELSE round((v_t3_price - p_current_cost) / v_t3_price, 8) END;
    v_t1_gross := CASE WHEN p_current_cost = 0 THEN NULL
                       ELSE round((v_t1_price - p_current_cost) / p_current_cost, 4) END;
    v_t2_gross := CASE WHEN p_current_cost = 0 THEN NULL
                       ELSE round((v_t2_price - p_current_cost) / p_current_cost, 4) END;
    v_t3_gross := CASE WHEN p_current_cost = 0 THEN NULL
                       ELSE round((v_t3_price - p_current_cost) / p_current_cost, 4) END;
  END IF;

  RETURN jsonb_build_object(
    'current_cost', p_current_cost,
    'tier1_margin', v_t1_margin,
    'tier2_margin', v_t2_margin,
    'tier3_margin', v_t3_margin,
    'tier1_price', v_t1_price,
    'tier2_price', v_t2_price,
    'tier3_price', v_t3_price,
    'tier1_gross_margin', v_t1_gross,
    'tier2_gross_margin', v_t2_gross,
    'tier3_gross_margin', v_t3_gross
  );
END;
$function$;

REVOKE ALL ON FUNCTION public._calculate_product_pricing(
  text, numeric, numeric, numeric, numeric, numeric, numeric, numeric
) FROM PUBLIC, anon, authenticated, service_role;

DO $assertions$
DECLARE
  v_rejected boolean := false;
  v_legacy_result jsonb;
BEGIN
  BEGIN
    PERFORM public._calculate_product_pricing(
      'margin_driven', 0,
      0.20, 0.25, 0.30,
      10.00, 20.00, 30.00
    );
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM = 'PRICING_COST_INVALID' THEN
        v_rejected := true;
      ELSE
        RAISE;
      END IF;
  END;

  IF NOT v_rejected THEN
    RAISE EXCEPTION 'margin-driven zero cost unexpectedly passed';
  END IF;

  v_legacy_result := public._calculate_product_pricing(
    'legacy_margin', 0,
    0.20, 0.25, 0.30,
    10.00, 20.00, 30.00
  );

  IF (v_legacy_result->>'tier1_price')::numeric IS DISTINCT FROM 10.00
     OR (v_legacy_result->>'tier2_price')::numeric IS DISTINCT FROM 20.00
     OR (v_legacy_result->>'tier3_price')::numeric IS DISTINCT FROM 30.00 THEN
    RAISE EXCEPTION 'legacy zero-cost pricing behavior changed';
  END IF;

  IF has_function_privilege(
       'anon',
       'public._calculate_product_pricing(text,numeric,numeric,numeric,numeric,numeric,numeric,numeric)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public._calculate_product_pricing(text,numeric,numeric,numeric,numeric,numeric,numeric,numeric)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public._calculate_product_pricing(text,numeric,numeric,numeric,numeric,numeric,numeric,numeric)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'private pricing calculator execution grant survived';
  END IF;
END;
$assertions$;
