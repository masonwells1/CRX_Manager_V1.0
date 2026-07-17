-- ============================================================================
-- DRAFT ONLY — CRM relationship-intelligence Phase 4.1 customer documents.
-- The orchestrator must rename/move this file to supabase/migrations with a
-- real UTC timestamp only after the migration review/apply gate is green.
-- ============================================================================

-- Private object storage for customer document bytes. 20 MiB; UI must use the
-- same MIME allow-list before upload, but the bucket remains the hard limit.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'customer-documents',
  'customer-documents',
  false,
  20971520,
  ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- Object paths are always '<customer_uuid>/<opaque-filename>'. Comparing the
-- first path segment to c.id::text deliberately avoids casting an untrusted
-- storage path to uuid while still requiring an existing customer folder.
DROP POLICY IF EXISTS customer_documents_objects_admin_select ON storage.objects;
CREATE POLICY customer_documents_objects_admin_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'customer-documents'
    AND public.is_admin()
  );

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
  );

DROP POLICY IF EXISTS customer_documents_objects_admin_insert ON storage.objects;
CREATE POLICY customer_documents_objects_admin_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'customer-documents'
    AND public.is_admin()
    AND EXISTS (
      SELECT 1
      FROM public.customers c
      WHERE c.id::text = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS customer_documents_objects_rep_insert ON storage.objects;
CREATE POLICY customer_documents_objects_rep_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'customer-documents'
    AND public.is_sales_rep()
    AND EXISTS (
      SELECT 1
      FROM public.customers c
      WHERE c.id::text = (storage.foldername(name))[1]
        AND c.assigned_sales_rep = (SELECT auth.uid())
    )
  );

-- User-facing removal is a metadata soft-delete. Only an administrator may
-- physically purge object bytes, and no storage UPDATE policy permits upsert.
DROP POLICY IF EXISTS customer_documents_objects_admin_delete ON storage.objects;
CREATE POLICY customer_documents_objects_admin_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'customer-documents'
    AND public.is_admin()
  );

CREATE TABLE public.customer_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  contact_id uuid REFERENCES public.customer_contacts(id),
  document_type text NOT NULL,
  storage_path text NOT NULL,
  filename text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  uploaded_by uuid NOT NULL REFERENCES public.profiles(id),
  source text NOT NULL DEFAULT 'rep',
  effective_date date,
  expiration_date date,
  notes text,
  deleted_at timestamptz,
  deleted_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_documents_storage_path_key UNIQUE (storage_path),
  CONSTRAINT customer_documents_document_type_check CHECK (document_type IN (
    'license', 'permit', 'contract', 'map', 'invoice_copy', 'other'
  )),
  CONSTRAINT customer_documents_size_bytes_check CHECK (size_bytes > 0),
  CONSTRAINT customer_documents_source_check CHECK (source IN (
    'rep', 'ai_receptionist', 'system', 'web_store'
  )),
  CONSTRAINT customer_documents_effective_expiration_check CHECK (
    expiration_date IS NULL
    OR effective_date IS NULL
    OR expiration_date >= effective_date
  ),
  CONSTRAINT customer_documents_soft_delete_stamp_check CHECK (
    (deleted_at IS NULL AND deleted_by IS NULL)
    OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL)
  )
);

CREATE INDEX customer_documents_customer_deleted_at_idx
  ON public.customer_documents (customer_id, deleted_at);
CREATE INDEX customer_documents_expiration_date_active_idx
  ON public.customer_documents (expiration_date)
  WHERE expiration_date IS NOT NULL AND deleted_at IS NULL;

CREATE TRIGGER customer_documents_update_updated_at
  BEFORE UPDATE ON public.customer_documents
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- A document's byte identity and origin are immutable. The only user-visible
-- edits are notes, classification/dates, and a one-way metadata soft-delete.
CREATE OR REPLACE FUNCTION public.guard_customer_document_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.customer_id IS DISTINCT FROM NEW.customer_id
     OR OLD.contact_id IS DISTINCT FROM NEW.contact_id
     OR OLD.storage_path IS DISTINCT FROM NEW.storage_path
     OR OLD.filename IS DISTINCT FROM NEW.filename
     OR OLD.mime_type IS DISTINCT FROM NEW.mime_type
     OR OLD.size_bytes IS DISTINCT FROM NEW.size_bytes
     OR OLD.uploaded_by IS DISTINCT FROM NEW.uploaded_by
     OR OLD.source IS DISTINCT FROM NEW.source
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION
      'customer document identity and provenance are immutable';
  END IF;

  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'soft-deleted customer documents cannot be modified';
  END IF;

  IF NEW.deleted_at IS NULL AND NEW.deleted_by IS NOT NULL THEN
    RAISE EXCEPTION 'deleted_by requires deleted_at';
  END IF;

  IF NEW.deleted_at IS NOT NULL
     AND NEW.deleted_by IS DISTINCT FROM (SELECT auth.uid()) THEN
    RAISE EXCEPTION 'soft-delete attribution must match the acting user';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER customer_documents_guard_editable_fields
  BEFORE UPDATE ON public.customer_documents
  FOR EACH ROW EXECUTE FUNCTION public.guard_customer_document_update();

ALTER TABLE public.customer_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY customer_documents_admin_select ON public.customer_documents
  FOR SELECT TO authenticated
  USING (public.is_admin());

CREATE POLICY customer_documents_rep_select ON public.customer_documents
  FOR SELECT TO authenticated
  USING (
    public.is_sales_rep()
    AND customer_documents.deleted_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM public.customers c
      WHERE c.id = customer_documents.customer_id
        AND c.assigned_sales_rep = (SELECT auth.uid())
    )
  );

CREATE POLICY customer_documents_admin_insert ON public.customer_documents
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_admin()
    AND customer_documents.uploaded_by = (SELECT auth.uid())
  );

CREATE POLICY customer_documents_rep_insert ON public.customer_documents
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_sales_rep()
    AND customer_documents.uploaded_by = (SELECT auth.uid())
    AND customer_documents.source = 'rep'
    AND EXISTS (
      SELECT 1
      FROM public.customers c
      WHERE c.id = customer_documents.customer_id
        AND c.assigned_sales_rep = (SELECT auth.uid())
    )
  );

CREATE POLICY customer_documents_admin_update ON public.customer_documents
  FOR UPDATE TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY customer_documents_rep_update ON public.customer_documents
  FOR UPDATE TO authenticated
  USING (
    public.is_sales_rep()
    AND customer_documents.deleted_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM public.customers c
      WHERE c.id = customer_documents.customer_id
        AND c.assigned_sales_rep = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    public.is_sales_rep()
    AND EXISTS (
      SELECT 1
      FROM public.customers c
      WHERE c.id = customer_documents.customer_id
        AND c.assigned_sales_rep = (SELECT auth.uid())
    )
  );

-- There is deliberately no DELETE policy: RLS denies hard deletes. Matching
-- table privileges omit DELETE as a second, independent guard.
REVOKE ALL ON TABLE public.customer_documents FROM anon, PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE public.customer_documents TO authenticated;

COMMENT ON TABLE public.customer_documents IS
  'Private customer document metadata; file bytes live in the customer-documents Storage bucket and removals are soft deletes.';
COMMENT ON COLUMN public.customer_documents.id IS 'Stable customer-document identifier.';
COMMENT ON COLUMN public.customer_documents.customer_id IS 'Customer that owns the document.';
COMMENT ON COLUMN public.customer_documents.contact_id IS 'Optional customer contact the document concerns.';
COMMENT ON COLUMN public.customer_documents.document_type IS 'Controlled business classification for the document.';
COMMENT ON COLUMN public.customer_documents.storage_path IS 'Immutable object path in the private customer-documents bucket.';
COMMENT ON COLUMN public.customer_documents.filename IS 'Original human-readable file name.';
COMMENT ON COLUMN public.customer_documents.mime_type IS 'Verified MIME type recorded at upload.';
COMMENT ON COLUMN public.customer_documents.size_bytes IS 'Positive object size in bytes recorded at upload.';
COMMENT ON COLUMN public.customer_documents.uploaded_by IS 'Authenticated profile that created the metadata record.';
COMMENT ON COLUMN public.customer_documents.source IS 'Intake channel that supplied the document.';
COMMENT ON COLUMN public.customer_documents.effective_date IS 'Optional date when the document becomes effective.';
COMMENT ON COLUMN public.customer_documents.expiration_date IS 'Optional date when the document expires.';
COMMENT ON COLUMN public.customer_documents.notes IS 'Optional user-maintained context for the document.';
COMMENT ON COLUMN public.customer_documents.deleted_at IS 'When the document was soft-deleted from the user-facing CRM.';
COMMENT ON COLUMN public.customer_documents.deleted_by IS 'Profile that performed the metadata soft-delete.';
COMMENT ON COLUMN public.customer_documents.created_at IS 'When the metadata record was created.';
COMMENT ON COLUMN public.customer_documents.updated_at IS 'When permitted metadata was last updated.';
COMMENT ON CONSTRAINT customer_documents_storage_path_key ON public.customer_documents IS
  'Each metadata record points to one unique Storage object path.';
COMMENT ON CONSTRAINT customer_documents_document_type_check ON public.customer_documents IS
  'Restricts document classification to the CRM document taxonomy.';
COMMENT ON CONSTRAINT customer_documents_size_bytes_check ON public.customer_documents IS
  'Rejects empty or negative-size document metadata.';
COMMENT ON CONSTRAINT customer_documents_source_check ON public.customer_documents IS
  'Restricts provenance to the shared CRM intake-channel taxonomy.';
COMMENT ON CONSTRAINT customer_documents_effective_expiration_check ON public.customer_documents IS
  'An expiration date cannot precede an effective date.';
COMMENT ON CONSTRAINT customer_documents_soft_delete_stamp_check ON public.customer_documents IS
  'Soft-delete timestamp and actor must be present together.';
COMMENT ON INDEX public.customer_documents_customer_deleted_at_idx IS
  'Supports active/deleted document lists for one customer.';
COMMENT ON INDEX public.customer_documents_expiration_date_active_idx IS
  'Supports active document expiration worklists.';
COMMENT ON FUNCTION public.guard_customer_document_update() IS
  'Makes document identity and provenance immutable and enforces one-way attributable soft deletes.';
COMMENT ON TRIGGER customer_documents_update_updated_at ON public.customer_documents IS
  'Maintains updated_at for permitted document metadata changes.';
COMMENT ON TRIGGER customer_documents_guard_editable_fields ON public.customer_documents IS
  'Blocks updates outside permitted metadata fields and protects document provenance.';
COMMENT ON POLICY customer_documents_objects_admin_select ON storage.objects IS
  'Authenticated administrators may read objects in the private customer-documents bucket.';
COMMENT ON POLICY customer_documents_objects_rep_select ON storage.objects IS
  'Authenticated sales representatives may read objects only in folders for customers assigned to them.';
COMMENT ON POLICY customer_documents_objects_admin_insert ON storage.objects IS
  'Authenticated administrators may upload only beneath an existing customer UUID folder.';
COMMENT ON POLICY customer_documents_objects_rep_insert ON storage.objects IS
  'Authenticated sales representatives may upload only beneath folders for customers assigned to them.';
COMMENT ON POLICY customer_documents_objects_admin_delete ON storage.objects IS
  'Authenticated administrators alone may physically purge customer-document bytes.';
COMMENT ON POLICY customer_documents_admin_select ON public.customer_documents IS
  'Authenticated administrators may read all document metadata, including soft-deleted rows.';
COMMENT ON POLICY customer_documents_rep_select ON public.customer_documents IS
  'Authenticated sales representatives may read active document metadata for customers assigned to them.';
COMMENT ON POLICY customer_documents_admin_insert ON public.customer_documents IS
  'Authenticated administrators may insert document metadata only as themselves.';
COMMENT ON POLICY customer_documents_rep_insert ON public.customer_documents IS
  'Authenticated sales representatives may insert rep-sourced metadata only for customers assigned to them and as themselves.';
COMMENT ON POLICY customer_documents_admin_update ON public.customer_documents IS
  'Authenticated administrators may perform only updates allowed by the document guard trigger.';
COMMENT ON POLICY customer_documents_rep_update ON public.customer_documents IS
  'Authenticated sales representatives may update active metadata only for customers assigned to them, subject to the document guard trigger.';
