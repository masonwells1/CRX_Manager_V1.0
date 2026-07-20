DO $$
DECLARE
  v_policy_count integer;
  v_delete_policy_count integer;
  v_bad_policy_count integer;
  v_bucket_public boolean;
  v_delivery_id uuid;
  v_driver_id uuid;
  v_object_id uuid;
  v_insert_delivery_id uuid;
  v_deny_delivery_id uuid;
  v_stranger_id uuid;
  v_rows integer;
  v_inserted_id uuid;
  v_denied boolean := false;
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
  INTO v_delete_policy_count
  FROM pg_policies p
  WHERE p.schemaname = 'storage'
    AND p.tablename = 'objects'
    AND p.policyname = 'delivery_signatures_scoped_delete'
    AND p.cmd = 'DELETE'
    AND p.qual LIKE '%signatures/%'
    AND p.qual LIKE '%is_admin%'
    AND p.qual LIKE '%is_sales_rep%';

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
      'delivery_signatures_update',
      'delivery_signatures_delete'
    );

  SELECT public INTO v_bucket_public
  FROM storage.buckets
  WHERE id = 'delivery-signatures';

  IF v_policy_count <> 3 OR v_delete_policy_count <> 1 OR
     v_bad_policy_count <> 0 OR v_bucket_public IS DISTINCT FROM false THEN
    RAISE EXCEPTION
      'SMOKE_FAIL: delivery signature Storage access remains broad (scoped=%, delete=%, broad=%, public=%)',
      v_policy_count, v_delete_policy_count, v_bad_policy_count, v_bucket_public;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM storage.objects o
    WHERE o.bucket_id = 'delivery-signatures'
      AND o.name !~ '^signatures/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$'
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: malformed delivery signature object path remains';
  END IF;

  SELECT d.id, d.assigned_driver, o.id
  INTO v_delivery_id, v_driver_id, v_object_id
  FROM public.deliveries d
  JOIN storage.objects o
    ON o.bucket_id = 'delivery-signatures'
   AND o.name = 'signatures/' || d.id::text || '.png'
  WHERE d.status = 'completed'
    AND d.assigned_driver IS NOT NULL
  ORDER BY d.id
  LIMIT 1;

  SELECT d.id
  INTO v_insert_delivery_id
  FROM public.deliveries d
  WHERE d.status = 'completed'
    AND d.assigned_driver = v_driver_id
    AND NOT EXISTS (
      SELECT 1 FROM storage.objects o
      WHERE o.bucket_id = 'delivery-signatures'
        AND o.name = 'signatures/' || d.id::text || '.png'
    )
  ORDER BY d.id
  LIMIT 1;

  SELECT d.id
  INTO v_deny_delivery_id
  FROM public.deliveries d
  WHERE d.status = 'completed'
    AND d.assigned_driver = v_driver_id
    AND d.id <> v_insert_delivery_id
    AND NOT EXISTS (
      SELECT 1 FROM storage.objects o
      WHERE o.bucket_id = 'delivery-signatures'
        AND o.name = 'signatures/' || d.id::text || '.png'
    )
  ORDER BY d.id
  LIMIT 1;

  SELECT p.id
  INTO v_stranger_id
  FROM public.profiles p
  WHERE p.is_active
    AND p.id <> v_driver_id
    AND p.role NOT IN ('admin', 'sales_rep')
  ORDER BY p.id
  LIMIT 1;

  IF v_object_id IS NULL OR v_insert_delivery_id IS NULL OR
     v_deny_delivery_id IS NULL OR v_stranger_id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: assigned-driver signature fixture is unavailable';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_driver_id::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT count(*) INTO v_rows
  FROM storage.objects WHERE id = v_object_id;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: assigned driver cannot read own delivery signature';
  END IF;

  UPDATE storage.objects SET metadata = metadata WHERE id = v_object_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: assigned driver cannot recapture own delivery signature';
  END IF;

  INSERT INTO storage.objects (bucket_id, name, owner_id, metadata)
  VALUES (
    'delivery-signatures',
    'signatures/' || v_insert_delivery_id::text || '.png',
    auth.uid()::text,
    '{"mimetype":"image/png","size":1}'::jsonb
  )
  RETURNING id INTO v_inserted_id;

  EXECUTE 'RESET ROLE';

  PERFORM set_config('request.jwt.claim.sub', v_stranger_id::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT count(*) INTO v_rows
  FROM storage.objects WHERE id = v_object_id;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: unrelated actor can read another delivery signature';
  END IF;

  UPDATE storage.objects SET metadata = metadata WHERE id = v_object_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: unrelated actor can overwrite another delivery signature';
  END IF;

  BEGIN
    INSERT INTO storage.objects (bucket_id, name, owner_id, metadata)
    VALUES (
      'delivery-signatures',
      'signatures/' || v_deny_delivery_id::text || '.png',
      auth.uid()::text,
      '{"mimetype":"image/png","size":1}'::jsonb
    );
  EXCEPTION
    WHEN insufficient_privilege THEN
      v_denied := true;
  END;

  EXECUTE 'RESET ROLE';
  IF NOT v_denied THEN
    RAISE EXCEPTION 'SMOKE_FAIL: unrelated actor can upload another delivery signature';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$$;
