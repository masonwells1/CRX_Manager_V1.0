-- ============================================================================
-- Migration: Add MG and g inventory units + Jar container type
-- Purpose: Support products sold by milligram (e.g., Piksi Dust Plus 1800mg/jar)
-- ============================================================================

-- SECTION 1: Add milligram and gram units to unit_conversions
-- 1 dry ounce = 28,349.523125 milligrams
-- So: 1 mg = 1/28349.523125 oz ≈ 0.00003527396
--     1 g  = 1000 mg = 1/28.349523125 oz ≈ 0.03527396

INSERT INTO unit_conversions (unit, factor_oz, unit_type, notes)
VALUES
  ('MG', 0.00003527396, 'dry', '1 milligram = 0.00003527396 dry ounces'),
  ('g',  0.03527396,    'dry', '1 gram = 0.03527396 dry ounces (1000 mg)')
ON CONFLICT (unit) DO NOTHING;


-- SECTION 2: Add 'Jar' to the container_type CHECK constraint
-- Drop the old constraint and re-create with Jar included

DO $$
BEGIN
  -- Drop existing constraint if it exists
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'products'
      AND constraint_type = 'CHECK'
      AND constraint_name = 'products_container_type_check'
  ) THEN
    ALTER TABLE products DROP CONSTRAINT products_container_type_check;
  END IF;

  -- Re-add with Jar included
  ALTER TABLE products
    ADD CONSTRAINT products_container_type_check
      CHECK (container_type IN (
        'Jug', 'Drum', 'Pallet', 'Mini-Bulk', 'Shuttle', 'Bag', 'Tote', 'Ea', 'Jar'
      ));
END $$;
