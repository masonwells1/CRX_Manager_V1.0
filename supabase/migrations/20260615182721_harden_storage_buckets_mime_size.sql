-- Harden public storage buckets with MIME-type + size limits (Foundation Ultra Review M1).
--
-- WHAT: delivery-photos / receiving-photos / team-note-attachments were public=true
-- with allowed_mime_types=NULL + file_size_limit=NULL, so any authenticated user could
-- upload ANY file type at ANY size (the UI checks types/size, but the bucket enforced
-- nothing — a direct Storage API call bypassed the UI). This sets image-only MIME
-- allowlists + a 10 MB cap, matching the already-hardened document-uploads (10 MB;
-- pdf+jpeg+png+webp) and delivery-signatures (1 MB; png+jpeg+webp) buckets.
--
-- WHY THIS MIME SET: every uploader to these buckets uses accept="image/*" and runs
-- compressImage (output image/jpeg, or small originals passed through as png/webp/heic);
-- receiving-photos has no frontend uploader at all. The set covers camera uploads +
-- compression output without breaking any current path.
--
-- public/RLS posture is UNCHANGED — this only constrains what can be uploaded.
-- Idempotent (plain UPDATE; re-running is a no-op). Reversible: set the columns back to NULL.
-- sql-safety: exempt — storage.buckets is a Supabase-managed table (not in the public
-- schema registry); allowed_mime_types/file_size_limit are its real columns.

UPDATE storage.buckets
SET allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp','image/heic','image/heif','image/gif'],
    file_size_limit    = 10485760  -- 10 MB
WHERE id IN ('delivery-photos','receiving-photos','team-note-attachments');

DO $$
DECLARE v_bad int;
BEGIN
  SELECT count(*) INTO v_bad
  FROM storage.buckets
  WHERE id IN ('delivery-photos','receiving-photos','team-note-attachments')
    AND (allowed_mime_types IS NULL OR file_size_limit IS NULL);
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'M1 storage hardening incomplete: % bucket(s) still unconstrained', v_bad;
  END IF;
END $$;
