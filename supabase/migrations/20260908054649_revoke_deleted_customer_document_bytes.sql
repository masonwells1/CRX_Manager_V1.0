-- Customer-document soft delete must revoke byte access from the uploader.
--
-- The original rep storage SELECT policy needed a short owner exception because
-- Supabase Storage evaluates INSERT ... RETURNING before the metadata row is
-- created. That exception was permanent, so an uploader could still read bytes
-- after customer_documents.deleted_at was set.
--
-- Keep only a five-minute, metadata-free upload bootstrap. A SECURITY DEFINER
-- predicate is deliberately required here: the ordinary rep metadata policy
-- hides soft-deleted rows, so an invoker-security NOT EXISTS check would mistake
-- a deleted row for no row and reopen the owner exception.

DO $preflight$
DECLARE
  v_policy_count integer;
  v_policy_contract_count integer;
  v_policy_expression_md5 text;
  v_helper_name_count integer;
  v_helper_candidate_count integer := 0;
  v_helper_execute_grantees text[];
BEGIN
  IF to_regclass('public.customer_documents') IS NULL
     OR to_regclass('storage.objects') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_MISSING: customer document metadata or storage objects table is missing.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute a
    WHERE a.attrelid = 'storage.objects'::regclass
      AND a.attname = 'created_at'
      AND a.atttypid = 'timestamptz'::regtype
      AND a.attnum > 0
      AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_STORAGE_CREATED_AT: storage.objects.created_at timestamptz is required for the bounded upload bootstrap.';
  END IF;

  SELECT count(*),
         count(*) FILTER (
           WHERE p.polcmd = 'r'
             AND p.polpermissive
             AND p.polroles = ARRAY['authenticated'::regrole::oid]
         ),
         max(md5(pg_get_expr(p.polqual, p.polrelid)))
    INTO v_policy_count,
         v_policy_contract_count,
         v_policy_expression_md5
    FROM pg_policy p
   WHERE p.polrelid = 'storage.objects'::regclass
     AND p.polname = 'customer_documents_objects_rep_select';

  IF v_policy_count <> 1
     OR v_policy_contract_count <> 1
     OR v_policy_expression_md5 IS NULL
     OR v_policy_expression_md5 NOT IN (
       'ee3c17cc92ba012469540a7023f2f637', -- reviewed live predecessor
       '4cd59183a79f9d0a1a6325c2361a6161'  -- exact candidate replay
     ) THEN
    RAISE EXCEPTION 'PREFLIGHT_POLICY: customer_documents_objects_rep_select drifted (count %, contract %, expression md5 %).',
      v_policy_count, v_policy_contract_count, v_policy_expression_md5;
  END IF;

  SELECT count(*)
    INTO v_helper_name_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'customer_document_path_has_metadata_for_actor';

  IF v_helper_name_count = 0 THEN
    IF v_policy_expression_md5 <> 'ee3c17cc92ba012469540a7023f2f637' THEN
      RAISE EXCEPTION 'PREFLIGHT_HELPER: candidate policy exists without its exact helper.';
    END IF;
  ELSE
    SELECT count(*) FILTER (
             WHERE p.prosecdef
               AND p.provolatile = 's'
               AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
               AND p.proowner = 'postgres'::regrole::oid
               AND p.prorettype = 'boolean'::regtype::oid
               AND p.proargtypes::text = '25'
               AND p.proargnames IS NOT DISTINCT FROM ARRAY['p_storage_path']::text[]
               AND p.prolang = (SELECT l.oid FROM pg_language l WHERE l.lanname = 'sql')
               AND NOT p.proretset
               AND NOT p.proisstrict
               AND NOT p.proleakproof
               AND md5(p.prosrc) = 'd7297d7a4164bc82e0bddef892b694b8'
               AND obj_description(p.oid, 'pg_proc') =
                 'Returns whether an authorized customer-document actor has any metadata row for a storage path, including soft-deleted rows hidden by ordinary RLS.'
           )
      INTO v_helper_candidate_count
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'customer_document_path_has_metadata_for_actor';

    IF to_regprocedure('public.customer_document_path_has_metadata_for_actor(text)') IS NOT NULL THEN
      SELECT array_agg(
               CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE acl.grantee::regrole::text END
               ORDER BY CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE acl.grantee::regrole::text END
             ) FILTER (WHERE acl.privilege_type = 'EXECUTE')
        INTO v_helper_execute_grantees
        FROM pg_proc p
        CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
       WHERE p.oid = to_regprocedure('public.customer_document_path_has_metadata_for_actor(text)');
    END IF;

    IF v_helper_name_count <> 1
       OR v_helper_candidate_count <> 1
       OR v_helper_execute_grantees IS DISTINCT FROM ARRAY['authenticated', 'postgres']::text[]
       OR v_policy_expression_md5 <> '4cd59183a79f9d0a1a6325c2361a6161' THEN
      RAISE EXCEPTION 'PREFLIGHT_HELPER: helper drift or overload detected (name count %, candidate count %, grants %, policy md5 %).',
        v_helper_name_count, v_helper_candidate_count, v_helper_execute_grantees, v_policy_expression_md5;
    END IF;
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.customer_document_path_has_metadata_for_actor(
  p_storage_path text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT
    (
      public.is_admin()
      OR (
        public.is_sales_rep()
        AND EXISTS (
          SELECT 1
          FROM public.customers c
          WHERE c.id::text = (storage.foldername(p_storage_path))[1]
            AND c.assigned_sales_rep = (SELECT auth.uid())
        )
      )
    )
    AND EXISTS (
      SELECT 1
      FROM public.customer_documents cd
      WHERE cd.storage_path = p_storage_path
    );
$function$;

REVOKE ALL ON FUNCTION public.customer_document_path_has_metadata_for_actor(text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.customer_document_path_has_metadata_for_actor(text)
  TO authenticated;

COMMENT ON FUNCTION public.customer_document_path_has_metadata_for_actor(text) IS
  'Returns whether an authorized customer-document actor has any metadata row for a storage path, including soft-deleted rows hidden by ordinary RLS.';

DROP POLICY IF EXISTS customer_documents_objects_rep_select ON storage.objects;
CREATE POLICY customer_documents_objects_rep_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'customer-documents'
    AND public.is_sales_rep()
    AND EXISTS (
      SELECT 1
      FROM public.customers c
      WHERE c.id::text = (storage.foldername(name))[1]
        AND c.assigned_sales_rep = (SELECT auth.uid())
    )
    AND (
      EXISTS (
        SELECT 1
        FROM public.customer_documents cd
        WHERE cd.storage_path = storage.objects.name
          AND cd.deleted_at IS NULL
      )
      OR (
        storage.objects.owner_id = (SELECT auth.uid()::text)
        AND storage.objects.created_at >= statement_timestamp() - interval '5 minutes'
        AND NOT public.customer_document_path_has_metadata_for_actor(storage.objects.name)
      )
    )
  );

DO $postflight$
DECLARE
  v_policy_count integer;
  v_policy_expression text;
  v_policy_expression_md5 text;
  v_execute_grantees text[];
  v_function_name_count integer;
  v_function_contract_count integer;
BEGIN
  SELECT count(*),
         max(pg_get_expr(p.polqual, p.polrelid)),
         max(md5(pg_get_expr(p.polqual, p.polrelid)))
    INTO v_policy_count,
         v_policy_expression,
         v_policy_expression_md5
    FROM pg_policy p
   WHERE p.polrelid = 'storage.objects'::regclass
     AND p.polname = 'customer_documents_objects_rep_select'
     AND p.polcmd = 'r'
     AND p.polpermissive
     AND p.polroles = ARRAY['authenticated'::regrole::oid];

  IF v_policy_count <> 1
     OR v_policy_expression_md5 IS DISTINCT FROM '4cd59183a79f9d0a1a6325c2361a6161' THEN
    RAISE EXCEPTION 'POSTFLIGHT_POLICY: rep document-byte policy is not the exact reviewed contract (count %, expression md5 %, expression %).',
      v_policy_count, v_policy_expression_md5, v_policy_expression;
  END IF;

  SELECT count(*),
         count(*) FILTER (
           WHERE p.prosecdef
             AND p.provolatile = 's'
             AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
             AND p.proowner = 'postgres'::regrole::oid
             AND p.prorettype = 'boolean'::regtype::oid
             AND p.proargtypes::text = '25'
             AND p.proargnames IS NOT DISTINCT FROM ARRAY['p_storage_path']::text[]
             AND p.prolang = (SELECT l.oid FROM pg_language l WHERE l.lanname = 'sql')
             AND NOT p.proretset
             AND NOT p.proisstrict
             AND NOT p.proleakproof
             AND md5(p.prosrc) = 'd7297d7a4164bc82e0bddef892b694b8'
             AND obj_description(p.oid, 'pg_proc') =
               'Returns whether an authorized customer-document actor has any metadata row for a storage path, including soft-deleted rows hidden by ordinary RLS.'
         )
    INTO v_function_name_count,
         v_function_contract_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'customer_document_path_has_metadata_for_actor';

  IF v_function_name_count <> 1 OR v_function_contract_count <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FUNCTION: metadata visibility helper drifted (name count %, contract count %).',
      v_function_name_count, v_function_contract_count;
  END IF;

  SELECT array_agg(
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE acl.grantee::regrole::text END
           ORDER BY CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE acl.grantee::regrole::text END
         ) FILTER (WHERE acl.privilege_type = 'EXECUTE')
    INTO v_execute_grantees
    FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
   WHERE p.oid = 'public.customer_document_path_has_metadata_for_actor(text)'::regprocedure;

  IF v_execute_grantees IS DISTINCT FROM ARRAY['authenticated', 'postgres']::text[] THEN
    RAISE EXCEPTION 'POSTFLIGHT_ACL: metadata visibility helper execute grants drifted: %.', v_execute_grantees;
  END IF;
END;
$postflight$;
