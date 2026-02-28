-- Phase 3: Bucket-based prepay system
-- Adds a soft label to prepay_credits for earmarking dollars by purpose.
-- One check → multiple rows in prepay_credits, each with a bucket_label.

-- Single new column: a human-readable earmark label
ALTER TABLE public.prepay_credits
  ADD COLUMN IF NOT EXISTS bucket_label text;

-- Seed predefined bucket categories into app_settings
-- Bookkeeper picks from this dropdown; admin can add/edit labels
INSERT INTO public.app_settings (setting_key, setting_value)
VALUES (
  'prepay_bucket_labels',
  '["Corn Chemical","Soybean Chemical","Corn Fungicide","Soybean Fungicide","Nutritionals","Application","Parts/Service","General"]'
)
ON CONFLICT (setting_key) DO NOTHING;

-- Index for grouping by check reference
CREATE INDEX IF NOT EXISTS idx_prepay_credits_reference
  ON public.prepay_credits (customer_id, reference_number)
  WHERE balance_cents > 0;
