\set ON_ERROR_STOP on

-- This proof runs after the additive forward correction but before the strict
-- frontend cutover. It verifies that the correction is independently safe to
-- apply while the currently deployed legacy Product form is still live.

BEGIN;
RESET ROLE;
DO $proof$
DECLARE
  v_rejected boolean := false;
BEGIN
  BEGIN
    PERFORM public._calculate_product_pricing(
      'legacy_margin', 1.001,
      0.20, 0.25, 0.30,
      10.00, 20.00, 30.00
    );
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'PRICING_COST_INVALID' THEN
      v_rejected := true;
    ELSE
      RAISE;
    END IF;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FORWARD_CORRECTION_FAIL: sub-cent cost was accepted';
  END IF;
END;
$proof$;

SELECT set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
SET ROLE authenticated;

CREATE TEMP TABLE phase1a_forward_proof (
  key text PRIMARY KEY,
  value jsonb NOT NULL
);

INSERT INTO phase1a_forward_proof(key, value)
SELECT 'preview-zero-tier-fallback', public.preview_product_pricing_changes(
  'product_page', NULL,
  jsonb_build_array(jsonb_build_object(
    'product_id', id,
    'row_version', pricing_version,
    'pricing_mode', 'price_driven',
    'new_cost', '0.00',
    'tier1_price', '10.00',
    'tier2_price', '0.00',
    'tier3_price', '0.00',
    'change_reason', 'Pre-cutover zero-tier fallback proof'
  )),
  '11111111-1111-4111-8111-111111111111'::uuid,
  'phase1a-forward-preview-zero-tier'
)
FROM public.products
WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5'::uuid;

DO $proof$
DECLARE
  v_effect jsonb := (
    SELECT value#>'{rows,0,effect}'
    FROM phase1a_forward_proof
    WHERE key = 'preview-zero-tier-fallback'
  );
BEGIN
  IF (v_effect->>'tier1_price_per_acre_cents')::bigint IS DISTINCT FROM 125
     OR (v_effect->>'tier2_price_per_acre_cents')::bigint IS DISTINCT FROM 125
     OR (v_effect->>'tier3_price_per_acre_cents')::bigint IS DISTINCT FROM 125 THEN
    RAISE EXCEPTION 'FORWARD_CORRECTION_FAIL: preview fallback mismatch: %', v_effect;
  END IF;
END;
$proof$;

INSERT INTO phase1a_forward_proof(key, value)
SELECT 'apply-zero-tier-fallback', public.apply_product_pricing_change_set(
  (value->>'change_set_id')::uuid,
  value->>'request_fingerprint',
  '11111111-1111-4111-8111-111111111111'::uuid,
  'phase1a-forward-apply-zero-tier'
)
FROM phase1a_forward_proof
WHERE key = 'preview-zero-tier-fallback';

DO $proof$
DECLARE
  v_product public.products%ROWTYPE;
BEGIN
  SELECT * INTO v_product
  FROM public.products
  WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5'::uuid;

  IF round(v_product.tier1_price_per_acre * 100)::bigint IS DISTINCT FROM 125
     OR round(v_product.tier2_price_per_acre * 100)::bigint IS DISTINCT FROM 125
     OR round(v_product.tier3_price_per_acre * 100)::bigint IS DISTINCT FROM 125 THEN
    RAISE EXCEPTION 'FORWARD_CORRECTION_FAIL: stored fallback disagrees with preview';
  END IF;
END;
$proof$;

-- Expire the shared-cache stand-in and prove the durable preview receipt still
-- returns the byte-for-byte original preview, even after the change set applied.
RESET ROLE;
DELETE FROM public.idempotency_keys
WHERE idempotency_key = 'phase1a-forward-preview-zero-tier'
  AND operation = 'preview_product_pricing_changes';
SET ROLE authenticated;

INSERT INTO phase1a_forward_proof(key, value)
SELECT 'preview-zero-tier-durable-replay', public.preview_product_pricing_changes(
  'product_page', NULL,
  jsonb_build_array(value#>'{rows,0,submitted_row}'),
  '11111111-1111-4111-8111-111111111111'::uuid,
  'phase1a-forward-preview-zero-tier'
)
FROM phase1a_forward_proof
WHERE key = 'preview-zero-tier-fallback';

DO $proof$
BEGIN
  IF (SELECT value FROM phase1a_forward_proof WHERE key = 'preview-zero-tier-durable-replay')
     IS DISTINCT FROM
     (SELECT value FROM phase1a_forward_proof WHERE key = 'preview-zero-tier-fallback') THEN
    RAISE EXCEPTION 'FORWARD_CORRECTION_FAIL: durable preview replay changed the original result';
  END IF;

  BEGIN
    PERFORM public.preview_product_pricing_changes(
      'product_page', NULL,
      jsonb_build_array(jsonb_set(
        (SELECT value#>'{rows,0,submitted_row}' FROM phase1a_forward_proof
         WHERE key = 'preview-zero-tier-fallback'),
        '{change_reason}', to_jsonb('mismatched durable retry'::text)
      )),
      '11111111-1111-4111-8111-111111111111'::uuid,
      'phase1a-forward-preview-zero-tier'
    );
    RAISE EXCEPTION 'FORWARD_CORRECTION_FAIL: mismatched durable preview retry succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FORWARD_CORRECTION_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM <> 'IDEMPOTENCY_PAYLOAD_MISMATCH' THEN
      RAISE EXCEPTION 'FORWARD_CORRECTION_FAIL: wrong durable-preview mismatch error: %', SQLERRM;
    END IF;
  END;
END;
$proof$;

INSERT INTO phase1a_forward_proof(key, value)
SELECT 'export-durable-original', public.create_pricing_workbook_export(
  ARRAY[id],
  '11111111-1111-4111-8111-111111111111'::uuid,
  'phase1a-forward-export-durable'
)
FROM public.products
WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5'::uuid;

RESET ROLE;
DELETE FROM public.idempotency_keys
WHERE idempotency_key = 'phase1a-forward-export-durable'
  AND operation = 'create_pricing_workbook_export';
SET ROLE authenticated;

INSERT INTO phase1a_forward_proof(key, value)
SELECT 'export-durable-replay', public.create_pricing_workbook_export(
  ARRAY[id],
  '11111111-1111-4111-8111-111111111111'::uuid,
  'phase1a-forward-export-durable'
)
FROM public.products
WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5'::uuid;

DO $proof$
BEGIN
  IF (SELECT value FROM phase1a_forward_proof WHERE key = 'export-durable-replay')
     IS DISTINCT FROM
     (SELECT value FROM phase1a_forward_proof WHERE key = 'export-durable-original') THEN
    RAISE EXCEPTION 'FORWARD_CORRECTION_FAIL: durable export replay changed the original result';
  END IF;

  BEGIN
    PERFORM public.create_pricing_workbook_export(
      NULL,
      '11111111-1111-4111-8111-111111111111'::uuid,
      'phase1a-forward-export-durable'
    );
    RAISE EXCEPTION 'FORWARD_CORRECTION_FAIL: mismatched durable export retry succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FORWARD_CORRECTION_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM <> 'IDEMPOTENCY_PAYLOAD_MISMATCH' THEN
      RAISE EXCEPTION 'FORWARD_CORRECTION_FAIL: wrong durable-export mismatch error: %', SQLERRM;
    END IF;
  END;
END;
$proof$;

SELECT set_config('crx.pricing_mode', '', true);
SELECT set_config('crx.pricing_authorized', '', true);
SELECT set_config('crx.pricing_actor', '', true);
SELECT set_config('crx.pricing_source', '', true);
SELECT set_config('crx.pricing_reason', '', true);
SELECT set_config('crx.pricing_change_set_id', '', true);

RESET ROLE;
INSERT INTO public.products(id, product_name, sku)
SELECT
  md5('phase1a-forward-limit-' || series)::uuid,
  'Phase 1a Forward Limit ' || series,
  'PHASE1A-FORWARD-LIMIT-' || lpad(series::text, 5, '0')
FROM generate_series(1, 5001) AS series;
SET ROLE authenticated;

DO $proof$
BEGIN
  BEGIN
    PERFORM public.create_pricing_workbook_export(
      ARRAY(
        SELECT id FROM public.products
        WHERE sku LIKE 'PHASE1A-FORWARD-LIMIT-%'
        ORDER BY sku
      ),
      '11111111-1111-4111-8111-111111111111'::uuid,
      'phase1a-forward-oversized-export'
    );
    RAISE EXCEPTION 'FORWARD_CORRECTION_FAIL: oversized export succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FORWARD_CORRECTION_FAIL:%' THEN RAISE; END IF;
    IF SQLSTATE <> '23514'
       OR SQLERRM NOT LIKE '%pricing_workbook_exports_row_limit%' THEN
      RAISE EXCEPTION 'FORWARD_CORRECTION_FAIL: wrong oversized-export error (%, %)', SQLSTATE, SQLERRM;
    END IF;
  END;
END;
$proof$;

RESET ROLE;
DELETE FROM public.products WHERE sku LIKE 'PHASE1A-FORWARD-LIMIT-%';

ROLLBACK;

SELECT 'PHASE1A_FORWARD_CORRECTION_PASS' AS proof_result;
