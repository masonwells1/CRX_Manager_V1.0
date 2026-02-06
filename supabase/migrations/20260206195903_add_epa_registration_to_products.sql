/*
  # Add EPA Registration Field to Products

  1. Changes
    - Add `epa_registration` text field to `products` table
    - This field will store EPA registration numbers for chemicals/pesticides
    - Field is optional (nullable) as not all products require EPA registration

  2. Notes
    - EPA registration numbers typically follow format: XXXXX-XXX or XXXXX-XXX-XXX
    - Example: 34704-69, 85678-47, 100-1645
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'products' AND column_name = 'epa_registration'
  ) THEN
    ALTER TABLE products ADD COLUMN epa_registration text;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_products_epa_registration ON products(epa_registration);
