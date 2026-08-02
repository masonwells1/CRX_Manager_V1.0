\set ON_ERROR_STOP on

-- Disposable-only live-shape fixture for the exact Wells rollout seed. The
-- production migration itself still fails closed against real rows.
INSERT INTO public.products(
  id, product_name, sku, category, container_size, unit_size, inventory_unit
)
SELECT id, 'Wells rollout fixture ' || sequence, 'WELLS-' || sequence,
       'Herbicide', 1, 'gal', 'gal'
FROM unnest(ARRAY[
  'ab708913-080e-4894-ba5c-8beb7586d356'::uuid,
  '8db05fc1-c3c9-4049-b284-c02c0a7a3056'::uuid,
  '6fd3adc1-909f-4b63-98fa-73028a780a7c'::uuid,
  '7de7131e-b4cb-4048-be14-77eb3449b20f'::uuid,
  '908f29d4-62d9-404b-93e0-50666f65ee99'::uuid,
  '05b9f5d8-3305-4234-afaa-e7a63c3b46f9'::uuid,
  '81f689f5-c78f-480a-b884-4e097986e212'::uuid,
  '44b47fe1-9484-4ede-95d6-52988a840d75'::uuid,
  'd1961efe-6133-4ab4-bf84-ac7bf7da903a'::uuid,
  '03dbce7d-c142-4f24-8bfc-cc490fa47a0d'::uuid
]) WITH ORDINALITY AS ids(id, sequence);

-- These Products are inserted after the Phase 2 baseline copy. Establish the
-- same pre-canary state explicitly in this disposable fixture only.
ALTER TABLE public.products DISABLE TRIGGER USER;
UPDATE public.products
SET current_cost = 10,
    tier1_price = 12,
    tier2_price = 13,
    tier3_price = 14
WHERE sku LIKE 'WELLS-%';
ALTER TABLE public.products ENABLE TRIGGER USER;

INSERT INTO public.product_cost_basis(
  product_id, basis_type, cost_cents, selection_source, reason,
  selected_by, selected_at, effective_from
)
SELECT id, 'manual_override', 1000, 'migration_baseline',
       'Disposable pre-canary baseline',
       NULL, now(), now()
FROM public.products
WHERE sku LIKE 'WELLS-%';

INSERT INTO public.vendors(id, name)
VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee8', 'Wells Ag Supply');

INSERT INTO public.supplier_price_imports(id, vendor_id, created_by)
VALUES (
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee7',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee8',
  '11111111-1111-4111-8111-111111111111'
);

WITH products AS (
  SELECT id, sequence
  FROM unnest(ARRAY[
    'ab708913-080e-4894-ba5c-8beb7586d356'::uuid,
    '8db05fc1-c3c9-4049-b284-c02c0a7a3056'::uuid,
    '6fd3adc1-909f-4b63-98fa-73028a780a7c'::uuid,
    '7de7131e-b4cb-4048-be14-77eb3449b20f'::uuid,
    '908f29d4-62d9-404b-93e0-50666f65ee99'::uuid,
    '05b9f5d8-3305-4234-afaa-e7a63c3b46f9'::uuid,
    '81f689f5-c78f-480a-b884-4e097986e212'::uuid,
    '44b47fe1-9484-4ede-95d6-52988a840d75'::uuid,
    'd1961efe-6133-4ab4-bf84-ac7bf7da903a'::uuid,
    '03dbce7d-c142-4f24-8bfc-cc490fa47a0d'::uuid
  ]) WITH ORDINALITY AS ids(id, sequence)
)
INSERT INTO public.product_supplier_links(
  id, product_id, vendor_id, supplier_sku, supplier_product_name,
  supplier_uom, supplier_pack_description,
  inventory_units_per_supplier_unit, conversion_unit,
  comparison_status, link_status, is_active, created_by
)
SELECT ('10000000-0000-4000-8000-' || lpad(sequence::text, 12, '0'))::uuid,
       id, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee8',
       'WELLS-' || sequence, 'Wells fixture ' || sequence,
       'gal', '1 gal', 1, 'gal', 'comparable', 'confirmed', true,
       '11111111-1111-4111-8111-111111111111'
FROM products;

INSERT INTO public.supplier_price_import_rows(id, import_id)
SELECT ('20000000-0000-4000-8000-' || lpad(sequence::text, 12, '0'))::uuid,
       'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee7'
FROM generate_series(1, 10) AS sequence;

WITH products AS (
  SELECT id, sequence
  FROM unnest(ARRAY[
    'ab708913-080e-4894-ba5c-8beb7586d356'::uuid,
    '8db05fc1-c3c9-4049-b284-c02c0a7a3056'::uuid,
    '6fd3adc1-909f-4b63-98fa-73028a780a7c'::uuid,
    '7de7131e-b4cb-4048-be14-77eb3449b20f'::uuid,
    '908f29d4-62d9-404b-93e0-50666f65ee99'::uuid,
    '05b9f5d8-3305-4234-afaa-e7a63c3b46f9'::uuid,
    '81f689f5-c78f-480a-b884-4e097986e212'::uuid,
    '44b47fe1-9484-4ede-95d6-52988a840d75'::uuid,
    'd1961efe-6133-4ab4-bf84-ac7bf7da903a'::uuid,
    '03dbce7d-c142-4f24-8bfc-cc490fa47a0d'::uuid
  ]) WITH ORDINALITY AS ids(id, sequence)
)
INSERT INTO public.supplier_price_observations(
  id, product_id, vendor_id, product_supplier_link_id, import_id,
  import_row_id, price_kind, cost_cents, price_unit, package_quantity,
  effective_from, created_by
)
SELECT ('30000000-0000-4000-8000-' || lpad(sequence::text, 12, '0'))::uuid,
       id, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee8',
       ('10000000-0000-4000-8000-' || lpad(sequence::text, 12, '0'))::uuid,
       'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee7',
       ('20000000-0000-4000-8000-' || lpad(sequence::text, 12, '0'))::uuid,
       'quote', 1000 + sequence, 'gal', 1,
       (now() AT TIME ZONE 'America/Chicago')::date,
       '11111111-1111-4111-8111-111111111111'
FROM products;
