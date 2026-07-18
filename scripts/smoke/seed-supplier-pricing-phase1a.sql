\set ON_ERROR_STOP on
SELECT set_config('request.jwt.claim.sub', '', false);

-- Seed the existing live-shaped records while the additive bootstrap remains
-- compatible with the currently deployed frontend. The enforcement cutover
-- is compiled only after these pre-existing priced Products are present.
INSERT INTO public.profiles(id, email, full_name, role, is_active)
VALUES
  ('11111111-1111-4111-8111-111111111111'::uuid, 'phase1a-admin@example.invalid', 'Phase 1a Admin', 'admin', true),
  ('22222222-2222-4222-8222-222222222222'::uuid, 'phase1a-user@example.invalid', 'Phase 1a User', 'sales_rep', true);

INSERT INTO public.products(
  id, product_name, sku, category, container_size, unit_size, inventory_unit,
  current_cost, tier1_margin, tier2_margin, tier3_margin,
  rate_per_acre, rate_unit
)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid, 'Phase 1a Margin Product', '001-MARGIN', 'Herbicide', 2.5, 'gal', 'gal',
   80.00, 0.20, 0.25, 0.30, 16, 'oz'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'::uuid, 'Phase 1a Price Product', '002-PRICE', 'Fungicide', 1, 'gal', 'gal',
   50.00, 0.10, 0.20, 0.30, 8, 'oz'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'::uuid, 'Phase 1a Third Product', '003-THIRD', 'Insecticide', 1, 'lb', 'lb',
   40.00, 0.20, 0.25, 0.30, 4, 'oz'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4'::uuid, 'Phase 1a Blank Product', NULL, NULL, NULL, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL, NULL),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5'::uuid, 'Phase 1a Rate Product', '005-RATE', 'Herbicide', 1, 'gal', 'gal',
   20.00, 0.20, 0.25, 0.30, 16, 'oz');
