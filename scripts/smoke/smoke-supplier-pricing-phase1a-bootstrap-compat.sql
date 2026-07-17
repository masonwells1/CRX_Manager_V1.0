\set ON_ERROR_STOP on

-- Prove the additive bootstrap does not break the currently deployed Product
-- form during the deliberate database-first compatibility window. Everything
-- is rolled back before the final cutover proof starts.
BEGIN;

INSERT INTO public.profiles(id, email, full_name, role, is_active)
VALUES (
  '99999999-9999-4999-8999-999999999999'::uuid,
  'phase1a-legacy-admin@example.invalid',
  'Phase 1a Legacy Admin',
  'admin',
  true
);

INSERT INTO public.products(
  id, product_name, sku, current_cost,
  tier1_margin, tier2_margin, tier3_margin
)
VALUES (
  '99999999-9999-4999-8999-999999999991'::uuid,
  'Phase 1a Legacy Compatibility Product',
  'LEGACY-COMPAT',
  10.00,
  0.20,
  0.25,
  0.30
);

SELECT set_config(
  'request.jwt.claim.sub',
  '99999999-9999-4999-8999-999999999999',
  true
);
SET LOCAL ROLE authenticated;

-- The old UI sends pricing fields in its full-row Product update and then
-- inserts history itself. It keeps the originally loaded version in component
-- state, so two edits in the same open Product page must both work.
UPDATE public.products
SET product_name = 'Phase 1a Legacy Compatibility Product Edited',
    current_cost = 11.00,
    tier1_margin = 0.20,
    tier2_margin = 0.25,
    tier3_margin = 0.30,
    pricing_version = 1
WHERE id = '99999999-9999-4999-8999-999999999991'::uuid;

INSERT INTO public.cost_history(
  product_id,
  changed_by,
  old_cost,
  new_cost,
  change_note
)
VALUES (
  '99999999-9999-4999-8999-999999999991'::uuid,
  '99999999-9999-4999-8999-999999999999'::uuid,
  10.00,
  11.00,
  'legacy compatibility proof'
);

UPDATE public.products
SET product_name = 'Phase 1a Legacy Compatibility Product Edited Again',
    current_cost = 12.00,
    tier1_margin = 0.20,
    tier2_margin = 0.25,
    tier3_margin = 0.30,
    pricing_version = 1
WHERE id = '99999999-9999-4999-8999-999999999991'::uuid;

INSERT INTO public.cost_history(product_id, changed_by, old_cost, new_cost, change_note)
VALUES (
  '99999999-9999-4999-8999-999999999991'::uuid,
  '99999999-9999-4999-8999-999999999999'::uuid,
  11.00, 12.00, 'legacy compatibility proof second save'
);

DO $proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.products
    WHERE id = '99999999-9999-4999-8999-999999999991'::uuid
      AND product_name = 'Phase 1a Legacy Compatibility Product Edited Again'
      AND current_cost = 12.00
      AND pricing_version = 3
  ) THEN
    RAISE EXCEPTION 'BOOTSTRAP_COMPAT_FAIL: legacy Product update did not survive';
  END IF;

  IF (SELECT count(*) FROM public.cost_history
      WHERE product_id = '99999999-9999-4999-8999-999999999991'::uuid) <> 2 THEN
    RAISE EXCEPTION 'BOOTSTRAP_COMPAT_FAIL: legacy history was missing or doubled';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.cost_history
    WHERE product_id = '99999999-9999-4999-8999-999999999991'::uuid
      AND old_cost = 11.00
      AND new_cost = 12.00
      AND change_source = 'legacy_frontend'
      AND change_note = 'legacy compatibility proof second save'
  ) THEN
    RAISE EXCEPTION 'BOOTSTRAP_COMPAT_FAIL: legacy history defaults/provenance are wrong';
  END IF;
END;
$proof$;

ROLLBACK;

SELECT 'PHASE1A_BOOTSTRAP_COMPAT_PASS' AS proof_result;
