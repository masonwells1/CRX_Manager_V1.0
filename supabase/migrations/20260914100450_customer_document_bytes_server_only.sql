-- Customer-document bytes become reachable only through the
-- customer-document-files Edge Function (PR #635, Codex P1).
--
-- Any browser user with Storage SELECT on an object can call createSignedUrl
-- with an expiry of their choosing. A signed URL is a bearer token that Storage
-- never re-checks against RLS, so a link minted while a document was live kept
-- working after the document was soft-deleted. Narrowing the SELECT policy
-- cannot close that: whoever may read may also sign.
--
-- So browsers get no Storage policy at all on this bucket. The Edge Function
-- (service role) re-reads customer_documents on every download and refuses
-- soft-deleted rows, and it issues single-path upload tokens that grant no read.
-- The admin DELETE policy goes too: Storage deletes use RETURNING, which needs a
-- SELECT policy, so without one it could no longer delete anything anyway.
--
-- storage_path must also be exactly the shape the Edge Function issues
-- ("<customer uuid>/<uuid>-<safe name>"). Browsers still insert metadata rows,
-- and without this a new live row could name a look-alike of a soft-deleted
-- document's path (a "#", "?" or "%" variant that Storage resolves to the same
-- object) and download the removed bytes through the function.
--
-- DEPLOY ORDER: deploy the Edge Function and ship the frontend that calls it
-- BEFORE applying this migration, or the Documents tab cannot upload or
-- download until both are live. Apply it promptly after that merge: while this
-- file is on main and unapplied, the pending-migration guard holds every later
-- stamp (20260914100500 onward) behind it.
--
-- STAMP: authored 2026-09-21 but stamped 20260914100450 so it sorts above the
-- live high-water 20260914100400 and below the still-parked 20260914100500..
-- 20260914100900, letting it apply without stranding them. If 20260914100500
-- applies first, restamp this file above the new high-water.

SET LOCAL lock_timeout = '10s';

-- Take the lock DROP POLICY needs anyway BEFORE the empty-bucket check, so no
-- browser can upload and sign an object between that check and the drops.
LOCK TABLE storage.objects IN ACCESS EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_bad_paths integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM storage.buckets
     WHERE id = 'customer-documents' AND public = false
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_BUCKET: private customer-documents bucket is missing or public.';
  END IF;

  -- Until this file applies, the old policies still let a browser mint signed
  -- URLs, and dropping them cannot revoke a URL already minted. The bucket was
  -- empty on 2026-09-21; if any object exists now, a link may already be out,
  -- so stop for a human decision instead of reporting the hole closed.
  IF EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'customer-documents') THEN
    RAISE EXCEPTION 'PREFLIGHT_OBJECTS: customer-documents already holds objects; a signed URL minted under the old policies could outlive this change. Review before applying.';
  END IF;

  SELECT count(*)
    INTO v_bad_paths
    FROM public.customer_documents
   WHERE storage_path !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[A-Za-z0-9_-][A-Za-z0-9._-]{0,179}$';

  IF v_bad_paths <> 0 THEN
    RAISE EXCEPTION 'PREFLIGHT_PATHS: % customer_documents rows have a storage_path outside the server-issued shape.',
      v_bad_paths;
  END IF;
END;
$preflight$;

DROP POLICY IF EXISTS customer_documents_objects_admin_select ON storage.objects;
DROP POLICY IF EXISTS customer_documents_objects_rep_select ON storage.objects;
DROP POLICY IF EXISTS customer_documents_objects_admin_insert ON storage.objects;
DROP POLICY IF EXISTS customer_documents_objects_rep_insert ON storage.objects;
DROP POLICY IF EXISTS customer_documents_objects_admin_delete ON storage.objects;

ALTER TABLE public.customer_documents
  DROP CONSTRAINT IF EXISTS customer_documents_storage_path_shape_check;
ALTER TABLE public.customer_documents
  ADD CONSTRAINT customer_documents_storage_path_shape_check CHECK (
    storage_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[A-Za-z0-9_-][A-Za-z0-9._-]{0,179}$'
  );

COMMENT ON CONSTRAINT customer_documents_storage_path_shape_check ON public.customer_documents IS
  'storage_path must be the exact shape the customer-document-files Edge Function issues, so no row can name a look-alike of another object''s path.';

DO $postflight$
DECLARE
  v_bucket_policies text[];
  v_unscoped_policies text[];
BEGIN
  -- No browser policy of any kind may remain on this bucket.
  SELECT array_agg(p.polname ORDER BY p.polname)
    INTO v_bucket_policies
    FROM pg_policy p
   WHERE p.polrelid = 'storage.objects'::regclass
     AND (
       coalesce(pg_get_expr(p.polqual, p.polrelid), '') ILIKE '%customer-documents%'
       OR coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ILIKE '%customer-documents%'
     );

  IF v_bucket_policies IS NOT NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_POLICY: customer-documents still has browser Storage policies: %.',
      v_bucket_policies;
  END IF;

  -- Every other storage.objects expression must be pinned to one named bucket
  -- as its first top-level AND term; anything else (an OR, an unscoped policy)
  -- could silently cover this bucket too, so it stops the apply for a look.
  SELECT array_agg(p.polname ORDER BY p.polname)
    INTO v_unscoped_policies
    FROM pg_policy p
   CROSS JOIN LATERAL (
     VALUES (pg_get_expr(p.polqual, p.polrelid)), (pg_get_expr(p.polwithcheck, p.polrelid))
   ) AS e(expr)
   WHERE p.polrelid = 'storage.objects'::regclass
     AND e.expr IS NOT NULL
     AND e.expr !~ '^(\(bucket_id = ''[^'']+''::text\)|\(\(bucket_id = ''[^'']+''::text\) AND .*\))$';

  IF v_unscoped_policies IS NOT NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_UNSCOPED: storage.objects policies not pinned to a single bucket: %.',
      v_unscoped_policies;
  END IF;

  -- The check above skips a missing expression. A policy with no governing
  -- expression (no USING on SELECT/UPDATE/DELETE/ALL, no WITH CHECK on INSERT)
  -- names no bucket at all; PostgreSQL 17 was observed to grant nothing through
  -- one, but it is drift either way, so it stops the apply for a look.
  SELECT array_agg(p.polname ORDER BY p.polname)
    INTO v_unscoped_policies
    FROM pg_policy p
   WHERE p.polrelid = 'storage.objects'::regclass
     AND (
       (p.polcmd = 'a' AND p.polwithcheck IS NULL)
       OR (p.polcmd <> 'a' AND p.polqual IS NULL)
     );

  IF v_unscoped_policies IS NOT NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_UNSCOPED: storage.objects policies with no bucket condition: %.',
      v_unscoped_policies;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM storage.buckets
     WHERE id = 'customer-documents' AND public = false
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_BUCKET: customer-documents bucket must stay private.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.customer_documents'::regclass
       AND conname = 'customer_documents_storage_path_shape_check'
       AND contype = 'c'
       AND convalidated
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_PATH_SHAPE: storage_path shape constraint is missing or not validated.';
  END IF;

  -- The rest of the design leans on rules from 20260717013415; confirm each
  -- still holds rather than trusting that migration's text.

  -- With no policies left, RLS being on is what keeps browsers out entirely.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'storage.objects'::regclass) THEN
    RAISE EXCEPTION 'POSTFLIGHT_OBJECTS_RLS: row level security is off on storage.objects.';
  END IF;

  -- A path can never be reused, even after its row is soft-deleted, so a new
  -- row cannot name a removed document's object.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.customer_documents'::regclass
       AND conname = 'customer_documents_storage_path_key'
       AND pg_get_constraintdef(oid) = 'UNIQUE (storage_path)'
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_PATH_UNIQUE: full UNIQUE (storage_path) is missing.';
  END IF;

  -- The path's folder must be the row's own customer. Pinned to its exact
  -- definition, so a weakened check under the same name stops the apply.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.customer_documents'::regclass
       AND conname = 'customer_documents_path_matches_customer_check'
       AND contype = 'c'
       AND convalidated
       AND pg_get_constraintdef(oid) = 'CHECK (((split_part(storage_path, ''/''::text, 1) = (customer_id)::text) AND (split_part(storage_path, ''/''::text, 2) <> ''''::text) AND (storage_path !~~ ''%/%/%''::text)))'
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_PATH_CUSTOMER: path-matches-customer check is missing, not validated, or changed.';
  END IF;

  -- Upload tokens carry no size or type limit of their own; the bucket's
  -- limits are what bind the uploaded bytes. They must match what the page and
  -- function accept exactly: wider lets other files in, narrower breaks uploads.
  IF NOT EXISTS (
    SELECT 1 FROM storage.buckets
     WHERE id = 'customer-documents'
       AND file_size_limit = 20971520
       AND allowed_mime_types IS NOT NULL
       AND allowed_mime_types <@ ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp']::text[]
       AND allowed_mime_types @> ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp']::text[]
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_BUCKET_LIMITS: customer-documents size or type limits differ from the 20 MiB PDF/JPEG/PNG/WebP the function allows.';
  END IF;
END;
$postflight$;
