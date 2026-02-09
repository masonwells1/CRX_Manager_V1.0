-- ============================================================================
-- UNIT TRACKING & PRICING OVERHAUL
-- CRX Manager V1.0
-- Date: 2026-02-11
--
-- This migration implements the Final Spec for unit tracking:
--   1. Adds unit_type to unit_conversions (liquid/dry/both)
--   2. Replaces generic 'Oz' with explicit 'fl oz' (liquid)
--   3. Adds product_form, inventory_unit, container_unit, container_type to products
--   4. Adds cross-table validation trigger
--   5. Creates view_unmigrated_products verification view
--   6. Best-effort backfill from existing unit_size data
-- ============================================================================


-- ============================================================================
-- SECTION 1: Add unit_type to unit_conversions
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'unit_conversions' AND column_name = 'unit_type'
  ) THEN
    ALTER TABLE unit_conversions ADD COLUMN unit_type text NOT NULL DEFAULT 'both'
      CHECK (unit_type IN ('liquid', 'dry', 'both'));
  END IF;
END $$;


-- ============================================================================
-- SECTION 2: Fix seed data — replace generic 'Oz' with 'fl oz', set types
-- ============================================================================

-- Rename generic 'Oz' to 'fl oz' and mark as liquid
UPDATE unit_conversions
SET unit = 'fl oz', unit_type = 'liquid', notes = '1 fluid ounce'
WHERE unit = 'Oz';

-- Set unit_type on all existing rows
UPDATE unit_conversions SET unit_type = 'liquid' WHERE unit IN ('Gal', 'Qt', 'Pt', 'fl oz');
UPDATE unit_conversions SET unit_type = 'dry'    WHERE unit IN ('Lb', 'Dry oz');
UPDATE unit_conversions SET unit_type = 'both'   WHERE unit IN ('Ea');

-- Ensure fl oz exists even if Oz was never created
INSERT INTO unit_conversions (unit, factor_oz, unit_type, notes)
VALUES ('fl oz', 1, 'liquid', '1 fluid ounce')
ON CONFLICT (unit) DO NOTHING;


-- ============================================================================
-- SECTION 3: Add new columns to products table
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'products' AND column_name = 'product_form'
  ) THEN
    ALTER TABLE products ADD COLUMN product_form text
      CHECK (product_form IN ('liquid', 'dry'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'products' AND column_name = 'inventory_unit'
  ) THEN
    ALTER TABLE products ADD COLUMN inventory_unit text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'products' AND column_name = 'container_unit'
  ) THEN
    ALTER TABLE products ADD COLUMN container_unit text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'products' AND column_name = 'container_type'
  ) THEN
    ALTER TABLE products ADD COLUMN container_type text
      CHECK (container_type IN (
        'Jug', 'Drum', 'Pallet', 'Mini-Bulk', 'Shuttle', 'Bag', 'Tote', 'Ea'
      ));
  END IF;
END $$;


-- ============================================================================
-- SECTION 4: Cross-table validation trigger
-- Ensures inventory_unit and container_unit match product_form via unit_conversions
-- Only validates when both product_form and the unit field are non-null
-- ============================================================================

CREATE OR REPLACE FUNCTION validate_product_units()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Validate inventory_unit matches product_form
  IF NEW.product_form IS NOT NULL AND NEW.inventory_unit IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM unit_conversions
      WHERE unit = NEW.inventory_unit
        AND (unit_type = NEW.product_form OR unit_type = 'both')
    ) THEN
      RAISE EXCEPTION 'inventory_unit "%" is not valid for product_form "%"',
        NEW.inventory_unit, NEW.product_form;
    END IF;
  END IF;

  -- Validate container_unit matches product_form
  IF NEW.product_form IS NOT NULL AND NEW.container_unit IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM unit_conversions
      WHERE unit = NEW.container_unit
        AND (unit_type = NEW.product_form OR unit_type = 'both')
    ) THEN
      RAISE EXCEPTION 'container_unit "%" is not valid for product_form "%"',
        NEW.container_unit, NEW.product_form;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_product_units ON products;
CREATE TRIGGER trg_validate_product_units
  BEFORE INSERT OR UPDATE ON products
  FOR EACH ROW
  EXECUTE FUNCTION validate_product_units();


-- ============================================================================
-- SECTION 5: Verification view for unmigrated products
-- ============================================================================

CREATE OR REPLACE VIEW view_unmigrated_products AS
SELECT id, product_name, sku, category, vendor,
       container_size, unit_size, rate_unit,
       product_form, inventory_unit, container_unit, container_type
FROM products
WHERE product_form IS NULL
   OR inventory_unit IS NULL
ORDER BY product_name;


-- ============================================================================
-- SECTION 6: Best-effort backfill from existing unit_size data
-- Products that cannot be auto-classified remain NULL and appear in the view
-- ============================================================================

-- Liquid products: unit_size contains Gal, Qt, Pt, or generic oz (not Lb/Dry)
UPDATE products SET
  product_form = 'liquid',
  inventory_unit = CASE
    WHEN unit_size ILIKE '%gal%' THEN 'Gal'
    WHEN unit_size ILIKE '%qt%'  THEN 'Qt'
    WHEN unit_size ILIKE '%pt%'  THEN 'Pt'
    ELSE 'fl oz'
  END,
  container_unit = CASE
    WHEN unit_size ILIKE '%gal%' THEN 'Gal'
    WHEN unit_size ILIKE '%qt%'  THEN 'Qt'
    WHEN unit_size ILIKE '%pt%'  THEN 'Pt'
    ELSE 'fl oz'
  END
WHERE product_form IS NULL
  AND (unit_size ILIKE '%gal%' OR unit_size ILIKE '%qt%'
       OR unit_size ILIKE '%pt%' OR unit_size ILIKE '%oz%')
  AND unit_size NOT ILIKE '%lb%'
  AND unit_size NOT ILIKE '%dry%';

-- Dry products: unit_size contains Lb or Dry oz
UPDATE products SET
  product_form = 'dry',
  inventory_unit = CASE
    WHEN unit_size ILIKE '%lb%' THEN 'Lb'
    ELSE 'Dry oz'
  END,
  container_unit = CASE
    WHEN unit_size ILIKE '%lb%' THEN 'Lb'
    ELSE 'Dry oz'
  END
WHERE product_form IS NULL
  AND (unit_size ILIKE '%lb%' OR unit_size ILIKE '%dry%');

-- Products with 'Ea' unit_size
UPDATE products SET
  product_form = NULL,
  inventory_unit = 'Ea',
  container_unit = 'Ea'
WHERE product_form IS NULL
  AND inventory_unit IS NULL
  AND unit_size ILIKE '%ea%';
