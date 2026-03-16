-- Add internal_notes column to products table
-- Existing `notes` column stays as-is (grower-facing description)
-- New `internal_notes` column for internal-only notes (never shown to growers)

ALTER TABLE products ADD COLUMN IF NOT EXISTS internal_notes text;

-- Copy existing notes to internal_notes so both start with same content
UPDATE products SET internal_notes = notes WHERE notes IS NOT NULL;
