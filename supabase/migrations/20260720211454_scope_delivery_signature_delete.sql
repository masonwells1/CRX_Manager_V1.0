-- Applied live as server-assigned ledger version 20260720211454.
-- Complete delivery-signature Storage hardening by replacing the legacy
-- bucket-wide DELETE policy with a canonical delivery-path and active-role gate.

LOCK TABLE storage.objects, public.deliveries IN SHARE ROW EXCLUSIVE MODE;

DROP POLICY IF EXISTS "delivery_signatures_delete" ON storage.objects;
DROP POLICY IF EXISTS "delivery_signatures_scoped_delete" ON storage.objects;

CREATE POLICY "delivery_signatures_scoped_delete"
ON storage.objects
FOR DELETE TO authenticated
USING (
  bucket_id = 'delivery-signatures'
  AND EXISTS (
    SELECT 1
    FROM public.deliveries d
    WHERE name = 'signatures/' || d.id::text || '.png'
      AND (
        public.is_admin()
        OR public.is_sales_rep()
      )
  )
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies p
    WHERE p.schemaname = 'storage'
      AND p.tablename = 'objects'
      AND p.policyname = 'delivery_signatures_scoped_delete'
      AND p.cmd = 'DELETE'
      AND p.qual LIKE '%signatures/%'
      AND p.qual LIKE '%is_admin%'
      AND p.qual LIKE '%is_sales_rep%'
  ) THEN
    RAISE EXCEPTION 'DELIVERY_SIGNATURE_DELETE_POLICY_POSTFLIGHT_FAILED';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_policies p
    WHERE p.schemaname = 'storage'
      AND p.tablename = 'objects'
      AND p.policyname = 'delivery_signatures_delete'
  ) THEN
    RAISE EXCEPTION 'DELIVERY_SIGNATURE_BROAD_DELETE_POLICY_REMAINS';
  END IF;
END;
$$;
