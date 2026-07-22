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

-- Product creation intentionally persists a pricing-free shell. Prove a row
-- created after the migration remains valid and receives no invented basis;
-- its first governed Phase 1a cost update below must create the initial basis.
INSERT INTO public.products(
  id, product_name, sku, category, container_size, unit_size, inventory_unit
) VALUES (
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',
  'Phase 2 Newly Created Product', 'P2-NEW', 'Herbicide', 1, 'gal', 'gal'
);

-- Dedicated complete-workbook follow-up fixtures. One Product deliberately has
-- no cost; the other has an existing cost and will receive a governed change.
INSERT INTO public.products(
  id, product_name, sku, category, container_size, unit_size, inventory_unit,
  current_cost, tier1_margin, tier2_margin, tier3_margin
) VALUES
  ('ffffffff-ffff-4fff-8fff-fffffffffff1',
   'Phase 2 Null Cost Workbook Product', 'P2-NULL', 'Herbicide', 1, 'gal', 'gal',
   NULL, NULL, NULL, NULL),
  ('ffffffff-ffff-4fff-8fff-fffffffffff2',
   'Phase 2 Changed Workbook Product', 'P2-CHANGE', 'Herbicide', 1, 'gal', 'gal',
   NULL, NULL, NULL, NULL);
DO $proof$
BEGIN
  IF (SELECT current_cost FROM public.products
      WHERE id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1'::uuid) IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM public.product_cost_basis
       WHERE product_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1'::uuid
     ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: pricing-free Product creation invented a cost basis';
  END IF;
END;
$proof$;

SELECT set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
SET ROLE authenticated;

-- Establish the changed fixture's starting cost through the live Phase 1a
-- governed path while the Phase 2 feature flag remains off.
INSERT INTO phase2_proof(key, value)
VALUES ('null-cost-workbook-setup-preview', public.preview_product_pricing_changes(
  'product_page', NULL,
  jsonb_build_array(jsonb_build_object(
    'product_id', 'ffffffff-ffff-4fff-8fff-fffffffffff2',
    'row_version', 1,
    'pricing_mode', 'margin_driven',
    'new_cost', '50.00',
    'tier1_margin_percent', '20',
    'tier2_margin_percent', '25',
    'tier3_margin_percent', '30',
    'change_reason', 'Null-cost workbook fixture setup'
  )),
  '11111111-1111-4111-8111-111111111111',
  'phase2-null-cost-workbook-setup-preview'
));
INSERT INTO phase2_proof(key, value)
SELECT 'null-cost-workbook-setup-apply', public.apply_product_pricing_change_set(
  (value->>'change_set_id')::uuid, value->>'request_fingerprint',
  '11111111-1111-4111-8111-111111111111',
  'phase2-null-cost-workbook-setup-apply'
)
FROM phase2_proof WHERE key = 'null-cost-workbook-setup-preview';

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
    'product_id', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',
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
    WHERE b.product_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1'::uuid
      AND b.effective_to IS NULL
      AND b.cost_cents <> round(p.current_cost * 100)::bigint
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: default-off legacy rejection left basis drift';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.product_cost_basis
    WHERE product_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1'::uuid
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

-- Migration-first safety: while the Phase 2 flag is off, the existing app may
-- still correct a partially received PO line. The edit must succeed and clear
-- the now-stale snapshot instead of silently preserving false provenance.
INSERT INTO public.purchase_orders(
  id, po_number, vendor, status, submitted_date, created_by
) VALUES (
  'cccccccc-cccc-4ccc-8ccc-ccccccccccc8', 'PO-PHASE2-FLAG-OFF',
  'Phase 2 Flag-Off Supplier', 'submitted', current_date,
  '11111111-1111-4111-8111-111111111111'
);
INSERT INTO public.purchase_order_items(
  id, purchase_order_id, product_id, quantity_received, unit_cost, unit_size
) VALUES (
  'cccccccc-cccc-4ccc-8ccc-ccccccccccc9',
  'cccccccc-cccc-4ccc-8ccc-ccccccccccc8',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 0, 50, 'gal'
);
UPDATE public.purchase_order_items SET quantity_received = 1
WHERE id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc9'::uuid;
UPDATE public.purchase_order_items SET unit_cost = 55
WHERE id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc9'::uuid;
DO $proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.purchase_order_items
    WHERE id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc9'::uuid
      AND unit_cost = 55
      AND inventory_units_per_supplier_unit_snapshot IS NULL
      AND inventory_unit_snapshot IS NULL
      AND cost_provenance IS NULL
      AND cost_snapshot_at IS NULL
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: flag-off received PO correction was blocked or retained stale provenance';
  END IF;
END;
$proof$;

-- The disposable smoke keeps all scenarios in one transaction, unlike real
-- RPC calls. Clear the transaction-local Phase 1a trigger marker before the
-- Phase 2 scenarios to model the real request boundary.
SELECT set_config('crx.cost_basis_legacy_sync', '', true);

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
      AND inventory_unit_snapshot = 'lb'
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

-- Direct callers cannot forge conversion provenance on insert or first
-- receipt. Both paths must discard the supplied factor and derive the safe
-- same-inventory-unit 1:1 snapshot on the server.
INSERT INTO public.purchase_order_items(
  id, purchase_order_id, product_id, quantity_received, unit_cost, unit_size,
  inventory_units_per_supplier_unit_snapshot, inventory_unit_snapshot,
  cost_provenance, cost_snapshot_at
) VALUES
  (
    'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc3',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 1, 50, 'gal',
    999, 'forged-unit', 'manual', now() - interval '1 year'
  ),
  (
    'dddddddd-dddd-4ddd-8ddd-ddddddddddd2',
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc3',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 0, 50, 'gal',
    999, 'forged-unit', 'manual', now() - interval '1 year'
  );
UPDATE public.purchase_order_items
SET quantity_received = 1,
    inventory_units_per_supplier_unit_snapshot = 777,
    inventory_unit_snapshot = 'forged-unit',
    cost_provenance = 'manual',
    cost_snapshot_at = now() - interval '1 year'
WHERE id = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2'::uuid;

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
      AND inventory_unit_snapshot = 'gal'
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
  IF (
    SELECT count(*) FROM public.purchase_order_items
    WHERE id IN (
      'dddddddd-dddd-4ddd-8ddd-ddddddddddd1'::uuid,
      'dddddddd-dddd-4ddd-8ddd-ddddddddddd2'::uuid
    )
      AND inventory_units_per_supplier_unit_snapshot = 1
      AND inventory_unit_snapshot = 'gal'
      AND cost_provenance = 'manual'
      AND cost_snapshot_at > now() - interval '1 minute'
  ) <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: caller-supplied PO snapshot provenance was trusted';
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
        OR inventory_unit_snapshot IS NOT NULL
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
  inventory_units_per_supplier_unit, conversion_unit,
  comparison_status, link_status, created_by
) VALUES (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
  'SUP-001', 'Phase 2 Margin Product', 'case', '2 inventory units per case',
  2, 'gal', 'comparable', 'confirmed', '11111111-1111-4111-8111-111111111111'
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
  'quote', 18000, 'case', 1,
  (now() AT TIME ZONE 'America/Chicago')::date,
  '11111111-1111-4111-8111-111111111111'
);
SET ROLE authenticated;

-- Supplier conversions are meaningful only for the Product unit they were
-- confirmed against. With governance enabled, an active basis blocks a direct
-- unit reinterpretation. A controlled flag-off correction invalidates the old
-- supplier evidence in workspace, history normalization, and preview.
RESET ROLE;
DO $proof$
BEGIN
  BEGIN
    UPDATE public.products SET inventory_unit = 'oz'
    WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid;
    RAISE EXCEPTION 'SMOKE_FAIL: governed Product unit changed while flag was on';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'PRODUCT_COST_BASIS_UNIT_CHANGE_REQUIRES_FLAG_OFF%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: governed unit change failed for wrong reason: %', SQLERRM;
    END IF;
  END;
END;
$proof$;

UPDATE public.app_settings SET setting_value = 'false'
WHERE setting_key = 'supplier_cost_basis_enabled';
UPDATE public.products SET inventory_unit = 'oz'
WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid;
UPDATE public.app_settings SET setting_value = 'true'
WHERE setting_key = 'supplier_cost_basis_enabled';
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
  IF jsonb_array_length(v_workspace->'supplier_candidates') <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: stale supplier unit remained in workspace: %', v_workspace;
  END IF;
  IF v_workspace->'current_basis' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'SMOKE_FAIL: flag-off unit correction retained active basis: %', v_workspace;
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_history->'points') point
    WHERE point->>'stream' = 'supplier_observation'
      AND point->>'source_id' = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5'
      AND point->>'normalized_cost_cents' IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: stale supplier unit remained normalized in history: %', v_history;
  END IF;
  BEGIN
    PERFORM public.preview_product_cost_basis_changes(
      'product_page', NULL,
      jsonb_build_array(jsonb_build_object(
        'product_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        'row_version', (SELECT pricing_version FROM public.products
          WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid),
        'pricing_mode', 'margin_driven',
        'new_cost', '90.00',
        'tier1_margin_percent', '20',
        'tier2_margin_percent', '25',
        'tier3_margin_percent', '30',
        'change_reason', 'Reject stale supplier unit',
        'basis_type', 'selected_supplier_price',
        'basis_source', 'supplier_pricing',
        'basis_reason', 'Reject stale supplier unit',
        'basis_selection', true,
        'supplier_price_observation_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5'
      )),
      '11111111-1111-4111-8111-111111111111', 'phase2-stale-supplier-unit'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: stale supplier unit remained selectable';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'SUPPLIER_COST_BASIS_NOT_COMPARABLE%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: stale supplier preview failed for wrong reason: %', SQLERRM;
    END IF;
  END;
END;
$proof$;

RESET ROLE;
UPDATE public.app_settings SET setting_value = 'false'
WHERE setting_key = 'supplier_cost_basis_enabled';
UPDATE public.products SET inventory_unit = 'gal'
WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid;
UPDATE public.app_settings SET setting_value = 'true'
WHERE setting_key = 'supplier_cost_basis_enabled';
SET ROLE authenticated;

-- A conversion factor is meaningful only for the Product inventory unit that
-- was captured at receipt. Changing that unit makes the old PO evidence
-- ineligible at preview and apply instead of reinterpreting $/lb as $/oz.
RESET ROLE;
UPDATE public.app_settings SET setting_value = 'false'
WHERE setting_key = 'supplier_cost_basis_enabled';
UPDATE public.products SET inventory_unit = 'oz'
WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'::uuid;
UPDATE public.app_settings SET setting_value = 'true'
WHERE setting_key = 'supplier_cost_basis_enabled';
SET ROLE authenticated;
DO $proof$
BEGIN
  BEGIN
    PERFORM public.preview_product_cost_basis_changes(
      'product_page', NULL,
      jsonb_build_array(jsonb_build_object(
        'product_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
        'row_version', (SELECT pricing_version FROM public.products
          WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'::uuid),
        'pricing_mode', 'margin_driven',
        'new_cost', '40.00',
        'tier1_margin_percent', '20',
        'tier2_margin_percent', '25',
        'tier3_margin_percent', '30',
        'change_reason', 'Reject stale received unit',
        'basis_type', 'actual_purchase',
        'basis_source', 'product_page',
        'basis_reason', 'Reject stale received unit',
        'basis_selection', true,
        'purchase_order_item_id', 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2'
      )),
      '11111111-1111-4111-8111-111111111111', 'phase2-stale-purchase-unit'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: stale purchase unit remained selectable';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ACTUAL_PURCHASE_COST_BASIS_INVALID%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: stale purchase unit failed for wrong reason: %', SQLERRM;
    END IF;
  END;
END;
$proof$;
RESET ROLE;
UPDATE public.app_settings SET setting_value = 'false'
WHERE setting_key = 'supplier_cost_basis_enabled';
UPDATE public.products SET inventory_unit = 'lb'
WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'::uuid;
UPDATE public.app_settings SET setting_value = 'true'
WHERE setting_key = 'supplier_cost_basis_enabled';
SET ROLE authenticated;

INSERT INTO phase2_proof(key, value)
VALUES ('purchase-preview', public.preview_product_cost_basis_changes(
  'product_page', NULL,
  jsonb_build_array(jsonb_build_object(
    'product_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
    'row_version', (SELECT pricing_version FROM public.products
      WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'::uuid),
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

DO $proof$
DECLARE v jsonb := (SELECT value FROM phase2_proof WHERE key = 'purchase-preview');
BEGIN
  IF v->>'status' NOT IN ('previewed', 'no_changes') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: restored-unit purchase preview was not applicable: %', v;
  END IF;
END;
$proof$;

SAVEPOINT phase2_stale_unit_apply;
RESET ROLE;
UPDATE public.app_settings SET setting_value = 'false'
WHERE setting_key = 'supplier_cost_basis_enabled';
UPDATE public.products SET inventory_unit = 'oz'
WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'::uuid;
UPDATE public.app_settings SET setting_value = 'true'
WHERE setting_key = 'supplier_cost_basis_enabled';
SET ROLE authenticated;
DO $proof$
DECLARE v jsonb := (SELECT value FROM phase2_proof WHERE key = 'purchase-preview');
BEGIN
  BEGIN
    PERFORM public.apply_product_cost_basis_change_set(
      (v->>'change_set_id')::uuid, v->>'request_fingerprint',
      '11111111-1111-4111-8111-111111111111', 'phase2-stale-unit-apply'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: unit changed after preview still applied';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'PRICING_ROW_CONFLICT%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: stale apply unit failed for wrong reason: %', SQLERRM;
    END IF;
  END;
END;
$proof$;
ROLLBACK TO SAVEPOINT phase2_stale_unit_apply;

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
DO $proof$
DECLARE
  v_product_unit text;
  v_conversion_unit text;
BEGIN
  SELECT p.inventory_unit, l.conversion_unit
  INTO v_product_unit, v_conversion_unit
  FROM public.products p
  JOIN public.product_supplier_links l ON l.product_id = p.id
  WHERE p.id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid;
  IF lower(btrim(v_product_unit)) IS DISTINCT FROM lower(btrim(v_conversion_unit)) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: supplier units were not restored: product=%, link=%',
      v_product_unit, v_conversion_unit;
  END IF;
END;
$proof$;
SET ROLE authenticated;

INSERT INTO phase2_proof(key, value)
VALUES ('supplier-preview', public.preview_product_cost_basis_changes(
  'product_page', NULL,
  jsonb_build_array(jsonb_build_object(
    'product_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    'row_version', (SELECT pricing_version FROM public.products
      WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid),
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
    'row_version', (SELECT pricing_version FROM public.products
      WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid),
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

SAVEPOINT phase2_stale_supplier_unit_apply;
RESET ROLE;
UPDATE public.app_settings SET setting_value = 'false'
WHERE setting_key = 'supplier_cost_basis_enabled';
UPDATE public.products SET inventory_unit = 'oz'
WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid;
UPDATE public.app_settings SET setting_value = 'true'
WHERE setting_key = 'supplier_cost_basis_enabled';
SET ROLE authenticated;
DO $proof$
DECLARE v jsonb := (SELECT value FROM phase2_proof WHERE key = 'supplier-preview');
BEGIN
  BEGIN
    PERFORM public.apply_product_cost_basis_change_set(
      (v->>'change_set_id')::uuid, v->>'request_fingerprint',
      '11111111-1111-4111-8111-111111111111', 'phase2-stale-supplier-unit-apply'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: supplier unit changed after preview still applied';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'PRICING_ROW_CONFLICT%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: stale supplier apply failed for wrong reason: %', SQLERRM;
    END IF;
  END;
END;
$proof$;
ROLLBACK TO SAVEPOINT phase2_stale_supplier_unit_apply;

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
      AND current_cost = 90
      AND pricing_version = (
        SELECT (value->'rows'->0->'submitted_row'->>'row_version')::bigint
        FROM phase2_proof WHERE key = 'supplier-preview'
      )
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: basis-only selection changed Product pricing';
  END IF;
END;
$proof$;

SET ROLE authenticated;

-- A complete export can include a genuinely unchanged Product with no cost.
-- The inert row must still pass the shared manifest checks, while the changed
-- row must receive a required basis record and apply normally.
INSERT INTO phase2_proof(key, value)
VALUES ('null-cost-workbook-export', public.create_pricing_workbook_export(
  ARRAY[
    'ffffffff-ffff-4fff-8fff-fffffffffff1'::uuid,
    'ffffffff-ffff-4fff-8fff-fffffffffff2'::uuid
  ],
  '11111111-1111-4111-8111-111111111111',
  'phase2-null-cost-workbook-export'
));

INSERT INTO phase2_proof(key, value)
SELECT 'null-cost-workbook-preview', public.preview_product_cost_basis_changes(
  'pricing_worksheet', (value->>'export_id')::uuid,
  jsonb_build_array(
    (value->'rows'->0) || jsonb_build_object(
      'has_formula', false, 'formula_cells', '[]'::jsonb,
      'pricing_mode', '', 'new_cost', '',
      'tier1_margin_percent', '', 'tier2_margin_percent', '',
      'tier3_margin_percent', '', 'tier1_price', '',
      'tier2_price', '', 'tier3_price', '',
      'change_reason', '', 'basis_type', 'manual_override',
      'basis_source', 'pricing_worksheet', 'basis_reason', '',
      'basis_selection', false
    ),
    (value->'rows'->1) || jsonb_build_object(
      'has_formula', false, 'formula_cells', '[]'::jsonb,
      'pricing_mode', 'margin_driven', 'new_cost', '55.00',
      'tier1_margin_percent', '20', 'tier2_margin_percent', '25',
      'tier3_margin_percent', '30',
      'change_reason', 'Null-cost workbook follow-up proof',
      'basis_type', 'manual_override',
      'basis_source', 'pricing_worksheet',
      'basis_reason', 'Null-cost workbook follow-up proof',
      'basis_selection', false
    )
  ),
  '11111111-1111-4111-8111-111111111111',
  'phase2-null-cost-workbook-preview'
)
FROM phase2_proof WHERE key = 'null-cost-workbook-export';

DO $proof$
DECLARE
  v jsonb := (SELECT value FROM phase2_proof WHERE key = 'null-cost-workbook-preview');
  v_change_set_id uuid := (v->>'change_set_id')::uuid;
BEGIN
  IF v->>'status' <> 'previewed'
     OR (v->>'submitted_row_count')::int <> 2
     OR (v->>'ready_count')::int <> 1
     OR (v->>'unchanged_count')::int <> 1
     OR (v->>'basis_change_count')::int <> 1
     OR (v->>'apply_allowed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_FAIL: null-cost workbook preview wrong: %', v;
  END IF;
END;
$proof$;

RESET ROLE;
DO $proof$
DECLARE v_change_set_id uuid := (
  SELECT (value->>'change_set_id')::uuid
  FROM phase2_proof WHERE key = 'null-cost-workbook-preview'
);
BEGIN
  IF (SELECT count(*) FROM public.product_cost_basis_change_rows
      WHERE pricing_change_set_id = v_change_set_id) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: inert null-cost row entered basis change set';
  END IF;
END;
$proof$;
SET ROLE authenticated;

INSERT INTO phase2_proof(key, value)
SELECT 'null-cost-workbook-apply', public.apply_product_cost_basis_change_set(
  (value->>'change_set_id')::uuid, value->>'request_fingerprint',
  '11111111-1111-4111-8111-111111111111',
  'phase2-null-cost-workbook-apply'
)
FROM phase2_proof WHERE key = 'null-cost-workbook-preview';

RESET ROLE;
DO $proof$
BEGIN
  IF (SELECT current_cost FROM public.products
      WHERE id = 'ffffffff-ffff-4fff-8fff-fffffffffff1'::uuid) IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM public.product_cost_basis
       WHERE product_id = 'ffffffff-ffff-4fff-8fff-fffffffffff1'::uuid
     ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: inert null-cost Product was changed or given a basis';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.products
    WHERE id = 'ffffffff-ffff-4fff-8fff-fffffffffff2'::uuid
      AND current_cost = 55
  ) OR NOT EXISTS (
    SELECT 1 FROM public.product_cost_basis
    WHERE product_id = 'ffffffff-ffff-4fff-8fff-fffffffffff2'::uuid
      AND effective_to IS NULL AND basis_type = 'manual_override'
      AND cost_cents = 5500
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: changed workbook Product did not apply with basis';
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
    'row_version', (SELECT pricing_version FROM public.products
      WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid),
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
    'row_version', (SELECT pricing_version FROM public.products
      WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid),
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
