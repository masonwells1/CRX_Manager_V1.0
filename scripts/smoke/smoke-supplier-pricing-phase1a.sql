\set ON_ERROR_STOP on

SELECT set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
SET ROLE authenticated;

CREATE TEMP TABLE phase1a_proof (
  key text PRIMARY KEY,
  value jsonb NOT NULL
);

-- Direct browser pricing/history writes fail, while ordinary Product fields
-- and a pricing-free new Product remain editable.
DO $proof$
BEGIN
  BEGIN
    UPDATE public.products SET current_cost = 81.00 WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid;
    RAISE EXCEPTION 'SMOKE_FAIL: direct pricing update unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
  END;

  IF (SELECT current_cost FROM public.products WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid) IS DISTINCT FROM 80.00::numeric THEN
    RAISE EXCEPTION 'SMOKE_FAIL: denied direct pricing update changed data';
  END IF;

  UPDATE public.products
  SET notes = 'ordinary Product edit still works'
  WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid;
  IF (SELECT notes FROM public.products WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid)
       IS DISTINCT FROM 'ordinary Product edit still works' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: nonpricing Product update was not preserved';
  END IF;

  -- Rate/unit edits are ordinary Product maintenance. Their live trigger may
  -- derive new per-acre prices, but callers still cannot write those derived
  -- pricing columns directly.
  UPDATE public.products
  SET rate_per_acre = 17
  WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5'::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM public.products
    WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5'::uuid
      AND rate_per_acre = 17
      AND tier1_price_per_acre = 3.32
      AND pricing_version = 2
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: ordinary rate edit did not recalculate per-acre pricing/version';
  END IF;

  BEGIN
    UPDATE public.products
    SET tier1_price_per_acre = 999
    WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5'::uuid;
    RAISE EXCEPTION 'SMOKE_FAIL: direct per-acre pricing update unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
  END;
  IF NOT EXISTS (
    SELECT 1 FROM public.products
    WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5'::uuid
      AND tier1_price_per_acre = 3.32
      AND pricing_version = 2
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: denied per-acre write changed Product pricing/version';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.cost_history
    WHERE product_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5'::uuid
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: ordinary rate edit created core pricing history';
  END IF;

  INSERT INTO public.products(product_name, sku, notes)
  VALUES ('Phase 1a Shell Product', '004-SHELL', 'pricing intentionally blank');

  BEGIN
    INSERT INTO public.products(product_name, sku, current_cost)
    VALUES ('Forbidden Priced Product', '005-FORBIDDEN', 10.00);
    RAISE EXCEPTION 'SMOKE_FAIL: direct priced Product insert unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
  END;

  BEGIN
    INSERT INTO public.cost_history(product_id, changed_by, new_cost)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid, '11111111-1111-4111-8111-111111111111'::uuid, 81.00);
    RAISE EXCEPTION 'SMOKE_FAIL: frontend history insert unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
  END;
END;
$proof$;

-- Auth is fail-closed: active non-admins and forged actor IDs cannot use the
-- administrative pricing endpoints.
SELECT set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
DO $proof$
BEGIN
  BEGIN
    PERFORM public.create_pricing_workbook_export(
      ARRAY['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid], '22222222-2222-4222-8222-222222222222'::uuid, 'phase1a-nonadmin-export'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: non-admin export unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ADMIN_REQUIRED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: non-admin export failed for wrong reason: %', SQLERRM;
    END IF;
  END;
END;
$proof$;

SELECT set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
DO $proof$
BEGIN
  BEGIN
    PERFORM public.create_pricing_workbook_export(
      ARRAY['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid], '22222222-2222-4222-8222-222222222222'::uuid, 'phase1a-forged-actor'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: forged actor unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ACTOR_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: forged actor failed for wrong reason: %', SQLERRM;
    END IF;
  END;
END;
$proof$;

-- Full three-row worksheet: both margin-driven and price-driven rows preview together
-- and then apply atomically through the same server calculator.
INSERT INTO phase1a_proof(key, value)
VALUES (
  'export-main',
  public.create_pricing_workbook_export(
    ARRAY[
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'::uuid,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'::uuid
    ],
    '11111111-1111-4111-8111-111111111111'::uuid,
    'phase1a-export-main'
  )
);

INSERT INTO phase1a_proof(key, value)
SELECT
  'rows-main',
  jsonb_agg(
    r || CASE WHEN r->>'product_id' = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1' THEN
      jsonb_build_object(
        'pricing_mode', 'margin_driven',
        'new_cost', '90.00',
        'tier1_margin_percent', '20',
        'tier2_margin_percent', '25',
        'tier3_margin_percent', '30',
        'tier1_price', r->>'current_tier1_price',
        'tier2_price', r->>'current_tier2_price',
        'tier3_price', r->>'current_tier3_price',
        'change_reason', 'Monthly supplier worksheet',
        'has_formula', false,
        'formula_cells', '[]'::jsonb
      )
    WHEN r->>'product_id' = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2' THEN
      jsonb_build_object(
        'pricing_mode', 'price_driven',
        'new_cost', '60.00',
        'tier1_margin_percent', r->>'current_tier1_margin_percent',
        'tier2_margin_percent', r->>'current_tier2_margin_percent',
        'tier3_margin_percent', r->>'current_tier3_margin_percent',
        'tier1_price', '70.00',
        'tier2_price', '80.00',
        'tier3_price', '90.00',
        'change_reason', 'Monthly supplier worksheet',
        'has_formula', false,
        'formula_cells', '[]'::jsonb
      )
    ELSE
      jsonb_build_object(
        'pricing_mode', 'margin_driven',
        'new_cost', '45.00',
        'tier1_margin_percent', '20',
        'tier2_margin_percent', '25',
        'tier3_margin_percent', '30',
        'tier1_price', r->>'current_tier1_price',
        'tier2_price', r->>'current_tier2_price',
        'tier3_price', r->>'current_tier3_price',
        'change_reason', 'Third Product monthly update',
        'has_formula', false,
        'formula_cells', '[]'::jsonb
      )
    END
    ORDER BY r->>'product_id'
  )
FROM phase1a_proof e
CROSS JOIN LATERAL jsonb_array_elements(e.value->'rows') r
WHERE e.key = 'export-main';

INSERT INTO phase1a_proof(key, value)
SELECT
  'preview-main',
  public.preview_product_pricing_changes(
    'pricing_worksheet',
    (SELECT (value->>'export_id')::uuid FROM phase1a_proof WHERE key = 'export-main'),
    value,
    '11111111-1111-4111-8111-111111111111'::uuid,
    'phase1a-preview-main'
  )
FROM phase1a_proof
WHERE key = 'rows-main';

DO $proof$
DECLARE
  v_preview jsonb := (SELECT value FROM phase1a_proof WHERE key = 'preview-main');
  v_margin_effect jsonb;
  v_price_effect jsonb;
  v_third_effect jsonb;
BEGIN
  IF v_preview->>'status' <> 'previewed'
     OR (v_preview->>'apply_allowed')::boolean IS DISTINCT FROM true
     OR (v_preview->>'ready_count')::integer <> 3
     OR (v_preview->>'conflict_count')::integer <> 0
     OR (v_preview->>'invalid_count')::integer <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: valid worksheet preview summary wrong: %', v_preview;
  END IF;

  SELECT row_value->'effect' INTO v_margin_effect
  FROM jsonb_array_elements(v_preview->'rows') row_value
  WHERE row_value->>'product_id' = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  SELECT row_value->'effect' INTO v_price_effect
  FROM jsonb_array_elements(v_preview->'rows') row_value
  WHERE row_value->>'product_id' = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
  SELECT row_value->'effect' INTO v_third_effect
  FROM jsonb_array_elements(v_preview->'rows') row_value
  WHERE row_value->>'product_id' = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';

  IF v_margin_effect->>'cost' <> '90.00'
     OR v_margin_effect->>'tier1_price' <> '112.50'
     OR v_margin_effect->>'tier2_price' <> '120.00'
     OR v_margin_effect->>'tier3_price' <> '128.57' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: margin-driven preview math wrong: %', v_margin_effect;
  END IF;
  IF v_price_effect->>'cost' <> '60.00'
     OR v_price_effect->>'tier1_price' <> '70.00'
     OR v_price_effect->>'tier2_price' <> '80.00'
     OR v_price_effect->>'tier3_price' <> '90.00'
     OR v_price_effect->>'tier2_margin_percent' <> '25' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: price-driven preview math wrong: %', v_price_effect;
  END IF;
  IF v_third_effect->>'cost' <> '45.00'
     OR v_third_effect->>'tier1_price' <> '56.25'
     OR v_third_effect->>'tier2_price' <> '60.00'
     OR v_third_effect->>'tier3_price' <> '64.29' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: third Product preview math wrong: %', v_third_effect;
  END IF;
END;
$proof$;

INSERT INTO phase1a_proof(key, value)
SELECT
  'apply-main',
  public.apply_product_pricing_change_set(
    (value->>'change_set_id')::uuid,
    value->>'request_fingerprint',
    '11111111-1111-4111-8111-111111111111'::uuid,
    'phase1a-apply-main'
  )
FROM phase1a_proof
WHERE key = 'preview-main';

-- Force the replay through the durable applied change-set receipt rather than
-- the finite-lived shared idempotency cache.
RESET ROLE;
DELETE FROM public.idempotency_keys WHERE idempotency_key = 'phase1a-apply-main';
SET ROLE authenticated;

INSERT INTO phase1a_proof(key, value)
SELECT
  'apply-main-replay',
  public.apply_product_pricing_change_set(
    (value->>'change_set_id')::uuid,
    value->>'request_fingerprint',
    '11111111-1111-4111-8111-111111111111'::uuid,
    'phase1a-apply-main'
  )
FROM phase1a_proof
WHERE key = 'preview-main';

DO $proof$
BEGIN
  IF (SELECT value FROM phase1a_proof WHERE key = 'apply-main')
       IS DISTINCT FROM (SELECT value FROM phase1a_proof WHERE key = 'apply-main-replay') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: same-key apply replay did not return exact result';
  END IF;
  BEGIN
    PERFORM public.apply_product_pricing_change_set(
      (SELECT (value->>'change_set_id')::uuid FROM phase1a_proof WHERE key = 'preview-main'),
      (SELECT value->>'request_fingerprint' FROM phase1a_proof WHERE key = 'preview-main'),
      '11111111-1111-4111-8111-111111111111'::uuid,
      'phase1a-apply-main-new-key'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: applied change set accepted a new key';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'CHANGE_SET_ALREADY_APPLIED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: applied change set rejected for wrong reason: %', SQLERRM;
    END IF;
  END;
END;
$proof$;

-- After the finite cache row is gone, the original apply key is still bound
-- to its durable change set and cannot be reused for a different one.
INSERT INTO phase1a_proof(key, value)
SELECT 'reuse-key-before', jsonb_build_object(
  'cost', current_cost,
  'pricing_version', pricing_version,
  'history_count', (SELECT count(*) FROM public.cost_history WHERE product_id = p.id)
)
FROM public.products p
WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'::uuid;

INSERT INTO phase1a_proof(key, value)
SELECT 'preview-reuse-key', public.preview_product_pricing_changes(
  'product_page', NULL,
  jsonb_build_array(jsonb_build_object(
    'product_id', id,
    'row_version', pricing_version,
    'pricing_mode', 'margin_driven',
    'new_cost', '46.00',
    'tier1_margin_percent', '20',
    'tier2_margin_percent', '25',
    'tier3_margin_percent', '30',
    'change_reason', 'Durable apply-key binding proof'
  )),
  '11111111-1111-4111-8111-111111111111'::uuid,
  'phase1a-preview-reuse-key'
)
FROM public.products
WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'::uuid;

DO $proof$
BEGIN
  BEGIN
    PERFORM public.apply_product_pricing_change_set(
      (SELECT (value->>'change_set_id')::uuid FROM phase1a_proof WHERE key = 'preview-reuse-key'),
      (SELECT value->>'request_fingerprint' FROM phase1a_proof WHERE key = 'preview-reuse-key'),
      '11111111-1111-4111-8111-111111111111'::uuid,
      'phase1a-apply-main'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: apply key was rebound to a different change set';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REUSED_FOR_DIFFERENT_CHANGE_SET%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: cross-change-set key reuse failed for wrong reason: %', SQLERRM;
    END IF;
  END;

  IF (SELECT current_cost FROM public.products WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'::uuid)
       IS DISTINCT FROM (SELECT (value->>'cost')::numeric FROM phase1a_proof WHERE key = 'reuse-key-before')
     OR (SELECT pricing_version FROM public.products WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'::uuid)
       IS DISTINCT FROM (SELECT (value->>'pricing_version')::bigint FROM phase1a_proof WHERE key = 'reuse-key-before')
     OR (SELECT count(*) FROM public.cost_history WHERE product_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'::uuid)
       IS DISTINCT FROM (SELECT (value->>'history_count')::bigint FROM phase1a_proof WHERE key = 'reuse-key-before') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected cross-change-set key reuse left side effects';
  END IF;
END;
$proof$;

RESET ROLE;
DO $proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.products
    WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid AND current_cost = 90.00 AND tier1_price = 112.50
      AND tier2_price = 120.00 AND tier3_price = 128.57 AND pricing_version = 2
  ) OR NOT EXISTS (
    SELECT 1 FROM public.products
    WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'::uuid AND current_cost = 60.00 AND tier1_price = 70.00
      AND tier2_price = 80.00 AND tier3_price = 90.00 AND pricing_version = 2
  ) OR NOT EXISTS (
    SELECT 1 FROM public.products
    WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'::uuid AND current_cost = 45.00 AND tier1_price = 56.25
      AND tier2_price = 60.00 AND tier3_price = 64.29 AND pricing_version = 2
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: applied product pricing differs from preview';
  END IF;
  IF (SELECT count(*) FROM public.cost_history WHERE change_set_id =
        (SELECT (value->>'change_set_id')::uuid FROM phase1a_proof WHERE key = 'preview-main')) <> 3 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: sole history trigger did not write exactly one row per changed Product';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.cost_history
    WHERE change_set_id = (SELECT (value->>'change_set_id')::uuid FROM phase1a_proof WHERE key = 'preview-main')
      AND (change_source <> 'pricing_worksheet' OR changed_by <> '11111111-1111-4111-8111-111111111111'::uuid
           OR old_pricing_version <> 1 OR new_pricing_version <> 2)
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: pricing history provenance/version is wrong';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.cost_history
    WHERE change_set_id = (SELECT (value->>'change_set_id')::uuid FROM phase1a_proof WHERE key = 'preview-main')
      AND product_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid
      AND old_cost = 80.00 AND new_cost = 90.00
      AND old_tier1_price = 100.00 AND new_tier1_price = 112.50
      AND old_tier2_price = 106.67 AND new_tier2_price = 120.00
      AND old_tier3_price = 114.29 AND new_tier3_price = 128.57
      AND old_tier1_margin = 0.20 AND new_tier1_margin = 0.20
      AND old_tier2_margin = 0.25 AND new_tier2_margin = 0.25
      AND old_tier3_margin = 0.30 AND new_tier3_margin = 0.30
      AND change_note = 'Monthly supplier worksheet'
      AND change_reason = 'Monthly supplier worksheet'
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: margin-driven history snapshot is not exact';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.cost_history
    WHERE change_set_id = (SELECT (value->>'change_set_id')::uuid FROM phase1a_proof WHERE key = 'preview-main')
      AND product_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'::uuid
      AND old_cost = 50.00 AND new_cost = 60.00
      AND old_tier1_price = 55.56 AND new_tier1_price = 70.00
      AND old_tier2_price = 62.50 AND new_tier2_price = 80.00
      AND old_tier3_price = 71.43 AND new_tier3_price = 90.00
      AND old_tier1_margin = 0.10 AND new_tier1_margin = 0.14285714
      AND old_tier2_margin = 0.20 AND new_tier2_margin = 0.25
      AND old_tier3_margin = 0.30 AND new_tier3_margin = 0.33333333
      AND change_note = 'Monthly supplier worksheet'
      AND change_reason = 'Monthly supplier worksheet'
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: price-driven history snapshot is not exact';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.cost_history
    WHERE change_set_id = (SELECT (value->>'change_set_id')::uuid FROM phase1a_proof WHERE key = 'preview-main')
      AND product_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'::uuid
      AND old_cost = 40.00 AND new_cost = 45.00
      AND old_tier1_price = 50.00 AND new_tier1_price = 56.25
      AND old_tier2_price = 53.33 AND new_tier2_price = 60.00
      AND old_tier3_price = 57.14 AND new_tier3_price = 64.29
      AND old_tier1_margin = 0.20 AND new_tier1_margin = 0.20
      AND old_tier2_margin = 0.25 AND new_tier2_margin = 0.25
      AND old_tier3_margin = 0.30 AND new_tier3_margin = 0.30
      AND change_note = 'Third Product monthly update'
      AND change_reason = 'Third Product monthly update'
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: third Product history snapshot is not exact';
  END IF;
END;
$proof$;

SET ROLE authenticated;

-- A same-value Product-page submission is a visible no-op and cannot apply.
INSERT INTO phase1a_proof(key, value)
SELECT 'preview-noop', public.preview_product_pricing_changes(
  'product_page', NULL,
  jsonb_build_array(jsonb_build_object(
    'product_id', id,
    'row_version', pricing_version,
    'pricing_mode', 'margin_driven',
    'new_cost', '90.00',
    'tier1_margin_percent', '20',
    'tier2_margin_percent', '25',
    'tier3_margin_percent', '30',
    'change_reason', 'No-op proof'
  )),
  '11111111-1111-4111-8111-111111111111'::uuid,
  'phase1a-preview-noop'
)
FROM public.products WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid;

DO $proof$
DECLARE v_preview jsonb := (SELECT value FROM phase1a_proof WHERE key = 'preview-noop');
BEGIN
  IF v_preview->>'status' <> 'no_changes'
     OR (v_preview->>'apply_allowed')::boolean IS DISTINCT FROM false
     OR (v_preview->>'unchanged_count')::integer <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: no-op preview contract wrong: %', v_preview;
  END IF;
END;
$proof$;

-- Capture a workbook baseline, then make the everyday Product-page cost edit
-- through the same preview/apply engine. The old workbook must conflict loudly.
INSERT INTO phase1a_proof(key, value)
VALUES (
  'export-conflict',
  public.create_pricing_workbook_export(
    ARRAY['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid], '11111111-1111-4111-8111-111111111111'::uuid, 'phase1a-export-conflict'
  )
);

INSERT INTO phase1a_proof(key, value)
SELECT 'preview-product-page', public.preview_product_pricing_changes(
  'product_page', NULL,
  jsonb_build_array(jsonb_build_object(
    'product_id', id,
    'row_version', pricing_version,
    'pricing_mode', 'margin_driven',
    'new_cost', '91.00',
    'tier1_margin_percent', '20',
    'tier2_margin_percent', '25',
    'tier3_margin_percent', '30',
    'change_reason', 'Minor mid-month supplier increase'
  )),
  '11111111-1111-4111-8111-111111111111'::uuid,
  'phase1a-preview-product-page'
)
FROM public.products WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid;

INSERT INTO phase1a_proof(key, value)
SELECT 'apply-product-page', public.apply_product_pricing_change_set(
  (value->>'change_set_id')::uuid,
  value->>'request_fingerprint',
  '11111111-1111-4111-8111-111111111111'::uuid,
  'phase1a-apply-product-page'
)
FROM phase1a_proof WHERE key = 'preview-product-page';

INSERT INTO phase1a_proof(key, value)
SELECT 'rows-conflict', jsonb_agg(
  r || jsonb_build_object(
    'pricing_mode', '',
    'new_cost', r->>'current_cost',
    'tier1_margin_percent', r->>'current_tier1_margin_percent',
    'tier1_price', r->>'current_tier1_price',
    'tier2_margin_percent', r->>'current_tier2_margin_percent',
    'tier2_price', r->>'current_tier2_price',
    'tier3_margin_percent', r->>'current_tier3_margin_percent',
    'tier3_price', r->>'current_tier3_price',
    'change_reason', '',
    'has_formula', false,
    'formula_cells', '[]'::jsonb
  )
)
FROM phase1a_proof e
CROSS JOIN LATERAL jsonb_array_elements(e.value->'rows') r
WHERE e.key = 'export-conflict';

INSERT INTO phase1a_proof(key, value)
SELECT 'preview-conflict', public.preview_product_pricing_changes(
  'pricing_worksheet',
  (SELECT (value->>'export_id')::uuid FROM phase1a_proof WHERE key = 'export-conflict'),
  value,
  '11111111-1111-4111-8111-111111111111'::uuid,
  'phase1a-preview-conflict'
)
FROM phase1a_proof WHERE key = 'rows-conflict';

DO $proof$
DECLARE v_preview jsonb := (SELECT value FROM phase1a_proof WHERE key = 'preview-conflict');
BEGIN
  IF v_preview->>'status' <> 'invalid'
     OR (v_preview->>'conflict_count')::integer <> 1
     OR v_preview#>>'{rows,0,row_status}' <> 'conflict'
     OR v_preview#>>'{rows,0,error_code}' <> 'PRICING_ROW_CONFLICT'
     OR (v_preview->>'apply_allowed')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'SMOKE_FAIL: stale workbook did not return a deliberate conflict: %', v_preview;
  END IF;
END;
$proof$;

-- Formulas and protected identity edits are per-row invalid results, not a
-- silent parse or a transaction-wide disappearance.
INSERT INTO phase1a_proof(key, value)
VALUES (
  'export-invalid',
  public.create_pricing_workbook_export(
    ARRAY['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'::uuid], '11111111-1111-4111-8111-111111111111'::uuid, 'phase1a-export-invalid'
  )
);

INSERT INTO phase1a_proof(key, value)
SELECT 'row-formula', jsonb_build_array(
  r || jsonb_build_object(
    'pricing_mode', '', 'new_cost', r->>'current_cost',
    'tier1_margin_percent', r->>'current_tier1_margin_percent',
    'tier1_price', r->>'current_tier1_price',
    'tier2_margin_percent', r->>'current_tier2_margin_percent',
    'tier2_price', r->>'current_tier2_price',
    'tier3_margin_percent', r->>'current_tier3_margin_percent',
    'tier3_price', r->>'current_tier3_price',
    'change_reason', '', 'has_formula', true,
    'formula_cells', jsonb_build_array('new_cost')
  )
)
FROM phase1a_proof e
CROSS JOIN LATERAL jsonb_array_elements(e.value->'rows') r
WHERE e.key = 'export-invalid';

INSERT INTO phase1a_proof(key, value)
SELECT 'preview-formula', public.preview_product_pricing_changes(
  'pricing_worksheet',
  (SELECT (value->>'export_id')::uuid FROM phase1a_proof WHERE key = 'export-invalid'),
  value, '11111111-1111-4111-8111-111111111111'::uuid, 'phase1a-preview-formula'
)
FROM phase1a_proof WHERE key = 'row-formula';

DO $proof$
DECLARE v_preview jsonb := (SELECT value FROM phase1a_proof WHERE key = 'preview-formula');
BEGIN
  IF v_preview#>>'{rows,0,error_code}' <> 'WORKBOOK_FORMULA_REJECTED' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: formula was not rejected: %', v_preview;
  END IF;
END;
$proof$;

INSERT INTO phase1a_proof(key, value)
SELECT 'row-invalid-base', jsonb_build_array(
  r || jsonb_build_object(
    'pricing_mode', '', 'new_cost', r->>'current_cost',
    'tier1_margin_percent', r->>'current_tier1_margin_percent',
    'tier1_price', r->>'current_tier1_price',
    'tier2_margin_percent', r->>'current_tier2_margin_percent',
    'tier2_price', r->>'current_tier2_price',
    'tier3_margin_percent', r->>'current_tier3_margin_percent',
    'tier3_price', r->>'current_tier3_price',
    'change_reason', '', 'has_formula', false, 'formula_cells', '[]'::jsonb
  )
)
FROM phase1a_proof e
CROSS JOIN LATERAL jsonb_array_elements(e.value->'rows') r
WHERE e.key = 'export-invalid';

-- Duplicate Product IDs fail the whole request before any change set is stored.
DO $proof$
DECLARE
  v_row jsonb := (SELECT value->0 FROM phase1a_proof WHERE key = 'row-invalid-base');
BEGIN
  BEGIN
    PERFORM public.preview_product_pricing_changes(
      'pricing_worksheet',
      (SELECT (value->>'export_id')::uuid FROM phase1a_proof WHERE key = 'export-invalid'),
      jsonb_build_array(v_row, v_row),
      '11111111-1111-4111-8111-111111111111'::uuid,
      'phase1a-preview-duplicate-id'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: duplicate Product ID unexpectedly previewed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'PRICING_DUPLICATE_PRODUCT_ID%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: duplicate Product ID failed for wrong reason: %', SQLERRM;
    END IF;
  END;
END;
$proof$;

INSERT INTO phase1a_proof(key, value)
SELECT 'preview-identity-tamper', public.preview_product_pricing_changes(
  'pricing_worksheet',
  (SELECT (value->>'export_id')::uuid FROM phase1a_proof WHERE key = 'export-invalid'),
  jsonb_build_array((value->0) || jsonb_build_object('sku', 'TAMPERED-SKU')),
  '11111111-1111-4111-8111-111111111111'::uuid,
  'phase1a-preview-identity-tamper'
)
FROM phase1a_proof WHERE key = 'row-invalid-base';

INSERT INTO phase1a_proof(key, value)
SELECT 'preview-invalid-mode', public.preview_product_pricing_changes(
  'pricing_worksheet',
  (SELECT (value->>'export_id')::uuid FROM phase1a_proof WHERE key = 'export-invalid'),
  jsonb_build_array((value->0) || jsonb_build_object('pricing_mode', 'automatic')),
  '11111111-1111-4111-8111-111111111111'::uuid,
  'phase1a-preview-invalid-mode'
)
FROM phase1a_proof WHERE key = 'row-invalid-base';

INSERT INTO phase1a_proof(key, value)
SELECT 'preview-invalid-companion', public.preview_product_pricing_changes(
  'pricing_worksheet',
  (SELECT (value->>'export_id')::uuid FROM phase1a_proof WHERE key = 'export-invalid'),
  jsonb_build_array((value->0) || jsonb_build_object(
    'pricing_mode', 'margin_driven',
    'tier1_price', '999.00'
  )),
  '11111111-1111-4111-8111-111111111111'::uuid,
  'phase1a-preview-invalid-companion'
)
FROM phase1a_proof WHERE key = 'row-invalid-base';

INSERT INTO phase1a_proof(key, value)
SELECT 'preview-locale-money', public.preview_product_pricing_changes(
  'pricing_worksheet',
  (SELECT (value->>'export_id')::uuid FROM phase1a_proof WHERE key = 'export-invalid'),
  jsonb_build_array((value->0) || jsonb_build_object(
    'pricing_mode', 'margin_driven',
    'new_cost', '60,00'
  )),
  '11111111-1111-4111-8111-111111111111'::uuid,
  'phase1a-preview-locale-money'
)
FROM phase1a_proof WHERE key = 'row-invalid-base';

INSERT INTO phase1a_proof(key, value)
SELECT 'preview-blank-required', public.preview_product_pricing_changes(
  'pricing_worksheet',
  (SELECT (value->>'export_id')::uuid FROM phase1a_proof WHERE key = 'export-invalid'),
  jsonb_build_array((value->0) || jsonb_build_object(
    'pricing_mode', 'margin_driven',
    'new_cost', ''
  )),
  '11111111-1111-4111-8111-111111111111'::uuid,
  'phase1a-preview-blank-required'
)
FROM phase1a_proof WHERE key = 'row-invalid-base';

INSERT INTO phase1a_proof(key, value)
SELECT 'preview-zero-cost-margin', public.preview_product_pricing_changes(
  'pricing_worksheet',
  (SELECT (value->>'export_id')::uuid FROM phase1a_proof WHERE key = 'export-invalid'),
  jsonb_build_array((value->0) || jsonb_build_object(
    'pricing_mode', 'margin_driven',
    'new_cost', '0.00'
  )),
  '11111111-1111-4111-8111-111111111111'::uuid,
  'phase1a-preview-zero-cost-margin'
)
FROM phase1a_proof WHERE key = 'row-invalid-base';

DO $proof$
BEGIN
  IF (SELECT value#>>'{rows,0,error_code}' FROM phase1a_proof WHERE key = 'preview-identity-tamper')
       <> 'WORKBOOK_IDENTITY_OR_BASELINE_TAMPERED' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: protected workbook identity edit was not rejected: %',
      (SELECT value FROM phase1a_proof WHERE key = 'preview-identity-tamper');
  END IF;
  IF (SELECT value#>>'{rows,0,error_code}' FROM phase1a_proof WHERE key = 'preview-invalid-mode')
       <> 'PRICING_MODE_INVALID' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: invalid pricing mode was not rejected: %',
      (SELECT value FROM phase1a_proof WHERE key = 'preview-invalid-mode');
  END IF;
  IF (SELECT value#>>'{rows,0,error_code}' FROM phase1a_proof WHERE key = 'preview-invalid-companion')
       <> 'MARGIN_DRIVEN_COMPANION_FIELDS_CHANGED' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: invalid pricing-mode companion fields were not rejected: %',
      (SELECT value FROM phase1a_proof WHERE key = 'preview-invalid-companion');
  END IF;
  IF (SELECT value#>>'{rows,0,error_code}' FROM phase1a_proof WHERE key = 'preview-locale-money')
       <> 'PRICING_DOLLARS_INVALID' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: locale-ambiguous money was not rejected: %',
      (SELECT value FROM phase1a_proof WHERE key = 'preview-locale-money');
  END IF;
  IF (SELECT value#>>'{rows,0,error_code}' FROM phase1a_proof WHERE key = 'preview-blank-required')
       <> 'PRICING_DOLLARS_INVALID' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: blank required cost was not rejected: %',
      (SELECT value FROM phase1a_proof WHERE key = 'preview-blank-required');
  END IF;
  IF (SELECT value#>>'{rows,0,error_code}' FROM phase1a_proof WHERE key = 'preview-zero-cost-margin')
       <> 'PRICING_COST_INVALID' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: zero-cost margin-driven pricing was not rejected: %',
      (SELECT value FROM phase1a_proof WHERE key = 'preview-zero-cost-margin');
  END IF;
END;
$proof$;

-- Blank protected/product-pricing fields survive a normal Excel-style empty
-- string round-trip and remain an unchanged row.
INSERT INTO phase1a_proof(key, value)
VALUES (
  'export-blank',
  public.create_pricing_workbook_export(
    ARRAY['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4'::uuid],
    '11111111-1111-4111-8111-111111111111'::uuid,
    'phase1a-export-blank'
  )
);

INSERT INTO phase1a_proof(key, value)
SELECT 'row-blank', jsonb_build_array(
  r || jsonb_build_object(
    'pricing_mode', '', 'new_cost', r->>'current_cost',
    'tier1_margin_percent', r->>'current_tier1_margin_percent',
    'tier1_price', r->>'current_tier1_price',
    'tier2_margin_percent', r->>'current_tier2_margin_percent',
    'tier2_price', r->>'current_tier2_price',
    'tier3_margin_percent', r->>'current_tier3_margin_percent',
    'tier3_price', r->>'current_tier3_price',
    'change_reason', '', 'has_formula', false, 'formula_cells', '[]'::jsonb
  )
)
FROM phase1a_proof e
CROSS JOIN LATERAL jsonb_array_elements(e.value->'rows') r
WHERE e.key = 'export-blank';

INSERT INTO phase1a_proof(key, value)
SELECT 'preview-blank', public.preview_product_pricing_changes(
  'pricing_worksheet',
  (SELECT (value->>'export_id')::uuid FROM phase1a_proof WHERE key = 'export-blank'),
  value, '11111111-1111-4111-8111-111111111111'::uuid, 'phase1a-preview-blank'
)
FROM phase1a_proof WHERE key = 'row-blank';

DO $proof$
DECLARE
  v_export_row jsonb := (
    SELECT value#>'{rows,0}' FROM phase1a_proof WHERE key = 'export-blank'
  );
  v_preview jsonb := (SELECT value FROM phase1a_proof WHERE key = 'preview-blank');
BEGIN
  IF v_export_row->>'sku' <> ''
     OR v_export_row->>'category' <> ''
     OR v_export_row->>'current_cost' <> ''
     OR v_export_row->>'current_tier1_price' <> '' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: blank workbook values were not normalized: %', v_export_row;
  END IF;
  IF v_preview->>'status' <> 'no_changes'
     OR v_preview#>>'{rows,0,row_status}' <> 'unchanged' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: blank workbook round-trip failed: %', v_preview;
  END IF;
END;
$proof$;

-- Regression: delimiter-joined identities collide for (A|B,C) versus
-- (A,B|C). The JSON-based fingerprint must still detect this edit.
UPDATE public.products
SET sku = 'A|B', product_name = 'C'
WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4'::uuid;

INSERT INTO phase1a_proof(key, value)
SELECT 'preview-identity-delimiter', public.preview_product_pricing_changes(
  'product_page', NULL,
  jsonb_build_array(jsonb_build_object(
    'product_id', id,
    'row_version', pricing_version,
    'pricing_mode', 'margin_driven',
    'new_cost', '10.00',
    'tier1_margin_percent', '20',
    'tier2_margin_percent', '25',
    'tier3_margin_percent', '30',
    'change_reason', 'Delimiter collision regression'
  )),
  '11111111-1111-4111-8111-111111111111'::uuid,
  'phase1a-preview-identity-delimiter'
)
FROM public.products
WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4'::uuid;

UPDATE public.products
SET sku = 'A', product_name = 'B|C'
WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4'::uuid;

DO $proof$
BEGIN
  BEGIN
    PERFORM public.apply_product_pricing_change_set(
      (SELECT (value->>'change_set_id')::uuid FROM phase1a_proof WHERE key = 'preview-identity-delimiter'),
      (SELECT value->>'request_fingerprint' FROM phase1a_proof WHERE key = 'preview-identity-delimiter'),
      '11111111-1111-4111-8111-111111111111'::uuid,
      'phase1a-apply-identity-delimiter'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: delimiter-collision identity edit unexpectedly applied';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'PRICING_ROW_CONFLICT%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: delimiter identity collision failed for wrong reason: %', SQLERRM;
    END IF;
  END;

  IF EXISTS (
    SELECT 1 FROM public.products
    WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4'::uuid
      AND current_cost IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: delimiter identity conflict changed pricing';
  END IF;
END;
$proof$;

-- Two previews from one export may exist, but once one applies and consumes
-- the export, the second can never replay it.
INSERT INTO phase1a_proof(key, value)
VALUES (
  'export-consume',
  public.create_pricing_workbook_export(
    ARRAY['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'::uuid], '11111111-1111-4111-8111-111111111111'::uuid, 'phase1a-export-consume'
  )
);

INSERT INTO phase1a_proof(key, value)
SELECT 'rows-consume', jsonb_build_array(
  r || jsonb_build_object(
    'pricing_mode', 'price_driven', 'new_cost', '61.00',
    'tier1_margin_percent', r->>'current_tier1_margin_percent',
    'tier1_price', '71.00',
    'tier2_margin_percent', r->>'current_tier2_margin_percent',
    'tier2_price', '81.00',
    'tier3_margin_percent', r->>'current_tier3_margin_percent',
    'tier3_price', '91.00',
    'change_reason', 'Consume export proof',
    'has_formula', false, 'formula_cells', '[]'::jsonb
  )
)
FROM phase1a_proof e
CROSS JOIN LATERAL jsonb_array_elements(e.value->'rows') r
WHERE e.key = 'export-consume';

INSERT INTO phase1a_proof(key, value)
SELECT 'preview-consume-a', public.preview_product_pricing_changes(
  'pricing_worksheet',
  (SELECT (value->>'export_id')::uuid FROM phase1a_proof WHERE key = 'export-consume'),
  value, '11111111-1111-4111-8111-111111111111'::uuid, 'phase1a-preview-consume-a'
)
FROM phase1a_proof WHERE key = 'rows-consume';

INSERT INTO phase1a_proof(key, value)
SELECT 'preview-consume-b', public.preview_product_pricing_changes(
  'pricing_worksheet',
  (SELECT (value->>'export_id')::uuid FROM phase1a_proof WHERE key = 'export-consume'),
  value, '11111111-1111-4111-8111-111111111111'::uuid, 'phase1a-preview-consume-b'
)
FROM phase1a_proof WHERE key = 'rows-consume';

INSERT INTO phase1a_proof(key, value)
SELECT 'apply-consume-a', public.apply_product_pricing_change_set(
  (value->>'change_set_id')::uuid,
  value->>'request_fingerprint', '11111111-1111-4111-8111-111111111111'::uuid, 'phase1a-apply-consume-a'
)
FROM phase1a_proof WHERE key = 'preview-consume-a';

DO $proof$
BEGIN
  BEGIN
    PERFORM public.apply_product_pricing_change_set(
      (SELECT (value->>'change_set_id')::uuid FROM phase1a_proof WHERE key = 'preview-consume-b'),
      (SELECT value->>'request_fingerprint' FROM phase1a_proof WHERE key = 'preview-consume-b'),
      '11111111-1111-4111-8111-111111111111'::uuid,
      'phase1a-apply-consume-b'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: consumed export replay unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'WORKBOOK_EXPORT_CONSUMED_OR_EXPIRED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: consumed export rejected for wrong reason: %', SQLERRM;
    END IF;
  END;
END;
$proof$;

-- A nonpricing identity edit does not increment pricing_version, so apply must
-- also recheck the retained identity fingerprint under the Product locks.
INSERT INTO phase1a_proof(key, value)
SELECT 'identity-before', jsonb_build_object(
  'cost', current_cost,
  'pricing_version', pricing_version,
  'history_count', (SELECT count(*) FROM public.cost_history WHERE product_id = p.id)
)
FROM public.products p
WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'::uuid;

INSERT INTO phase1a_proof(key, value)
SELECT 'preview-identity-change', public.preview_product_pricing_changes(
  'product_page', NULL,
  jsonb_build_array(jsonb_build_object(
    'product_id', id, 'row_version', pricing_version,
    'pricing_mode', 'price_driven', 'new_cost', '63.00',
    'tier1_price', '73.00', 'tier2_price', '83.00', 'tier3_price', '93.00',
    'change_reason', 'Identity concurrency proof'
  )),
  '11111111-1111-4111-8111-111111111111'::uuid,
  'phase1a-preview-identity-change'
)
FROM public.products
WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'::uuid;

UPDATE public.products
SET sku = '002-PRICE-RENAMED'
WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'::uuid;

DO $proof$
BEGIN
  BEGIN
    PERFORM public.apply_product_pricing_change_set(
      (SELECT (value->>'change_set_id')::uuid FROM phase1a_proof WHERE key = 'preview-identity-change'),
      (SELECT value->>'request_fingerprint' FROM phase1a_proof WHERE key = 'preview-identity-change'),
      '11111111-1111-4111-8111-111111111111'::uuid,
      'phase1a-apply-identity-change'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: identity-stale change set unexpectedly applied';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'PRICING_ROW_CONFLICT%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: identity-stale apply failed for wrong reason: %', SQLERRM;
    END IF;
  END;

  IF (SELECT current_cost FROM public.products WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'::uuid)
       IS DISTINCT FROM (SELECT (value->>'cost')::numeric FROM phase1a_proof WHERE key = 'identity-before')
     OR (SELECT pricing_version FROM public.products WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'::uuid)
       IS DISTINCT FROM (SELECT (value->>'pricing_version')::bigint FROM phase1a_proof WHERE key = 'identity-before')
     OR (SELECT count(*) FROM public.cost_history WHERE product_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'::uuid)
       IS DISTINCT FROM (SELECT (value->>'history_count')::bigint FROM phase1a_proof WHERE key = 'identity-before') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: identity-stale apply changed pricing or history';
  END IF;
END;
$proof$;

-- An overlapping two-row inline batch is all-or-nothing at apply time.
INSERT INTO phase1a_proof(key, value)
SELECT 'p2-before-atomic', jsonb_build_object(
  'cost', current_cost,
  'tier1_price', tier1_price,
  'pricing_version', pricing_version
)
FROM public.products WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'::uuid;

INSERT INTO phase1a_proof(key, value)
SELECT 'preview-atomic', public.preview_product_pricing_changes(
  'products_inline', NULL,
  jsonb_agg(CASE WHEN id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid THEN
    jsonb_build_object(
      'product_id', id, 'row_version', pricing_version,
      'pricing_mode', 'margin_driven', 'new_cost', '92.00',
      'tier1_margin_percent', '20', 'tier2_margin_percent', '25',
      'tier3_margin_percent', '30', 'change_reason', 'Atomic batch proof'
    )
  ELSE
    jsonb_build_object(
      'product_id', id, 'row_version', pricing_version,
      'pricing_mode', 'price_driven', 'new_cost', '62.00',
      'tier1_price', '72.00', 'tier2_price', '82.00', 'tier3_price', '92.00',
      'change_reason', 'Atomic batch proof'
    )
  END ORDER BY id),
  '11111111-1111-4111-8111-111111111111'::uuid,
  'phase1a-preview-atomic'
)
FROM public.products WHERE id IN ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'::uuid);

INSERT INTO phase1a_proof(key, value)
SELECT 'preview-intervening', public.preview_product_pricing_changes(
  'product_page', NULL,
  jsonb_build_array(jsonb_build_object(
    'product_id', id, 'row_version', pricing_version,
    'pricing_mode', 'margin_driven', 'new_cost', '93.00',
    'tier1_margin_percent', '20', 'tier2_margin_percent', '25',
    'tier3_margin_percent', '30', 'change_reason', 'Intervening edit'
  )),
  '11111111-1111-4111-8111-111111111111'::uuid,
  'phase1a-preview-intervening'
)
FROM public.products WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid;

INSERT INTO phase1a_proof(key, value)
SELECT 'apply-intervening', public.apply_product_pricing_change_set(
  (value->>'change_set_id')::uuid,
  value->>'request_fingerprint', '11111111-1111-4111-8111-111111111111'::uuid, 'phase1a-apply-intervening'
)
FROM phase1a_proof WHERE key = 'preview-intervening';

DO $proof$
BEGIN
  BEGIN
    PERFORM public.apply_product_pricing_change_set(
      (SELECT (value->>'change_set_id')::uuid FROM phase1a_proof WHERE key = 'preview-atomic'),
      (SELECT value->>'request_fingerprint' FROM phase1a_proof WHERE key = 'preview-atomic'),
      '11111111-1111-4111-8111-111111111111'::uuid,
      'phase1a-apply-atomic'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: stale atomic batch unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'PRICING_ROW_CONFLICT%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: stale atomic batch failed for wrong reason: %', SQLERRM;
    END IF;
  END;

  IF (SELECT current_cost FROM public.products WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'::uuid)
       IS DISTINCT FROM (SELECT (value->>'cost')::numeric FROM phase1a_proof WHERE key = 'p2-before-atomic')
     OR (SELECT tier1_price FROM public.products WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'::uuid)
       IS DISTINCT FROM (SELECT (value->>'tier1_price')::numeric FROM phase1a_proof WHERE key = 'p2-before-atomic')
     OR (SELECT pricing_version FROM public.products WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'::uuid)
       IS DISTINCT FROM (SELECT (value->>'pricing_version')::bigint FROM phase1a_proof WHERE key = 'p2-before-atomic') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: stale atomic batch partially changed its unaffected row';
  END IF;
END;
$proof$;

RESET ROLE;

DO $proof$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.cost_history h
    GROUP BY h.change_set_id, h.product_id
    HAVING h.change_set_id IS NOT NULL AND count(*) <> 1
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: duplicate history rows exist for one change-set/Product';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.products
    WHERE current_cost IS NOT NULL AND round(current_cost, 2) IS DISTINCT FROM current_cost
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: governed pricing stored sub-cent dollars';
  END IF;
END;
$proof$;

SELECT 'PHASE1A_SMOKE_PASS' AS proof_result;
