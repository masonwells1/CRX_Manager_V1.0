-- Require the assigned delivery driver to retain an active driver profile
-- before reading, uploading, or recapturing a delivery signature.

LOCK TABLE storage.objects, public.deliveries, public.profiles
  IN SHARE ROW EXCLUSIVE MODE;

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
        OR (
          EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.id = (SELECT auth.uid())
              AND p.role = 'driver'
              AND p.is_active = true
          )
          AND d.assigned_driver = (SELECT auth.uid())
        )
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
        OR (
          EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.id = (SELECT auth.uid())
              AND p.role = 'driver'
              AND p.is_active = true
          )
          AND d.assigned_driver = (SELECT auth.uid())
        )
      )
  )
);

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
        OR (
          EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.id = (SELECT auth.uid())
              AND p.role = 'driver'
              AND p.is_active = true
          )
          AND d.assigned_driver = (SELECT auth.uid())
        )
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
        OR (
          EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.id = (SELECT auth.uid())
              AND p.role = 'driver'
              AND p.is_active = true
          )
          AND d.assigned_driver = (SELECT auth.uid())
        )
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
    )
    AND (
      COALESCE(p.qual, '') LIKE '%FROM profiles%'
      OR COALESCE(p.with_check, '') LIKE '%FROM profiles%'
    )
    AND (
      COALESCE(p.qual, '') LIKE '%assigned_driver%'
      OR COALESCE(p.with_check, '') LIKE '%assigned_driver%'
    )
    AND COALESCE(p.qual, p.with_check, '') LIKE '%role%driver%'
    AND COALESCE(p.qual, p.with_check, '') LIKE '%is_active%true%';

  IF v_policy_count <> 3 THEN
    RAISE EXCEPTION 'DELIVERY_SIGNATURE_ACTIVE_DRIVER_POSTFLIGHT_FAILED';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_policies p
    WHERE p.schemaname = 'storage'
      AND p.tablename = 'objects'
      AND p.policyname IN (
        'delivery_signatures_scoped_select',
        'delivery_signatures_scoped_insert',
        'delivery_signatures_scoped_update'
      )
      AND (
        COALESCE(p.qual, p.with_check, '') LIKE '%assigned_driver%'
        AND (
          COALESCE(p.qual, p.with_check, '') NOT LIKE '%FROM profiles%'
          OR COALESCE(p.qual, p.with_check, '') NOT LIKE '%role%driver%'
          OR COALESCE(p.qual, p.with_check, '') NOT LIKE '%is_active%true%'
        )
      )
  ) THEN
    RAISE EXCEPTION 'DELIVERY_SIGNATURE_INACTIVE_DRIVER_PATH_REMAINS';
  END IF;
END;
$$;
