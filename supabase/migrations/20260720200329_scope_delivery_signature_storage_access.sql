-- Scope delivery-signature Storage access to the delivery named by the object path.
-- Paths are canonical: signatures/<delivery uuid>.png.

LOCK TABLE storage.objects, public.deliveries IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM storage.objects o
    WHERE o.bucket_id = 'delivery-signatures'
      AND o.name !~ '^signatures/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$'
  ) THEN
    RAISE EXCEPTION 'DELIVERY_SIGNATURE_PATH_PREFLIGHT_FAILED';
  END IF;
END;
$$;

UPDATE storage.buckets
SET public = false
WHERE id = 'delivery-signatures';

DROP POLICY IF EXISTS "Authenticated users can read signatures" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can upload signatures" ON storage.objects;
DROP POLICY IF EXISTS "delivery_signatures_insert" ON storage.objects;
DROP POLICY IF EXISTS "delivery_signatures_select" ON storage.objects;
DROP POLICY IF EXISTS "delivery_signatures_update" ON storage.objects;
DROP POLICY IF EXISTS "delivery_signatures_scoped_select" ON storage.objects;
DROP POLICY IF EXISTS "delivery_signatures_scoped_insert" ON storage.objects;
DROP POLICY IF EXISTS "delivery_signatures_scoped_update" ON storage.objects;

CREATE POLICY "delivery_signatures_scoped_select"
ON storage.objects
FOR SELECT TO authenticated
USING (
  bucket_id = 'delivery-signatures'
  AND EXISTS (
    SELECT 1
    FROM public.deliveries d
    WHERE name = 'signatures/' || d.id::text || '.png'
      AND (
        public.is_admin()
        OR public.is_sales_rep()
        OR d.assigned_driver = (SELECT auth.uid())
      )
  )
);

CREATE POLICY "delivery_signatures_scoped_insert"
ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'delivery-signatures'
  AND EXISTS (
    SELECT 1
    FROM public.deliveries d
    WHERE name = 'signatures/' || d.id::text || '.png'
      AND d.status = 'completed'
      AND (
        public.is_admin()
        OR public.is_sales_rep()
        OR d.assigned_driver = (SELECT auth.uid())
      )
  )
);

-- Supabase Storage upsert performs an UPDATE when a signature is recaptured.
CREATE POLICY "delivery_signatures_scoped_update"
ON storage.objects
FOR UPDATE TO authenticated
USING (
  bucket_id = 'delivery-signatures'
  AND EXISTS (
    SELECT 1
    FROM public.deliveries d
    WHERE name = 'signatures/' || d.id::text || '.png'
      AND d.status = 'completed'
      AND (
        public.is_admin()
        OR public.is_sales_rep()
        OR d.assigned_driver = (SELECT auth.uid())
      )
  )
)
WITH CHECK (
  bucket_id = 'delivery-signatures'
  AND EXISTS (
    SELECT 1
    FROM public.deliveries d
    WHERE name = 'signatures/' || d.id::text || '.png'
      AND d.status = 'completed'
      AND (
        public.is_admin()
        OR public.is_sales_rep()
        OR d.assigned_driver = (SELECT auth.uid())
      )
  )
);

DO $$
DECLARE
  v_policy_count integer;
BEGIN
  SELECT count(*)
  INTO v_policy_count
  FROM pg_policies p
  WHERE p.schemaname = 'storage'
    AND p.tablename = 'objects'
    AND p.policyname IN (
      'delivery_signatures_scoped_select',
      'delivery_signatures_scoped_insert',
      'delivery_signatures_scoped_update'
    );

  IF v_policy_count <> 3 THEN
    RAISE EXCEPTION 'DELIVERY_SIGNATURE_POLICY_POSTFLIGHT_FAILED';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_policies p
    WHERE p.schemaname = 'storage'
      AND p.tablename = 'objects'
      AND p.policyname IN (
        'Authenticated users can read signatures',
        'Authenticated users can upload signatures',
        'delivery_signatures_insert',
        'delivery_signatures_select',
        'delivery_signatures_update'
      )
  ) THEN
    RAISE EXCEPTION 'DELIVERY_SIGNATURE_BROAD_POLICY_REMAINS';
  END IF;

  IF EXISTS (
    SELECT 1 FROM storage.buckets
    WHERE id = 'delivery-signatures' AND public
  ) THEN
    RAISE EXCEPTION 'DELIVERY_SIGNATURE_BUCKET_MUST_BE_PRIVATE';
  END IF;
END;
$$;
