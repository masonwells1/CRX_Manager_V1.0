-- Follow-up to 20260511120000_security_audit_2026_05_11.
-- Drops the SELECT policies on the 3 public buckets so the
-- `public_bucket_allows_listing` advisor warning clears.
--
-- These buckets are accessed only via:
--   - upload() (INSERT policy)
--   - getPublicUrl() (URL construction, no policy)
--   - remove() (DELETE policy)
--   - <img src={publicUrl}> (CDN-served, bypasses RLS)
--
-- Verified by grep on 2026-05-11: zero .list() / .download() / .createSignedUrl()
-- calls against delivery-photos, receiving-photos, or team-note-attachments.

BEGIN;

DROP POLICY IF EXISTS "delivery_photos_select" ON storage.objects;
DROP POLICY IF EXISTS "recv_photos_storage_read" ON storage.objects;
DROP POLICY IF EXISTS "Anyone can view team note attachments" ON storage.objects;

COMMIT;
