DO $$
DECLARE
  v_policy_count integer;
  v_bad_policy_count integer;
  v_bucket_public boolean;
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
    AND COALESCE(p.qual, p.with_check, '') LIKE '%signatures/%'
    AND COALESCE(p.qual, p.with_check, '') LIKE '%assigned_driver%'
    AND COALESCE(p.qual, p.with_check, '') LIKE '%auth.uid%';

  SELECT count(*)
  INTO v_bad_policy_count
  FROM pg_policies p
  WHERE p.schemaname = 'storage'
    AND p.tablename = 'objects'
    AND p.policyname IN (
      'Authenticated users can read signatures',
      'Authenticated users can upload signatures',
      'delivery_signatures_insert',
      'delivery_signatures_select',
      'delivery_signatures_update'
    );

  SELECT public INTO v_bucket_public
  FROM storage.buckets
  WHERE id = 'delivery-signatures';

  IF v_policy_count <> 3 OR v_bad_policy_count <> 0 OR v_bucket_public IS DISTINCT FROM false THEN
    RAISE EXCEPTION
      'SMOKE_FAIL: delivery signature Storage access remains broad (scoped=%, broad=%, public=%)',
      v_policy_count, v_bad_policy_count, v_bucket_public;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM storage.objects o
    WHERE o.bucket_id = 'delivery-signatures'
      AND o.name !~ '^signatures/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$'
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: malformed delivery signature object path remains';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$$;
