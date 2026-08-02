\set ON_ERROR_STOP on

BEGIN;

CREATE TEMP TABLE phase1a_xlsx_proof (
  key text PRIMARY KEY,
  value jsonb NOT NULL
);

INSERT INTO phase1a_xlsx_proof(key, value)
VALUES ('payload', pg_read_file('/tmp/phase1a-workbook-payload.json')::jsonb);
GRANT ALL ON phase1a_xlsx_proof TO authenticated;

SELECT set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
SET ROLE authenticated;

DO $proof$
DECLARE
  v_payload jsonb := (SELECT value FROM phase1a_xlsx_proof WHERE key = 'payload');
BEGIN
  IF v_payload->>'formatVersion' <> 'crx-product-pricing-phase2-v2'
     OR (v_payload->>'rowCount')::integer <> 3
     OR jsonb_array_length(v_payload->'rows') <> 3 THEN
    RAISE EXCEPTION 'XLSX_SMOKE_FAIL: parser payload contract is wrong: %', v_payload;
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(v_payload->'rows') row_value
      WHERE row_value->>'pricing_mode' = 'margin_driven') <> 2
     OR (SELECT count(*) FROM jsonb_array_elements(v_payload->'rows') row_value
         WHERE row_value->>'pricing_mode' = 'price_driven') <> 1 THEN
    RAISE EXCEPTION 'XLSX_SMOKE_FAIL: parser did not preserve both pricing modes';
  END IF;
END;
$proof$;

SAVEPOINT before_deliberate_conflict;

INSERT INTO phase1a_xlsx_proof(key, value)
SELECT 'intervening-preview', public.preview_product_pricing_changes(
  'product_page', NULL,
  jsonb_build_array(jsonb_build_object(
    'product_id', id,
    'row_version', pricing_version,
    'pricing_mode', 'margin_driven',
    'new_cost', '51.00',
    'tier1_margin_percent', '10',
    'tier2_margin_percent', '20',
    'tier3_margin_percent', '30',
    'change_reason', 'Deliberate conflict proof'
  )),
  '11111111-1111-4111-8111-111111111111'::uuid,
  'phase1a-xlsx-intervening-preview'
)
FROM public.products
WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'::uuid;

INSERT INTO phase1a_xlsx_proof(key, value)
SELECT 'intervening-apply', public.apply_product_pricing_change_set(
  (value->>'change_set_id')::uuid,
  value->>'request_fingerprint',
  '11111111-1111-4111-8111-111111111111'::uuid,
  'phase1a-xlsx-intervening-apply'
)
FROM phase1a_xlsx_proof WHERE key = 'intervening-preview';

INSERT INTO phase1a_xlsx_proof(key, value)
SELECT 'conflict-preview', public.preview_product_pricing_changes(
  'pricing_worksheet',
  ((SELECT value FROM phase1a_xlsx_proof WHERE key = 'payload')->>'exportId')::uuid,
  (SELECT value->'rows' FROM phase1a_xlsx_proof WHERE key = 'payload'),
  '11111111-1111-4111-8111-111111111111'::uuid,
  'phase1a-xlsx-conflict-preview'
);

DO $proof$
DECLARE
  v_preview jsonb := (SELECT value FROM phase1a_xlsx_proof WHERE key = 'conflict-preview');
BEGIN
  IF v_preview->>'status' <> 'invalid'
     OR (v_preview->>'apply_allowed')::boolean IS DISTINCT FROM false
     OR (v_preview->>'conflict_count')::integer <> 1
     OR NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_preview->'rows') row_value
       WHERE row_value->>'product_id' = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
         AND row_value->>'error_code' = 'PRICING_ROW_CONFLICT'
     ) THEN
    RAISE EXCEPTION 'XLSX_SMOKE_FAIL: deliberate workbook conflict was not caught: %', v_preview;
  END IF;
END;
$proof$;

ROLLBACK TO SAVEPOINT before_deliberate_conflict;

INSERT INTO phase1a_xlsx_proof(key, value)
SELECT 'ready-preview', public.preview_product_pricing_changes(
  'pricing_worksheet',
  ((SELECT value FROM phase1a_xlsx_proof WHERE key = 'payload')->>'exportId')::uuid,
  (SELECT value->'rows' FROM phase1a_xlsx_proof WHERE key = 'payload'),
  '11111111-1111-4111-8111-111111111111'::uuid,
  'phase1a-xlsx-ready-preview'
);

DO $proof$
DECLARE
  v_preview jsonb := (SELECT value FROM phase1a_xlsx_proof WHERE key = 'ready-preview');
BEGIN
  IF v_preview->>'status' <> 'previewed'
     OR (v_preview->>'apply_allowed')::boolean IS DISTINCT FROM true
     OR (v_preview->>'ready_count')::integer <> 3
     OR (v_preview->>'conflict_count')::integer <> 0
     OR (v_preview->>'invalid_count')::integer <> 0 THEN
    RAISE EXCEPTION 'XLSX_SMOKE_FAIL: valid workbook did not preview cleanly: %', v_preview;
  END IF;
END;
$proof$;

INSERT INTO phase1a_xlsx_proof(key, value)
SELECT 'apply-result', public.apply_product_pricing_change_set(
  (value->>'change_set_id')::uuid,
  value->>'request_fingerprint',
  '11111111-1111-4111-8111-111111111111'::uuid,
  'phase1a-xlsx-real-apply'
)
FROM phase1a_xlsx_proof WHERE key = 'ready-preview';

INSERT INTO phase1a_xlsx_proof(key, value)
SELECT 'apply-replay', public.apply_product_pricing_change_set(
  (value->>'change_set_id')::uuid,
  value->>'request_fingerprint',
  '11111111-1111-4111-8111-111111111111'::uuid,
  'phase1a-xlsx-real-apply'
)
FROM phase1a_xlsx_proof WHERE key = 'ready-preview';

RESET ROLE;

DO $proof$
DECLARE
  v_change_set_id uuid := (
    SELECT (value->>'change_set_id')::uuid FROM phase1a_xlsx_proof WHERE key = 'ready-preview'
  );
BEGIN
  IF (SELECT value FROM phase1a_xlsx_proof WHERE key = 'apply-result')
       IS DISTINCT FROM (SELECT value FROM phase1a_xlsx_proof WHERE key = 'apply-replay') THEN
    RAISE EXCEPTION 'XLSX_SMOKE_FAIL: exact apply replay did not return the saved result';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.products
    WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid
      AND current_cost = 90.01 AND tier1_price = 112.51
      AND tier2_price = 120.01 AND tier3_price = 128.59 AND pricing_version = 2
  ) OR NOT EXISTS (
    SELECT 1 FROM public.products
    WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'::uuid
      AND current_cost = 60.99 AND tier1_price = 70.01
      AND tier2_price = 80.99 AND tier3_price = 90.01 AND pricing_version = 2
  ) OR NOT EXISTS (
    SELECT 1 FROM public.products
    WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'::uuid
      AND current_cost = 45.99 AND tier1_price = 57.49
      AND tier2_price = 61.32 AND tier3_price = 65.70 AND pricing_version = 2
  ) THEN
    RAISE EXCEPTION 'XLSX_SMOKE_FAIL: real apply rows differ from the parsed workbook preview';
  END IF;
  IF (SELECT count(*) FROM public.cost_history WHERE change_set_id = v_change_set_id) <> 3 THEN
    RAISE EXCEPTION 'XLSX_SMOKE_FAIL: history trigger did not write exactly 3 rows';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.cost_history
    WHERE change_set_id = v_change_set_id
      AND (change_source <> 'pricing_worksheet'
           OR changed_by <> '11111111-1111-4111-8111-111111111111'::uuid
           OR old_pricing_version <> 1 OR new_pricing_version <> 2)
  ) THEN
    RAISE EXCEPTION 'XLSX_SMOKE_FAIL: history provenance/version data is wrong';
  END IF;
END;
$proof$;

SELECT 'PHASE1A_XLSX_REAL_DB_PASS' AS proof_result;
ROLLBACK;
