-- Extend existing app_settings table for OCR confidence thresholds
-- Table already exists (created in 20260206172436) with setting_value as TEXT
-- We need to add a description column and seed the OCR threshold

-- Add description column if not present
ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS description text;

-- Add created_at if not present
ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

-- Seed default OCR threshold (uses text column — store as JSON string)
INSERT INTO app_settings (setting_key, setting_value, description)
VALUES (
  'ocr_confidence_threshold',
  '{"auto_approve": 85, "needs_review": 50}',
  'OCR confidence thresholds. auto_approve: tickets above this auto-approve. needs_review: below this get flagged red.'
)
ON CONFLICT (setting_key) DO NOTHING;
