\set ON_ERROR_STOP on

BEGIN;

CREATE TEMP TABLE phase2_proof (key text PRIMARY KEY, value jsonb NOT NULL);
GRANT ALL ON phase2_proof TO authenticated;

DO $proof$
BEGIN
  IF (SELECT setting_value FROM public.app_settings
      WHERE setting_key = 'supplier_cost_basis_enabled') <> 'false' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: Phase 2 feature flag did not default off';
  END IF;
  IF (SELECT count(*) FROM public.product_cost_basis WHERE effective_to IS NULL) <> 4 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: existing Product costs were not baselined exactly once';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.product_cost_basis b
    JOIN public.products p ON p.id = b.product_id
    WHERE b.effective_to IS NULL
      AND b.cost_cents <> round(p.current_cost * 100)::bigint
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: baseline cost basis changed Product money';
  END IF;
  IF has_table_privilege('authenticated', 'public.product_cost_basis', 'SELECT') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: authenticated retained direct basis ledger access';
  END IF;
END;
$proof$;

SELECT set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
SET ROLE authenticated;

DO $proof$
BEGIN
  BEGIN
    PERFORM public.preview_product_cost_basis_changes(
      'product_page', NULL,
      jsonb_build_array(jsonb_build_object(
        'product_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        'row_version', 1,
        'pricing_mode', 'margin_driven',
        'new_cost', '90.00',
        'tier1_margin_percent', '20',
        'tier2_margin_percent', '25',
        'tier3_margin_percent', '30',
        'change_reason', 'disabled supplier proof',
        'basis_type', 'selected_supplier_price',
        'basis_source', 'supplier_pricing',
        'basis_reason', 'disabled supplier proof',
        'basis_selection', true,
        'supplier_price_observation_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5'
      )),
      '11111111-1111-4111-8111-111111111111', 'phase2-disabled-preview'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: supplier selection worked while flag was off';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'SUPPLIER_COST_BASIS_DISABLED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: off flag failed for wrong reason: %', SQLERRM;
    END IF;
  END;
END;
$proof$;

-- While the flag is off, the deployed Phase 1a editor remains compatible and
-- its governed cost update must append a matching manual basis atomically.
INSERT INTO phase2_proof(key, value)
VALUES ('legacy-off-preview', public.preview_product_pricing_changes(
  'product_page', NULL,
  jsonb_build_array(jsonb_build_object(
    'product_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
    'row_version', 1,
    'pricing_mode', 'margin_driven',
    'new_cost', '105.00',
    'tier1_margin_percent', '20',
    'tier2_margin_percent', '25',
    'tier3_margin_percent', '30',
    'change_reason', 'default-off legacy bypass proof'
  )),
  '11111111-1111-4111-8111-111111111111', 'phase2-legacy-off-preview'
));

INSERT INTO phase2_proof(key, value)
SELECT 'legacy-off-apply', public.apply_product_pricing_change_set(
  (value->>'change_set_id')::uuid, value->>'request_fingerprint',
  '11111111-1111-4111-8111-111111111111', 'phase2-legacy-off-apply'
)
FROM phase2_proof WHERE key = 'legacy-off-preview';

RESET ROLE;
DO $proof$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.product_cost_basis b
    JOIN public.products p ON p.id = b.product_id
    WHERE b.product_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'::uuid
      AND b.effective_to IS NULL
      AND b.cost_cents <> round(p.current_cost * 100)::bigint
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: default-off legacy rejection left basis drift';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.product_cost_basis
    WHERE product_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'::uuid
      AND effective_to IS NULL
      AND basis_type = 'manual_override'
      AND cost_cents = 10500
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: default-off legacy apply did not append its basis';
  END IF;
END;
$proof$;
SET ROLE authenticated;

INSERT INTO phase2_proof(key, value)
VALUES ('manual-preview', public.preview_product_cost_basis_changes(
  'product_page', NULL,
  jsonb_build_array(jsonb_build_object(
    'product_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    'row_version', 1,
    'pricing_mode', 'margin_driven',
    'new_cost', '90.00',
    'tier1_margin_percent', '20',
    'tier2_margin_percent', '25',
    'tier3_margin_percent', '30',
    'change_reason', 'Phase 2 manual wrapper proof',
    'basis_type', 'manual_override',
    'basis_source', 'product_page',
    'basis_reason', 'Phase 2 manual wrapper proof',
    'basis_selection', false
  )),
  '11111111-1111-4111-8111-111111111111', 'phase2-manual-preview'
));

DO $proof$
DECLARE v jsonb := (SELECT value FROM phase2_proof WHERE key = 'manual-preview');
BEGIN
  IF v->>'status' <> 'previewed' OR (v->>'basis_change_count')::int <> 1
     OR (v->>'apply_allowed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_FAIL: manual wrapper preview wrong: %', v;
  END IF;
END;
$proof$;

INSERT INTO phase2_proof(key, value)
SELECT 'manual-apply', public.apply_product_cost_basis_change_set(
  (value->>'change_set_id')::uuid,
  value->>'request_fingerprint',
  '11111111-1111-4111-8111-111111111111',
  'phase2-manual-apply'
)
FROM phase2_proof WHERE key = 'manual-preview';

RESET ROLE;
DO $proof$
DECLARE v jsonb := (SELECT value FROM phase2_proof WHERE key = 'manual-apply');
BEGIN
  IF v->>'status' <> 'applied' OR jsonb_array_length(v->'cost_basis_rows') <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: manual wrapper apply wrong: %', v;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.products
    WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid
      AND current_cost = 90 AND tier1_price = 112.50
      AND tier2_price = 120 AND tier3_price = 128.57
      AND pricing_version = 2
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: shared pricing engine money result drifted';
  END IF;
  IF (SELECT count(*) FROM public.product_cost_basis
      WHERE product_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid
        AND effective_to IS NULL) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: active basis uniqueness drifted';
  END IF;
END;
$proof$;

UPDATE public.app_settings SET setting_value = 'true'
WHERE setting_key = 'supplier_cost_basis_enabled';

-- The migration backfills only same-inventory-unit legacy PO lines and the
-- receipt trigger captures that same fact for future app-created lines.
DO $proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.purchase_order_items
    WHERE id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2'::uuid
      AND inventory_units_per_supplier_unit_snapshot = 1
      AND cost_provenance = 'legacy'
      AND cost_snapshot_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: same-unit legacy PO cost was not backfilled';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.purchase_order_items
    WHERE id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc7'::uuid
      AND inventory_units_per_supplier_unit_snapshot IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: unreceived legacy PO line was backfilled';
  END IF;
END;
$proof$;

-- A pre-migration open line can still be edited before receipt. Changing its
-- unit to a supplier package must remain unresolved, proving no stale snapshot
-- was attached by the backfill.
UPDATE public.purchase_order_items SET unit_size = 'case'
WHERE id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc7'::uuid;
UPDATE public.purchase_order_items SET quantity_received = 1
WHERE id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc7'::uuid;
DO $proof$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.purchase_order_items
    WHERE id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc7'::uuid
      AND inventory_units_per_supplier_unit_snapshot IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: edited unreceived PO retained a stale snapshot';
  END IF;
END;
$proof$;

INSERT INTO public.purchase_orders(
  id, po_number, vendor, status, submitted_date, created_by
) VALUES (
  'cccccccc-cccc-4ccc-8ccc-ccccccccccc3', 'PO-PHASE2-FUTURE',
  'Phase 2 Future Supplier', 'submitted', current_date,
  '11111111-1111-4111-8111-111111111111'
);
INSERT INTO public.purchase_order_items(
  id, purchase_order_id, product_id, quantity_received, unit_cost, unit_size
) VALUES
  (
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc4',
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc3',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 0, 50, 'gal'
  ),
  (
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc5',
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc3',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 0, 500, 'case'
  );
UPDATE public.purchase_order_items SET quantity_received = 1
WHERE id IN (
  'cccccccc-cccc-4ccc-8ccc-ccccccccccc4'::uuid,
  'cccccccc-cccc-4ccc-8ccc-ccccccccccc5'::uuid
);

DO $proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.purchase_order_items
    WHERE id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc4'::uuid
      AND inventory_units_per_supplier_unit_snapshot = 1
      AND cost_provenance = 'manual'
      AND cost_snapshot_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: future same-unit receipt snapshot was not captured';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.purchase_order_items
    WHERE id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc5'::uuid
      AND inventory_units_per_supplier_unit_snapshot IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: mismatched supplier package unit was guessed';
  END IF;
  BEGIN
    UPDATE public.purchase_order_items
    SET unit_cost = 55
    WHERE id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc4'::uuid;
    RAISE EXCEPTION 'SMOKE_FAIL: received PO cost-defining fields were mutable';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'RECEIVED_PO_COST_SNAPSHOT_IMMUTABLE%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: received snapshot failed for wrong reason: %', SQLERRM;
    END IF;
  END;
END;
$proof$;

-- A fully reversed receipt may be edited again, but that edit must discard the
-- old snapshot so a later receipt cannot reuse stale cost provenance.
UPDATE public.purchase_order_items SET quantity_received = 0
WHERE id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc4'::uuid;
UPDATE public.purchase_order_items SET unit_size = 'case'
WHERE id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc4'::uuid;
UPDATE public.purchase_order_items SET quantity_received = 1
WHERE id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc4'::uuid;
DO $proof$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.purchase_order_items
    WHERE id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc4'::uuid
      AND (
        inventory_units_per_supplier_unit_snapshot IS NOT NULL
        OR cost_provenance IS NOT NULL
        OR cost_snapshot_at IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: reversed-and-edited PO retained stale provenance';
  END IF;
END;
$proof$;

INSERT INTO public.vendors(id, name)
VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'Phase 2 Supplier');
INSERT INTO public.product_supplier_links(
  id, product_id, vendor_id, supplier_sku, supplier_product_name,
  supplier_uom, supplier_pack_description,
  inventory_units_per_supplier_unit, comparison_status, link_status, created_by
) VALUES (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
  'SUP-001', 'Phase 2 Margin Product', 'case', '2 inventory units per case',
  2, 'comparable', 'confirmed', '11111111-1111-4111-8111-111111111111'
);
INSERT INTO public.supplier_price_imports(id, vendor_id, created_by)
VALUES (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
  '11111111-1111-4111-8111-111111111111'
);
INSERT INTO public.supplier_price_import_rows(id, import_id)
VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3');
INSERT INTO public.supplier_price_observations(
  id, product_id, vendor_id, product_supplier_link_id, import_id, import_row_id,
  price_kind, cost_cents, price_unit, package_quantity, effective_from, created_by
) VALUES (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4',
  'quote', 18000, 'case', 1, current_date, '11111111-1111-4111-8111-111111111111'
);
SET ROLE authenticated;

INSERT INTO phase2_proof(key, value)
VALUES ('purchase-preview', public.preview_product_cost_basis_changes(
  'product_page', NULL,
  jsonb_build_array(jsonb_build_object(
    'product_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
    'row_version', 1,
    'pricing_mode', 'margin_driven',
    'new_cost', '40.00',
    'tier1_margin_percent', '20',
    'tier2_margin_percent', '25',
    'tier3_margin_percent', '30',
    'change_reason', 'Select received purchase cost',
    'basis_type', 'actual_purchase',
    'basis_source', 'product_page',
    'basis_reason', 'Select received purchase cost',
    'basis_selection', true,
    'purchase_order_item_id', 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2'
  )),
  '11111111-1111-4111-8111-111111111111', 'phase2-purchase-preview'
));

INSERT INTO phase2_proof(key, value)
SELECT 'purchase-apply', public.apply_product_cost_basis_change_set(
  (value->>'change_set_id')::uuid, value->>'request_fingerprint',
  '11111111-1111-4111-8111-111111111111', 'phase2-purchase-apply'
)
FROM phase2_proof WHERE key = 'purchase-preview';

RESET ROLE;
DO $proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.product_cost_basis
    WHERE product_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'::uuid
      AND effective_to IS NULL
      AND basis_type = 'actual_purchase'
      AND cost_cents = 4000
      AND purchase_order_item_id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2'::uuid
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: actual-purchase basis was not selectable';
  END IF;
END;
$proof$;
SET ROLE authenticated;

INSERT INTO phase2_proof(key, value)
VALUES ('supplier-preview', public.preview_product_cost_basis_changes(
  'product_page', NULL,
  jsonb_build_array(jsonb_build_object(
    'product_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    'row_version', 2,
    'pricing_mode', 'margin_driven',
    'new_cost', '90.00',
    'tier1_margin_percent', '20',
    'tier2_margin_percent', '25',
    'tier3_margin_percent', '30',
    'change_reason', 'Select comparable supplier quote',
    'basis_type', 'selected_supplier_price',
    'basis_source', 'supplier_pricing',
    'basis_reason', 'Select comparable supplier quote',
    'basis_selection', true,
    'supplier_price_observation_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5'
  )),
  '11111111-1111-4111-8111-111111111111', 'phase2-supplier-preview'
));

INSERT INTO phase2_proof(key, value)
VALUES ('supplier-stale-preview', public.preview_product_cost_basis_changes(
  'product_page', NULL,
  jsonb_build_array(jsonb_build_object(
    'product_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    'row_version', 2,
    'pricing_mode', 'margin_driven',
    'new_cost', '90.00',
    'tier1_margin_percent', '20',
    'tier2_margin_percent', '25',
    'tier3_margin_percent', '30',
    'change_reason', 'Concurrent stale supplier quote',
    'basis_type', 'selected_supplier_price',
    'basis_source', 'supplier_pricing',
    'basis_reason', 'Concurrent stale supplier quote',
    'basis_selection', true,
    'supplier_price_observation_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5'
  )),
  '11111111-1111-4111-8111-111111111111', 'phase2-supplier-stale-preview'
));

DO $proof$
DECLARE v jsonb := (SELECT value FROM phase2_proof WHERE key = 'supplier-preview');
BEGIN
  IF v->>'status' <> 'no_changes' OR (v->>'basis_change_count')::int <> 1
     OR (v->>'apply_allowed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_FAIL: same-dollar basis preview wrong: %', v;
  END IF;
END;
$proof$;

INSERT INTO phase2_proof(key, value)
SELECT 'supplier-apply', public.apply_product_cost_basis_change_set(
  (value->>'change_set_id')::uuid, value->>'request_fingerprint',
  '11111111-1111-4111-8111-111111111111', 'phase2-supplier-apply'
)
FROM phase2_proof WHERE key = 'supplier-preview';

RESET ROLE;
DO $proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.product_cost_basis
    WHERE product_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid
      AND effective_to IS NULL
      AND basis_type = 'selected_supplier_price'
      AND cost_cents = 9000
      AND supplier_price_observation_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5'::uuid
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: supplier provenance was not selected';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.products
    WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid
      AND current_cost = 90 AND pricing_version = 2
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: basis-only selection changed Product pricing';
  END IF;
END;
$proof$;

SET ROLE authenticated;

-- A same-dollar workbook selection is basis-only (`no_changes`) but must still
-- consume the retained export exactly once.
INSERT INTO phase2_proof(key, value)
VALUES ('workbook-export', public.create_pricing_workbook_export(
  ARRAY['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid],
  '11111111-1111-4111-8111-111111111111',
  'phase2-workbook-export'
));

INSERT INTO phase2_proof(key, value)
SELECT 'workbook-basis-preview', public.preview_product_cost_basis_changes(
  'pricing_worksheet', (value->>'export_id')::uuid,
  jsonb_build_array(
    (value->'rows'->0) || jsonb_build_object(
      'has_formula', false,
      'formula_cells', '[]'::jsonb,
      'pricing_mode', 'margin_driven',
      'new_cost', '90.00',
      'tier1_margin_percent', '20',
      'tier2_margin_percent', '25',
      'tier3_margin_percent', '30',
      'change_reason', 'Workbook basis-only selection',
      'basis_type', 'selected_supplier_price',
      'basis_source', 'pricing_worksheet',
      'basis_reason', 'Workbook basis-only selection',
      'basis_selection', true,
      'supplier_price_observation_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5'
    )
  ),
  '11111111-1111-4111-8111-111111111111',
  'phase2-workbook-basis-preview'
)
FROM phase2_proof WHERE key = 'workbook-export';

DO $proof$
DECLARE v jsonb := (SELECT value FROM phase2_proof WHERE key = 'workbook-basis-preview');
BEGIN
  IF v->>'status' <> 'no_changes' OR (v->>'basis_change_count')::int <> 1
     OR (v->>'apply_allowed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_FAIL: workbook basis-only preview wrong: %', v;
  END IF;
END;
$proof$;

INSERT INTO phase2_proof(key, value)
SELECT 'workbook-basis-apply', public.apply_product_cost_basis_change_set(
  (value->>'change_set_id')::uuid, value->>'request_fingerprint',
  '11111111-1111-4111-8111-111111111111', 'phase2-workbook-basis-apply'
)
FROM phase2_proof WHERE key = 'workbook-basis-preview';

RESET ROLE;
DO $proof$
DECLARE v_export_id uuid := (
  SELECT (value->>'export_id')::uuid FROM phase2_proof WHERE key = 'workbook-export'
);
BEGIN
  IF (SELECT status FROM public.pricing_workbook_exports WHERE id = v_export_id)
     IS DISTINCT FROM 'consumed' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: basis-only workbook export was not consumed';
  END IF;
END;
$proof$;
SET ROLE authenticated;

DO $proof$
DECLARE
  v_workspace jsonb := public.get_product_cost_basis_workspace(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
  );
  v_history jsonb := public.get_product_price_history(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
  );
BEGIN
  IF (v_workspace->>'enabled')::boolean IS DISTINCT FROM true
     OR v_workspace->'current_basis'->>'basis_type' <> 'selected_supplier_price'
     OR jsonb_array_length(v_workspace->'supplier_candidates') <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: cost-basis workspace reader wrong: %', v_workspace;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_history->'points') point
    WHERE point->>'stream' = 'selected_cost_basis'
      AND point->>'detail' = 'selected_supplier_price'
      AND point->>'supplier_name' = 'Phase 2 Supplier'
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: selected basis missing from Product history: %', v_history;
  END IF;
END;
$proof$;

DO $proof$
DECLARE v jsonb := (SELECT value FROM phase2_proof WHERE key = 'supplier-stale-preview');
BEGIN
  BEGIN
    PERFORM public.apply_product_cost_basis_change_set(
      (v->>'change_set_id')::uuid, v->>'request_fingerprint',
      '11111111-1111-4111-8111-111111111111', 'phase2-supplier-stale-apply'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: stale same-dollar basis selection overwrote a newer selection';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'PRICING_ROW_CONFLICT%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: stale basis failed for wrong reason: %', SQLERRM;
    END IF;
  END;
END;
$proof$;

INSERT INTO phase2_proof(key, value)
VALUES ('deleted-vendor-preview', public.preview_product_cost_basis_changes(
  'product_page', NULL,
  jsonb_build_array(jsonb_build_object(
    'product_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    'row_version', 2,
    'pricing_mode', 'margin_driven',
    'new_cost', '90.00',
    'tier1_margin_percent', '20',
    'tier2_margin_percent', '25',
    'tier3_margin_percent', '30',
    'change_reason', 'Deleted vendor stale evidence proof',
    'basis_type', 'selected_supplier_price',
    'basis_source', 'supplier_pricing',
    'basis_reason', 'Deleted vendor stale evidence proof',
    'basis_selection', true,
    'supplier_price_observation_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5'
  )),
  '11111111-1111-4111-8111-111111111111', 'phase2-deleted-vendor-preview'
));

RESET ROLE;
UPDATE public.vendors SET deleted_at = now()
WHERE id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
SET ROLE authenticated;
DO $proof$
DECLARE v jsonb := (SELECT value FROM phase2_proof WHERE key = 'deleted-vendor-preview');
BEGIN
  BEGIN
    PERFORM public.apply_product_cost_basis_change_set(
      (v->>'change_set_id')::uuid, v->>'request_fingerprint',
      '11111111-1111-4111-8111-111111111111', 'phase2-deleted-vendor-apply'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: deleted-vendor evidence remained selectable';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'SUPPLIER_COST_BASIS_NOT_COMPARABLE%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: deleted-vendor evidence failed for wrong reason: %', SQLERRM;
    END IF;
  END;
END;
$proof$;

-- Prove the old Phase 1a apply path also remains blocked after enablement.
INSERT INTO phase2_proof(key, value)
VALUES ('legacy-preview', public.preview_product_pricing_changes(
  'product_page', NULL,
  jsonb_build_array(jsonb_build_object(
    'product_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    'row_version', 2,
    'pricing_mode', 'margin_driven',
    'new_cost', '95.00',
    'tier1_margin_percent', '20',
    'tier2_margin_percent', '25',
    'tier3_margin_percent', '30',
    'change_reason', 'legacy bypass proof'
  )),
  '11111111-1111-4111-8111-111111111111', 'phase2-legacy-preview'
));

DO $proof$
DECLARE v jsonb := (SELECT value FROM phase2_proof WHERE key = 'legacy-preview');
BEGIN
  BEGIN
    PERFORM public.apply_product_pricing_change_set(
      (v->>'change_set_id')::uuid, v->>'request_fingerprint',
      '11111111-1111-4111-8111-111111111111', 'phase2-legacy-apply'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: legacy pricing apply bypassed Phase 2';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'PRODUCT_COST_BASIS_CONTEXT_REQUIRED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: legacy bypass failed for wrong reason: %', SQLERRM;
    END IF;
  END;
END;
$proof$;

RESET ROLE;
INSERT INTO public.profiles(id, email, full_name, role, is_active)
VALUES ('33333333-3333-4333-8333-333333333333', 'phase2-user@example.invalid', 'Phase 2 User', 'sales_rep', true);
SELECT set_config('request.jwt.claim.sub', '33333333-3333-4333-8333-333333333333', false);
SET ROLE authenticated;
DO $proof$
BEGIN
  BEGIN
    PERFORM public.get_product_cost_basis_workspace('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');
    RAISE EXCEPTION 'SMOKE_FAIL: non-admin read cost-basis workspace';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ADMIN_REQUIRED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: non-admin failed for wrong reason: %', SQLERRM;
    END IF;
  END;
END;
$proof$;

ROLLBACK;
SELECT 'SMOKE_PASS_ROLLBACK supplier_cost_basis_phase2' AS result;
