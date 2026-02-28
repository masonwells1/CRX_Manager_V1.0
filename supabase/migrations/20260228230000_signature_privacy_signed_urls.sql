-- Migration: Delivery signature privacy — switch to signed URLs
-- Sprint 3a: Make delivery-signatures bucket private + migrate stored URLs to paths
--
-- Previously, signature_url stored full public URLs like:
--   https://xxx.supabase.co/storage/v1/object/public/delivery-signatures/signatures/abc.png
--
-- Now we store just the storage path (e.g., "signatures/abc.png") and generate
-- time-limited signed URLs on the frontend. This prevents permanent public
-- access to customer signatures (PII).

-- Step 1: Make the bucket private
UPDATE storage.buckets SET public = false WHERE id = 'delivery-signatures';

-- Step 2: Migrate existing signature_url values from full URLs to paths
-- Extract everything after 'delivery-signatures/' in the URL
UPDATE public.deliveries
SET signature_url = regexp_replace(signature_url, '^.*/delivery-signatures/', '')
WHERE signature_url IS NOT NULL
  AND signature_url LIKE '%/delivery-signatures/%';
