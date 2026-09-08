\set ON_ERROR_STOP on

BEGIN;

CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE SCHEMA auth;
CREATE SCHEMA storage;

CREATE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  role text NOT NULL,
  is_active boolean NOT NULL
);

CREATE TABLE public.customers (
  id uuid PRIMARY KEY,
  assigned_sales_rep uuid REFERENCES public.profiles(id)
);

CREATE TABLE public.customer_documents (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  storage_path text NOT NULL UNIQUE,
  uploaded_by uuid NOT NULL REFERENCES public.profiles(id),
  deleted_at timestamptz
);

CREATE TABLE storage.objects (
  id uuid PRIMARY KEY,
  bucket_id text NOT NULL,
  name text NOT NULL UNIQUE,
  owner_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION storage.foldername(p_name text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT string_to_array(p_name, '/');
$$;
GRANT USAGE ON SCHEMA storage TO authenticated;
GRANT EXECUTE ON FUNCTION storage.foldername(text) TO authenticated;

CREATE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = (SELECT auth.uid())
      AND p.role = 'admin'
      AND p.is_active
  );
$$;

CREATE FUNCTION public.is_sales_rep()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = (SELECT auth.uid())
      AND p.role = 'sales_rep'
      AND p.is_active
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_admin(), public.is_sales_rep() TO authenticated;
GRANT SELECT ON public.customers, public.customer_documents TO authenticated;
GRANT SELECT ON storage.objects TO authenticated;

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

CREATE POLICY customers_rep_select ON public.customers
  FOR SELECT TO authenticated
  USING (
    public.is_sales_rep()
    AND assigned_sales_rep = (SELECT auth.uid())
  );

CREATE POLICY customer_documents_rep_select ON public.customer_documents
  FOR SELECT TO authenticated
  USING (
    public.is_sales_rep()
    AND deleted_at IS NULL
    AND EXISTS (
      SELECT 1 FROM public.customers c
      WHERE c.id = customer_documents.customer_id
        AND c.assigned_sales_rep = (SELECT auth.uid())
    )
  );

-- The vulnerable live policy: owner access bypasses metadata liveness forever.
CREATE POLICY customer_documents_objects_rep_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'customer-documents'
    AND public.is_sales_rep()
    AND EXISTS (
      SELECT 1 FROM public.customers c
      WHERE c.id::text = (storage.foldername(name))[1]
        AND c.assigned_sales_rep = (SELECT auth.uid())
    )
    AND (
      storage.objects.owner_id = (SELECT auth.uid()::text)
      OR EXISTS (
        SELECT 1 FROM public.customer_documents cd
        WHERE cd.storage_path = storage.objects.name
          AND cd.deleted_at IS NULL
      )
    )
  );

INSERT INTO public.profiles (id, role, is_active) VALUES
  ('10000000-0000-4000-8000-000000000001', 'sales_rep', true),
  ('10000000-0000-4000-8000-000000000002', 'sales_rep', true),
  ('10000000-0000-4000-8000-000000000003', 'admin', true);

INSERT INTO public.customers (id, assigned_sales_rep) VALUES
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002');

INSERT INTO storage.objects (id, bucket_id, name, owner_id, created_at) VALUES
  ('30000000-0000-4000-8000-000000000001', 'customer-documents', '20000000-0000-4000-8000-000000000001/deleted.pdf', '10000000-0000-4000-8000-000000000001', now()),
  ('30000000-0000-4000-8000-000000000002', 'customer-documents', '20000000-0000-4000-8000-000000000001/live.pdf', '10000000-0000-4000-8000-000000000002', now() - interval '1 day'),
  ('30000000-0000-4000-8000-000000000003', 'customer-documents', '20000000-0000-4000-8000-000000000001/fresh-orphan.pdf', '10000000-0000-4000-8000-000000000001', now()),
  ('30000000-0000-4000-8000-000000000004', 'customer-documents', '20000000-0000-4000-8000-000000000001/old-orphan.pdf', '10000000-0000-4000-8000-000000000001', now() - interval '6 minutes'),
  ('30000000-0000-4000-8000-000000000005', 'customer-documents', '20000000-0000-4000-8000-000000000002/other-customer.pdf', '10000000-0000-4000-8000-000000000001', now());

INSERT INTO public.customer_documents (id, customer_id, storage_path, uploaded_by, deleted_at) VALUES
  ('40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001/deleted.pdf', '10000000-0000-4000-8000-000000000001', now()),
  ('40000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001/live.pdf', '10000000-0000-4000-8000-000000000001', NULL),
  ('40000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002/other-customer.pdf', '10000000-0000-4000-8000-000000000002', now());

SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
SET LOCAL ROLE authenticated;

DO $pre_fix_proof$
BEGIN
  IF (SELECT count(*) FROM storage.objects WHERE name LIKE '%/deleted.pdf') <> 1 THEN
    RAISE EXCEPTION 'PRE_FIX_DISCRIMINATOR_FAILED: vulnerable owner bypass did not expose the deleted object.';
  END IF;
END;
$pre_fix_proof$;

RESET ROLE;

\i /tmp/20260908054649_revoke_deleted_customer_document_bytes.sql
-- Exact replay is a supported preflight state and must remain a no-op success.
\i /tmp/20260908054649_revoke_deleted_customer_document_bytes.sql

SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
SET LOCAL ROLE authenticated;

DO $post_fix_proof$
DECLARE
  v_names text[];
BEGIN
  SELECT array_agg(name ORDER BY name)
    INTO v_names
    FROM storage.objects;

  IF v_names IS DISTINCT FROM ARRAY[
    '20000000-0000-4000-8000-000000000001/fresh-orphan.pdf',
    '20000000-0000-4000-8000-000000000001/live.pdf'
  ]::text[] THEN
    RAISE EXCEPTION 'POST_FIX_VISIBILITY: expected fresh bootstrap plus live metadata only, got %.', v_names;
  END IF;

  IF public.customer_document_path_has_metadata_for_actor(
       '20000000-0000-4000-8000-000000000001/deleted.pdf'
     ) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'POST_FIX_HELPER: authorized rep cannot detect hidden soft-deleted metadata.';
  END IF;

  IF public.customer_document_path_has_metadata_for_actor(
       '20000000-0000-4000-8000-000000000002/other-customer.pdf'
     ) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'POST_FIX_HELPER_SCOPE: rep can probe metadata outside their assigned customer.';
  END IF;
END;
$post_fix_proof$;

RESET ROLE;
ROLLBACK;

SELECT 'SMOKE_PASS_ROLLBACK customer_document_soft_delete_bytes' AS result;
