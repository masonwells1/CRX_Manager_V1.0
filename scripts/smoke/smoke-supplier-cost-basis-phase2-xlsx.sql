\set ON_ERROR_STOP on

BEGIN;

CREATE TEMP TABLE phase2_xlsx_proof (
  key text PRIMARY KEY,
  value jsonb NOT NULL
);
GRANT ALL ON phase2_xlsx_proof TO authenticated;

INSERT INTO phase2_xlsx_proof(key, value)
VALUES ('payload', pg_read_file('/tmp/phase2-workbook-payload.json')::jsonb);

DO $proof$
DECLARE v_payload jsonb := (SELECT value FROM phase2_xlsx_proof WHERE key = 'payload');
BEGIN
  IF v_payload->>'formatVersion' <> 'crx-product-pricing-phase2-v2'
     OR (v_payload->>'rowCount')::integer <> 3
     OR jsonb_array_length(v_payload->'rows') <> 3
     OR (SELECT count(*) FROM jsonb_array_elements(v_payload->'rows') row_value
         WHERE row_value->>'pricing_mode' = 'margin_driven') <> 2
     OR (SELECT count(*) FROM jsonb_array_elements(v_payload->'rows') row_value
         WHERE row_value->>'pricing_mode' = 'price_driven') <> 1
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_payload->'rows') row_value
                WHERE (row_value->>'has_formula')::boolean
                   OR jsonb_array_length(row_value->'formula_cells') <> 0) THEN
    RAISE EXCEPTION 'PHASE2_XLSX_FAIL: parsed supplier-evidence workbook contract drifted: %', v_payload;
  END IF;
END;
$proof$;

SELECT set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
SET ROLE authenticated;

INSERT INTO phase2_xlsx_proof(key, value)
SELECT 'preview', public.preview_product_cost_basis_changes(
  'pricing_worksheet',
  ((SELECT value FROM phase2_xlsx_proof WHERE key = 'payload')->>'exportId')::uuid,
  (SELECT value->'rows' FROM phase2_xlsx_proof WHERE key = 'payload'),
  '11111111-1111-4111-8111-111111111111'::uuid,
  'phase2-xlsx-current-wrapper-preview'
);

DO $proof$
DECLARE v_preview jsonb := (SELECT value FROM phase2_xlsx_proof WHERE key = 'preview');
BEGIN
  IF v_preview->>'status' <> 'previewed'
     OR (v_preview->>'submitted_row_count')::integer <> 3
     OR (v_preview->>'ready_count')::integer <> 3
     OR (v_preview->>'pricing_change_count')::integer <> 3
     OR (v_preview->>'basis_change_count')::integer <> 3
     OR (v_preview->>'apply_allowed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PHASE2_XLSX_FAIL: current wrapper preview drifted: %', v_preview;
  END IF;
END;
$proof$;

INSERT INTO phase2_xlsx_proof(key, value)
SELECT 'apply', public.apply_product_cost_basis_change_set(
  (value->>'change_set_id')::uuid,
  value->>'request_fingerprint',
  '11111111-1111-4111-8111-111111111111'::uuid,
  'phase2-xlsx-current-wrapper-apply'
)
FROM phase2_xlsx_proof
WHERE key = 'preview';

RESET ROLE;

DO $proof$
DECLARE
  v_preview jsonb := (SELECT value FROM phase2_xlsx_proof WHERE key = 'preview');
  v_apply jsonb := (SELECT value FROM phase2_xlsx_proof WHERE key = 'apply');
  v_change_set_id uuid := (v_preview->>'change_set_id')::uuid;
  v_export_id uuid := ((SELECT value FROM phase2_xlsx_proof WHERE key = 'payload')->>'exportId')::uuid;
BEGIN
  IF v_apply->>'status' <> 'applied' OR (v_apply->>'applied_count')::integer <> 3 THEN
    RAISE EXCEPTION 'PHASE2_XLSX_FAIL: current wrapper apply drifted: %', v_apply;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.products
    WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid
      AND current_cost = 90.01 AND tier1_price = 112.51
      AND tier2_price = 120.01 AND tier3_price = 128.59
  ) OR NOT EXISTS (
    SELECT 1 FROM public.products
    WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'::uuid
      AND current_cost = 60.99 AND tier1_price = 70.01
      AND tier2_price = 80.99 AND tier3_price = 90.01
  ) OR NOT EXISTS (
    SELECT 1 FROM public.products
    WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'::uuid
      AND current_cost = 45.99 AND tier1_price = 57.49
      AND tier2_price = 61.32 AND tier3_price = 65.70
  ) THEN
    RAISE EXCEPTION 'PHASE2_XLSX_FAIL: Product cents/prices drifted';
  END IF;
  IF (SELECT count(*) FROM public.cost_history
      WHERE change_set_id = v_change_set_id) <> 3 THEN
    RAISE EXCEPTION 'PHASE2_XLSX_FAIL: expected exactly 3 scoped cost history rows';
  END IF;
  IF (SELECT count(*) FROM public.product_cost_basis
      WHERE pricing_change_set_id = v_change_set_id
        AND basis_type = 'manual_override'
        AND selection_source = 'pricing_worksheet') <> 3
     OR NOT EXISTS (
       SELECT 1 FROM public.product_cost_basis
       WHERE pricing_change_set_id = v_change_set_id
         AND product_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid
         AND cost_cents = 9001 AND reason = 'Monthly supplier worksheet'
     ) OR NOT EXISTS (
       SELECT 1 FROM public.product_cost_basis
       WHERE pricing_change_set_id = v_change_set_id
         AND product_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'::uuid
         AND cost_cents = 6099 AND reason = 'Monthly supplier worksheet'
     ) OR NOT EXISTS (
       SELECT 1 FROM public.product_cost_basis
       WHERE pricing_change_set_id = v_change_set_id
         AND product_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'::uuid
         AND cost_cents = 4599 AND reason = 'Third Product monthly update'
     ) THEN
    RAISE EXCEPTION 'PHASE2_XLSX_FAIL: scoped manual-override basis rows drifted';
  END IF;
  IF (SELECT status FROM public.pricing_workbook_exports WHERE id = v_export_id)
       IS DISTINCT FROM 'consumed' THEN
    RAISE EXCEPTION 'PHASE2_XLSX_FAIL: export was not consumed inside the transaction';
  END IF;
  IF (SELECT setting_value FROM public.app_settings
      WHERE setting_key = 'supplier_cost_basis_enabled') IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'PHASE2_XLSX_FAIL: supplier-cost-basis flag changed';
  END IF;
END;
$proof$;

ROLLBACK;
SELECT 'PHASE2_XLSX_CURRENT_WRAPPERS_PASS_ROLLBACK' AS proof_result;
