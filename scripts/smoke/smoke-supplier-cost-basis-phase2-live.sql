-- Supplier cost-basis Phase 2 live smoke.
--
-- Execute as ONE statement through Supabase MCP execute_sql or via
-- `node scripts/smoke/run-smoke.mjs --spec supplier_cost_basis_phase2_live`
-- with SUPABASE_DB_URL set. It intentionally ends by raising
-- SMOKE_PASS_ROLLBACK; that aborts this uncommitted transaction, leaving no
-- Product, workbook export, pricing history, cost-basis, or idempotency rows.
--
-- Unlike the disposable-Docker Phase 2 proof, this chain has no fixture IDs,
-- no production cardinality assumptions, and no /tmp workbook-file dependency.

BEGIN;

CREATE TEMP TABLE phase2_live_smoke (
  key text PRIMARY KEY,
  value jsonb NOT NULL
);
GRANT ALL ON phase2_live_smoke TO authenticated;

DO $smoke$
DECLARE
  v_admin_id uuid;
BEGIN
  IF (SELECT setting_value FROM public.app_settings
      WHERE setting_key = 'supplier_cost_basis_enabled') IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: supplier cost-basis global flag is not default-off';
  END IF;

  IF has_table_privilege('authenticated', 'public.product_cost_basis', 'SELECT') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: authenticated retained direct cost-basis access';
  END IF;

  IF has_function_privilege(
       'authenticated',
       'public.preview_product_pricing_changes(text,uuid,jsonb,uuid,text)',
       'EXECUTE'
     ) OR has_function_privilege(
       'authenticated',
       'public.apply_product_pricing_change_set(uuid,text,uuid,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: authenticated retained direct inner pricing RPC access';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.product_cost_basis b
    JOIN public.products p ON p.id = b.product_id
    WHERE b.effective_to IS NULL
      AND p.current_cost IS NOT NULL
      AND b.cost_cents <> round(p.current_cost * 100)::bigint
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: an active cost basis disagrees with its Product cost';
  END IF;

  SELECT id INTO v_admin_id
  FROM public.profiles
  WHERE role = 'admin' AND is_active IS TRUE
  ORDER BY id
  LIMIT 1;
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin is available for governed pricing proof';
  END IF;

  INSERT INTO phase2_live_smoke(key, value)
  VALUES (
    'context',
    jsonb_build_object(
      'actor_id', v_admin_id,
      'product_id', gen_random_uuid(),
      'workbook_product_id', gen_random_uuid()
    )
  );
END;
$smoke$;

INSERT INTO public.products(
  id, product_name, sku, category, container_size, unit_size, inventory_unit
)
SELECT
  (value->>'product_id')::uuid,
  '[SMOKE] Phase 2 Product Page Pricing',
  'SMOKE-P2-PAGE-' || left(replace(value->>'product_id', '-', ''), 16),
  'Herbicide', 1, 'gal', 'gal'
FROM phase2_live_smoke
WHERE key = 'context';

INSERT INTO public.products(
  id, product_name, sku, category, container_size, unit_size, inventory_unit
)
SELECT
  (value->>'workbook_product_id')::uuid,
  '[SMOKE] Phase 2 Workbook Pricing',
  'SMOKE-P2-XLSX-' || left(replace(value->>'workbook_product_id', '-', ''), 16),
  'Herbicide', 1, 'gal', 'gal'
FROM phase2_live_smoke
WHERE key = 'context';

SELECT set_config(
  'request.jwt.claim.sub',
  (SELECT value->>'actor_id' FROM phase2_live_smoke WHERE key = 'context'),
  true
);
SET LOCAL ROLE authenticated;

-- Product-page route: a new Product has no fabricated basis; the first governed
-- manual cost edit must atomically write both price history and a cost basis.
INSERT INTO phase2_live_smoke(key, value)
SELECT 'manual-preview', public.preview_product_cost_basis_changes(
  'product_page',
  NULL,
  jsonb_build_array(jsonb_build_object(
    'product_id', c.value->>'product_id',
    'row_version', 1,
    'pricing_mode', 'price_driven',
    'new_cost', '10.09',
    'tier1_price', '12.00',
    'tier2_price', '13.00',
    'tier3_price', '14.00',
    'change_reason', '[SMOKE] product-page governed pricing',
    'basis_type', 'manual_override',
    'basis_source', 'product_page',
    'basis_reason', '[SMOKE] product-page governed pricing',
    'basis_selection', false
  )),
  (c.value->>'actor_id')::uuid,
  'smoke-phase2-live-manual-preview-' || txid_current()::text
)
FROM phase2_live_smoke c
WHERE c.key = 'context';

DO $smoke$
DECLARE v_preview jsonb := (SELECT value FROM phase2_live_smoke WHERE key = 'manual-preview');
BEGIN
  IF v_preview->>'status' IS DISTINCT FROM 'previewed'
     OR (v_preview->>'pricing_change_count')::integer IS DISTINCT FROM 1
     OR (v_preview->>'basis_change_count')::integer IS DISTINCT FROM 1
     OR (v_preview->>'apply_allowed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_FAIL: Product-page preview drifted: %', v_preview;
  END IF;
END;
$smoke$;

INSERT INTO phase2_live_smoke(key, value)
SELECT 'manual-apply', public.apply_product_cost_basis_change_set(
  (p.value->>'change_set_id')::uuid,
  p.value->>'request_fingerprint',
  (c.value->>'actor_id')::uuid,
  'smoke-phase2-live-manual-apply-' || txid_current()::text
)
FROM phase2_live_smoke p
JOIN phase2_live_smoke c ON c.key = 'context'
WHERE p.key = 'manual-preview';

INSERT INTO phase2_live_smoke(key, value)
SELECT 'manual-apply-replay', public.apply_product_cost_basis_change_set(
  (p.value->>'change_set_id')::uuid,
  p.value->>'request_fingerprint',
  (c.value->>'actor_id')::uuid,
  'smoke-phase2-live-manual-apply-' || txid_current()::text
)
FROM phase2_live_smoke p
JOIN phase2_live_smoke c ON c.key = 'context'
WHERE p.key = 'manual-preview';

RESET ROLE;

DO $smoke$
DECLARE
  v_product_id uuid := (SELECT (value->>'product_id')::uuid FROM phase2_live_smoke WHERE key = 'context');
  v_change_set_id uuid := (SELECT (value->>'change_set_id')::uuid FROM phase2_live_smoke WHERE key = 'manual-preview');
  v_apply jsonb := (SELECT value FROM phase2_live_smoke WHERE key = 'manual-apply');
  v_replay jsonb := (SELECT value FROM phase2_live_smoke WHERE key = 'manual-apply-replay');
BEGIN
  IF v_apply->>'status' IS DISTINCT FROM 'applied'
     OR (v_apply->>'applied_count')::integer IS DISTINCT FROM 1
     OR jsonb_array_length(v_apply->'cost_basis_rows') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: Product-page apply drifted: %', v_apply;
  END IF;

  IF v_replay IS DISTINCT FROM v_apply THEN
    RAISE EXCEPTION 'SMOKE_FAIL: Product-page apply replay changed response: % vs %', v_apply, v_replay;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.products
    WHERE id = v_product_id
      AND current_cost = 10.09
      AND tier1_price = 12
      AND tier2_price = 13
      AND tier3_price = 14
      AND pricing_version = 2
  ) OR (SELECT count(*) FROM public.cost_history
        WHERE product_id = v_product_id AND change_set_id = v_change_set_id) <> 1
     OR (SELECT count(*) FROM public.product_cost_basis
         WHERE product_id = v_product_id AND pricing_change_set_id = v_change_set_id) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public.product_cost_basis
       WHERE product_id = v_product_id
         AND pricing_change_set_id = v_change_set_id
         AND effective_to IS NULL
         AND basis_type = 'manual_override'
         AND selection_source = 'product_page'
         AND cost_cents = 1009
     ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: Product-page price/history/basis mutation drifted';
  END IF;
END;
$smoke$;

SELECT set_config(
  'request.jwt.claim.sub',
  (SELECT value->>'actor_id' FROM phase2_live_smoke WHERE key = 'context'),
  true
);
SET LOCAL ROLE authenticated;

-- Workbook route: use a server-generated export row as the signed identity
-- payload, then change its pricing fields. This proves the current wrapper
-- without a hand-built /tmp JSON file.
INSERT INTO phase2_live_smoke(key, value)
SELECT 'workbook-export', public.create_pricing_workbook_export(
  ARRAY[(c.value->>'workbook_product_id')::uuid],
  (c.value->>'actor_id')::uuid,
  'smoke-phase2-live-workbook-export-' || txid_current()::text
)
FROM phase2_live_smoke c
WHERE c.key = 'context';

INSERT INTO phase2_live_smoke(key, value)
SELECT 'workbook-preview', public.preview_product_cost_basis_changes(
  'pricing_worksheet',
  (e.value->>'export_id')::uuid,
  jsonb_build_array(
    (e.value->'rows'->0) || jsonb_build_object(
      'pricing_mode', 'price_driven',
      'new_cost', '20.25',
      'tier1_price', '25.00',
      'tier2_price', '26.00',
      'tier3_price', '27.00',
      'change_reason', '[SMOKE] monthly workbook pricing',
      'basis_type', 'manual_override',
      'basis_source', 'pricing_worksheet',
      'basis_reason', '[SMOKE] monthly workbook pricing',
      'basis_selection', false,
      'has_formula', false,
      'formula_cells', '[]'::jsonb
    )
  ),
  (c.value->>'actor_id')::uuid,
  'smoke-phase2-live-workbook-preview-' || txid_current()::text
)
FROM phase2_live_smoke e
JOIN phase2_live_smoke c ON c.key = 'context'
WHERE e.key = 'workbook-export';

DO $smoke$
DECLARE v_preview jsonb := (SELECT value FROM phase2_live_smoke WHERE key = 'workbook-preview');
BEGIN
  IF v_preview->>'status' IS DISTINCT FROM 'previewed'
     OR (v_preview->>'submitted_row_count')::integer IS DISTINCT FROM 1
     OR (v_preview->>'pricing_change_count')::integer IS DISTINCT FROM 1
     OR (v_preview->>'basis_change_count')::integer IS DISTINCT FROM 1
     OR (v_preview->>'apply_allowed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_FAIL: workbook preview drifted: %', v_preview;
  END IF;
END;
$smoke$;

INSERT INTO phase2_live_smoke(key, value)
SELECT 'workbook-apply', public.apply_product_cost_basis_change_set(
  (p.value->>'change_set_id')::uuid,
  p.value->>'request_fingerprint',
  (c.value->>'actor_id')::uuid,
  'smoke-phase2-live-workbook-apply-' || txid_current()::text
)
FROM phase2_live_smoke p
JOIN phase2_live_smoke c ON c.key = 'context'
WHERE p.key = 'workbook-preview';

INSERT INTO phase2_live_smoke(key, value)
SELECT 'workbook-apply-replay', public.apply_product_cost_basis_change_set(
  (p.value->>'change_set_id')::uuid,
  p.value->>'request_fingerprint',
  (c.value->>'actor_id')::uuid,
  'smoke-phase2-live-workbook-apply-' || txid_current()::text
)
FROM phase2_live_smoke p
JOIN phase2_live_smoke c ON c.key = 'context'
WHERE p.key = 'workbook-preview';

RESET ROLE;

DO $smoke$
DECLARE
  v_product_id uuid := (SELECT (value->>'workbook_product_id')::uuid FROM phase2_live_smoke WHERE key = 'context');
  v_change_set_id uuid := (SELECT (value->>'change_set_id')::uuid FROM phase2_live_smoke WHERE key = 'workbook-preview');
  v_export_id uuid := (SELECT (value->>'export_id')::uuid FROM phase2_live_smoke WHERE key = 'workbook-export');
  v_apply jsonb := (SELECT value FROM phase2_live_smoke WHERE key = 'workbook-apply');
  v_replay jsonb := (SELECT value FROM phase2_live_smoke WHERE key = 'workbook-apply-replay');
BEGIN
  IF v_apply->>'status' IS DISTINCT FROM 'applied'
     OR (v_apply->>'applied_count')::integer IS DISTINCT FROM 1
     OR jsonb_array_length(v_apply->'cost_basis_rows') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: workbook apply drifted: %', v_apply;
  END IF;

  IF v_replay IS DISTINCT FROM v_apply THEN
    RAISE EXCEPTION 'SMOKE_FAIL: workbook apply replay changed response: % vs %', v_apply, v_replay;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.products
    WHERE id = v_product_id
      AND current_cost = 20.25
      AND tier1_price = 25
      AND tier2_price = 26
      AND tier3_price = 27
      AND pricing_version = 2
  ) OR (SELECT count(*) FROM public.cost_history
        WHERE product_id = v_product_id AND change_set_id = v_change_set_id) <> 1
     OR (SELECT count(*) FROM public.product_cost_basis
         WHERE product_id = v_product_id AND pricing_change_set_id = v_change_set_id) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public.product_cost_basis
       WHERE product_id = v_product_id
         AND pricing_change_set_id = v_change_set_id
         AND effective_to IS NULL
         AND basis_type = 'manual_override'
         AND selection_source = 'pricing_worksheet'
         AND cost_cents = 2025
     ) OR (SELECT status FROM public.pricing_workbook_exports WHERE id = v_export_id)
            IS DISTINCT FROM 'consumed' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: workbook price/history/basis/export mutation drifted';
  END IF;
END;
$smoke$;

-- The expected exception aborts the uncommitted transaction. The smoke runner
-- recognizes this token as PASS and no preceding write can persist.
DO $smoke$
BEGIN
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK supplier_cost_basis_phase2_live';
END;
$smoke$;
