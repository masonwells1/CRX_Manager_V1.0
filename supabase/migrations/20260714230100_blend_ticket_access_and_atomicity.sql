-- Full-gauntlet remediation: make the blend-ticket surface office-only,
-- enforce upload limits at Storage and database boundaries, and create ticket
-- headers/products/images/queue entries atomically.

-- ---------------------------------------------------------------------------
-- Office-only RLS for every table used by the office-only blend-ticket routes.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Authenticated users can view all blend tickets" ON public.blend_tickets;
DROP POLICY IF EXISTS "Authenticated users can insert blend tickets" ON public.blend_tickets;
DROP POLICY IF EXISTS "Users can update their own tickets or admin can update any" ON public.blend_tickets;
DROP POLICY IF EXISTS "blend_tickets_admin_delete" ON public.blend_tickets;
DROP POLICY IF EXISTS blend_tickets_office_all ON public.blend_tickets;
DROP POLICY IF EXISTS blend_tickets_office_select ON public.blend_tickets;
DROP POLICY IF EXISTS blend_tickets_office_update ON public.blend_tickets;
DROP POLICY IF EXISTS blend_tickets_admin_delete ON public.blend_tickets;
CREATE POLICY blend_tickets_office_select ON public.blend_tickets
  FOR SELECT TO authenticated
  USING (public.is_admin() OR public.is_sales_rep());
CREATE POLICY blend_tickets_office_update ON public.blend_tickets
  FOR UPDATE TO authenticated
  USING (public.is_admin() OR public.is_sales_rep())
  WITH CHECK (public.is_admin() OR public.is_sales_rep());
-- INSERT is RPC-only through create_blend_ticket so uploaded_by cannot be
-- forged. Hard DELETE has no authenticated policy; the UI uses guarded soft
-- deletion so linked/billed/compliance history cannot be cascade-erased.

DROP POLICY IF EXISTS "Authenticated users can view all blend ticket products" ON public.blend_ticket_products;
DROP POLICY IF EXISTS "Users can insert products for their tickets" ON public.blend_ticket_products;
DROP POLICY IF EXISTS "Users can update products for their tickets or admin can update any" ON public.blend_ticket_products;
DROP POLICY IF EXISTS "Users can update products for their tickets or admin can update" ON public.blend_ticket_products;
DROP POLICY IF EXISTS "Users can delete products for their tickets or admin can delete any" ON public.blend_ticket_products;
DROP POLICY IF EXISTS "Users can delete products for their tickets or admin can delete" ON public.blend_ticket_products;
DROP POLICY IF EXISTS blend_ticket_products_office_all ON public.blend_ticket_products;
CREATE POLICY blend_ticket_products_office_all
  ON public.blend_ticket_products
  FOR ALL TO authenticated
  USING (public.is_admin() OR public.is_sales_rep())
  WITH CHECK (public.is_admin() OR public.is_sales_rep());

DROP POLICY IF EXISTS "Authenticated users can view all blend ticket images" ON public.blend_ticket_images;
DROP POLICY IF EXISTS "Users can insert images for their tickets" ON public.blend_ticket_images;
DROP POLICY IF EXISTS "Users can delete images for their tickets or admin can delete any" ON public.blend_ticket_images;
DROP POLICY IF EXISTS "Users can delete images for their tickets or admin can delete a" ON public.blend_ticket_images;
DROP POLICY IF EXISTS blend_ticket_images_office_all ON public.blend_ticket_images;
DROP POLICY IF EXISTS blend_ticket_images_office_select ON public.blend_ticket_images;
CREATE POLICY blend_ticket_images_office_select ON public.blend_ticket_images
  FOR SELECT TO authenticated
  USING (public.is_admin() OR public.is_sales_rep());
-- Metadata INSERT/UPDATE/DELETE is RPC/service-role only. In particular, office
-- callers cannot replace storage_path/image_url and turn OCR into an SSRF path.

DROP POLICY IF EXISTS "Authenticated users can view all queue items" ON public.ocr_processing_queue;
DROP POLICY IF EXISTS "System can insert queue items" ON public.ocr_processing_queue;
DROP POLICY IF EXISTS "System can update queue items" ON public.ocr_processing_queue;
DROP POLICY IF EXISTS "ocr_queue_insert" ON public.ocr_processing_queue;
DROP POLICY IF EXISTS "ocr_queue_update" ON public.ocr_processing_queue;
DROP POLICY IF EXISTS "ocr_queue_select" ON public.ocr_processing_queue;
DROP POLICY IF EXISTS "ocr_processing_queue_admin_delete" ON public.ocr_processing_queue;
DROP POLICY IF EXISTS ocr_processing_queue_office_all ON public.ocr_processing_queue;
DROP POLICY IF EXISTS ocr_processing_queue_office_select ON public.ocr_processing_queue;
CREATE POLICY ocr_processing_queue_office_select ON public.ocr_processing_queue
  FOR SELECT TO authenticated
  USING (public.is_admin() OR public.is_sales_rep());
-- Queue mutation is limited to create_blend_ticket and the service-role worker.

ALTER TABLE public.ocr_processing_queue
  ADD COLUMN IF NOT EXISTS lease_token uuid,
  ADD COLUMN IF NOT EXISTS lease_heartbeat_at timestamptz;

-- A saved reviewer snapshot is authoritative even when a field was deliberately
-- cleared. OCR retries must not repopulate those confirmed blank header values.
ALTER TABLE public.blend_tickets
  ADD COLUMN IF NOT EXISTS manually_corrected_fields text[]
    NOT NULL DEFAULT '{}'::text[];

DROP POLICY IF EXISTS blend_ticket_fields_select ON public.blend_ticket_fields;
DROP POLICY IF EXISTS blend_ticket_fields_insert ON public.blend_ticket_fields;
DROP POLICY IF EXISTS blend_ticket_fields_update ON public.blend_ticket_fields;
DROP POLICY IF EXISTS blend_ticket_fields_delete ON public.blend_ticket_fields;
DROP POLICY IF EXISTS blend_ticket_fields_office_all ON public.blend_ticket_fields;
CREATE POLICY blend_ticket_fields_office_all
  ON public.blend_ticket_fields
  FOR ALL TO authenticated
  USING (public.is_admin() OR public.is_sales_rep())
  WITH CHECK (public.is_admin() OR public.is_sales_rep());

-- Legal application snapshots are RPC-only mutations. Direct office writes
-- could bypass inventory deduction, per-field expansion, lot propagation, and
-- the audited reverse path.
DROP POLICY IF EXISTS app_records_insert ON public.application_records;
DROP POLICY IF EXISTS app_records_update ON public.application_records;

DROP POLICY IF EXISTS bt_order_items_select ON public.blend_ticket_to_order_items;
DROP POLICY IF EXISTS bt_order_items_insert ON public.blend_ticket_to_order_items;
DROP POLICY IF EXISTS bt_order_items_delete ON public.blend_ticket_to_order_items;
DROP POLICY IF EXISTS bt_order_items_office_all ON public.blend_ticket_to_order_items;
DROP POLICY IF EXISTS bt_order_items_office_select ON public.blend_ticket_to_order_items;
CREATE POLICY bt_order_items_office_select ON public.blend_ticket_to_order_items
  FOR SELECT TO authenticated
  USING (public.is_admin() OR public.is_sales_rep());
-- Link mutation is RPC-only through link_blend_ticket_to_order.

ALTER TABLE public.blend_ticket_products
  DROP CONSTRAINT IF EXISTS blend_ticket_products_finite_numbers;
ALTER TABLE public.blend_ticket_products
  ADD CONSTRAINT blend_ticket_products_finite_numbers CHECK (
    quantity::text NOT IN ('NaN', 'Infinity', '-Infinity')
    AND (rate_per_acre IS NULL OR rate_per_acre::text NOT IN ('NaN', 'Infinity', '-Infinity'))
    AND confidence_score::text NOT IN ('NaN', 'Infinity', '-Infinity')
  );

ALTER TABLE public.blend_tickets
  DROP CONSTRAINT IF EXISTS blend_tickets_finite_numbers;
ALTER TABLE public.blend_tickets
  ADD CONSTRAINT blend_tickets_finite_numbers CHECK (
    (total_acres IS NULL OR total_acres::text NOT IN ('NaN', 'Infinity', '-Infinity'))
    AND (total_volume IS NULL OR total_volume::text NOT IN ('NaN', 'Infinity', '-Infinity'))
  );

CREATE OR REPLACE FUNCTION public.enforce_linked_blend_ticket_header_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF (
       NEW.order_link_status = 'linked'
       OR NEW.payment_status = 'billed'
       OR EXISTS (
         SELECT 1 FROM public.invoices
          WHERE blend_ticket_id = NEW.id
            AND deleted_at IS NULL
            AND COALESCE(status, '') NOT IN ('voided', 'cancelled')
       )
       OR EXISTS (
         SELECT 1 FROM public.application_records
          WHERE source_type = 'blend_ticket'
            AND source_id = NEW.id
       )
     )
     AND (
       NEW.status <> 'completed'
       OR NEW.review_status <> 'approved'
       OR NEW.deleted_at IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'BLEND_TICKET_SETTLED_LIFECYCLE_INVALID';
  END IF;

  IF (
       EXISTS (
         SELECT 1 FROM public.invoices
          WHERE blend_ticket_id = NEW.id
            AND deleted_at IS NULL
            AND COALESCE(status, '') NOT IN ('voided', 'cancelled')
       )
       OR EXISTS (
         SELECT 1 FROM public.application_records
          WHERE source_type = 'blend_ticket'
            AND source_id = NEW.id
       )
     )
     AND (
       NEW.customer_id IS DISTINCT FROM OLD.customer_id
       OR NEW.season IS DISTINCT FROM OLD.season
       OR NEW.salesman_id IS DISTINCT FROM OLD.salesman_id
       OR NEW.ticket_date IS DISTINCT FROM OLD.ticket_date
       OR NEW.ticket_time IS DISTINCT FROM OLD.ticket_time
       OR NEW.job_number IS DISTINCT FROM OLD.job_number
       OR NEW.job_id IS DISTINCT FROM OLD.job_id
       OR NEW.invoice_number IS DISTINCT FROM OLD.invoice_number
       OR NEW.field_id IS DISTINCT FROM OLD.field_id
       OR NEW.field_names IS DISTINCT FROM OLD.field_names
       OR NEW.driver_name IS DISTINCT FROM OLD.driver_name
       OR NEW.applicator_id IS DISTINCT FROM OLD.applicator_id
       OR NEW.applicator_name IS DISTINCT FROM OLD.applicator_name
       OR NEW.mixer_name IS DISTINCT FROM OLD.mixer_name
       OR NEW.tank_number IS DISTINCT FROM OLD.tank_number
       OR NEW.vehicle_id IS DISTINCT FROM OLD.vehicle_id
       OR NEW.vehicle_info IS DISTINCT FROM OLD.vehicle_info
       OR NEW.application_service_id IS DISTINCT FROM OLD.application_service_id
       OR NEW.total_acres IS DISTINCT FROM OLD.total_acres
       OR NEW.application_rate IS DISTINCT FROM OLD.application_rate
       OR NEW.total_volume IS DISTINCT FROM OLD.total_volume
       OR NEW.total_volume_unit IS DISTINCT FROM OLD.total_volume_unit
       OR NEW.notes IS DISTINCT FROM OLD.notes
     ) THEN
    RAISE EXCEPTION 'BLEND_TICKET_DOWNSTREAM_CONTENT_LOCKED';
  END IF;

  IF NEW.deleted_at IS NOT NULL
     AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
     AND (
       OLD.order_link_status = 'linked'
       OR OLD.payment_status = 'billed'
       OR EXISTS (
         SELECT 1 FROM public.invoices
          WHERE blend_ticket_id = OLD.id
            AND deleted_at IS NULL
            AND COALESCE(status, '') NOT IN ('voided', 'cancelled')
       )
       OR EXISTS (
         SELECT 1 FROM public.application_records
          WHERE source_type = 'blend_ticket'
            AND source_id = OLD.id
       )
       OR EXISTS (
         SELECT 1 FROM public.ocr_processing_queue
          WHERE blend_ticket_id = OLD.id
            AND status IN ('pending', 'processing')
       )
     ) THEN
    RAISE EXCEPTION 'BLEND_TICKET_DELETE_LIFECYCLE_LOCKED';
  END IF;

  IF NEW.payment_status = 'billed'
     AND NEW.order_link_status <> 'linked'
     AND NOT EXISTS (
       SELECT 1 FROM public.invoices
        WHERE blend_ticket_id = NEW.id
          AND deleted_at IS NULL
          AND COALESCE(status, '') NOT IN ('voided', 'cancelled')
     ) THEN
    RAISE EXCEPTION 'BLEND_TICKET_BILLING_REQUIRES_PROVENANCE';
  END IF;

  IF OLD.payment_status = 'billed'
     AND NEW.payment_status IS DISTINCT FROM 'billed'
     AND EXISTS (
       SELECT 1 FROM public.invoices
        WHERE blend_ticket_id = OLD.id
          AND deleted_at IS NULL
          AND COALESCE(status, '') NOT IN ('voided', 'cancelled')
     ) THEN
    RAISE EXCEPTION 'BLEND_TICKET_ACTIVE_INVOICE_BILLING_LOCK';
  END IF;

  -- Only the link/unlink RPC ordering may change this lifecycle flag: link
  -- rows are inserted before setting linked, and deleted before setting
  -- unlinked. Direct office table updates cannot forge either state.
  IF OLD.order_link_status IS DISTINCT FROM 'linked'
     AND NEW.order_link_status = 'linked'
     AND NOT EXISTS (
       SELECT 1 FROM public.blend_ticket_to_order_items
        WHERE blend_ticket_id = OLD.id
     ) THEN
    RAISE EXCEPTION 'BLEND_TICKET_LINK_STATE_INVALID: linked status requires order-item links';
  END IF;

  IF OLD.order_link_status = 'linked'
     AND NEW.order_link_status IS DISTINCT FROM 'linked'
     AND EXISTS (
       SELECT 1 FROM public.blend_ticket_to_order_items
        WHERE blend_ticket_id = OLD.id
     ) THEN
    RAISE EXCEPTION 'BLEND_TICKET_LINK_STATE_INVALID: remove order-item links before unlinking';
  END IF;

  IF OLD.order_link_status = 'linked'
     AND NEW.order_link_status = 'linked'
     AND (
       NEW.customer_id IS DISTINCT FROM OLD.customer_id
       OR NEW.season IS DISTINCT FROM OLD.season
       OR NEW.salesman_id IS DISTINCT FROM OLD.salesman_id
       OR NEW.ticket_date IS DISTINCT FROM OLD.ticket_date
       OR NEW.ticket_time IS DISTINCT FROM OLD.ticket_time
       OR NEW.job_number IS DISTINCT FROM OLD.job_number
       OR NEW.job_id IS DISTINCT FROM OLD.job_id
       OR NEW.invoice_number IS DISTINCT FROM OLD.invoice_number
       OR NEW.driver_name IS DISTINCT FROM OLD.driver_name
       OR NEW.applicator_id IS DISTINCT FROM OLD.applicator_id
       OR NEW.applicator_name IS DISTINCT FROM OLD.applicator_name
       OR NEW.mixer_name IS DISTINCT FROM OLD.mixer_name
       OR NEW.tank_number IS DISTINCT FROM OLD.tank_number
       OR NEW.vehicle_id IS DISTINCT FROM OLD.vehicle_id
       OR NEW.vehicle_info IS DISTINCT FROM OLD.vehicle_info
       OR NEW.application_service_id IS DISTINCT FROM OLD.application_service_id
       OR NEW.field_id IS DISTINCT FROM OLD.field_id
       OR NEW.field_names IS DISTINCT FROM OLD.field_names
       OR NEW.total_acres IS DISTINCT FROM OLD.total_acres
       OR NEW.application_rate IS DISTINCT FROM OLD.application_rate
       OR NEW.total_volume IS DISTINCT FROM OLD.total_volume
       OR NEW.total_volume_unit IS DISTINCT FROM OLD.total_volume_unit
       OR NEW.notes IS DISTINCT FROM OLD.notes
     ) THEN
    RAISE EXCEPTION 'BLEND_TICKET_LINKED_CONTENT_LOCKED: unlink before changing ticket content';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.enforce_linked_blend_ticket_header_lock()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_linked_blend_ticket_header_lock ON public.blend_tickets;
CREATE TRIGGER trg_linked_blend_ticket_header_lock
  BEFORE UPDATE ON public.blend_tickets
  FOR EACH ROW EXECUTE FUNCTION public.enforce_linked_blend_ticket_header_lock();

CREATE OR REPLACE FUNCTION public.enforce_linked_blend_ticket_product_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_ticket_ids uuid[];
BEGIN
  v_ticket_ids := CASE
    WHEN TG_OP = 'INSERT' THEN ARRAY[NEW.blend_ticket_id]
    WHEN TG_OP = 'DELETE' THEN ARRAY[OLD.blend_ticket_id]
    ELSE ARRAY[OLD.blend_ticket_id, NEW.blend_ticket_id]
  END;

  -- Lock both parents in UUID order so an UPDATE cannot re-parent a product
  -- out of a linked ticket, and concurrent link/edit operations serialize.
  PERFORM id
    FROM public.blend_tickets
   WHERE id = ANY(v_ticket_ids)
   ORDER BY id
   FOR UPDATE;

  IF EXISTS (
    SELECT 1
      FROM public.blend_tickets
     WHERE id = ANY(v_ticket_ids)
       AND order_link_status = 'linked'
  ) THEN
    RAISE EXCEPTION 'BLEND_TICKET_LINKED_CONTENT_LOCKED: unlink before changing products';
  END IF;

  -- A direct invoice does not require an order link. Treat every non-terminal
  -- invoice as downstream provenance, and run as the function owner so invoice
  -- RLS cannot hide an admin-owned invoice from a sales caller. Voided and
  -- cancelled invoices are terminal and intentionally release this lock.
  IF EXISTS (
       SELECT 1
         FROM public.invoices
        WHERE blend_ticket_id = ANY(v_ticket_ids)
          AND deleted_at IS NULL
          AND COALESCE(status, '') NOT IN ('voided', 'cancelled')
     ) OR EXISTS (
       SELECT 1
         FROM public.application_records
        WHERE source_type = 'blend_ticket'
          AND source_id = ANY(v_ticket_ids)
     ) THEN
    RAISE EXCEPTION 'BLEND_TICKET_DOWNSTREAM_CONTENT_LOCKED: reverse downstream records before changing products';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

REVOKE ALL ON FUNCTION public.enforce_linked_blend_ticket_product_lock()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_linked_blend_ticket_product_lock ON public.blend_ticket_products;
CREATE TRIGGER trg_linked_blend_ticket_product_lock
  BEFORE INSERT OR UPDATE OR DELETE ON public.blend_ticket_products
  FOR EACH ROW EXECUTE FUNCTION public.enforce_linked_blend_ticket_product_lock();

-- The editor's optimistic token covers the ticket and its product rows. The
-- original parent trigger used transaction-stable now(), which can miss or
-- even regress across a long-running concurrent transaction. Keep the token
-- server-controlled and strictly monotonic, then touch it after every product
-- mutation (including a re-parent on both OLD and NEW parents).
CREATE OR REPLACE FUNCTION public.update_blend_ticket_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  NEW.updated_at := GREATEST(
    clock_timestamp(),
    COALESCE(OLD.updated_at, '-infinity'::timestamptz) + interval '1 microsecond'
  );
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.touch_blend_ticket_product_parent_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_ticket_ids uuid[];
BEGIN
  v_ticket_ids := CASE
    WHEN TG_OP = 'INSERT' THEN ARRAY[NEW.blend_ticket_id]
    WHEN TG_OP = 'DELETE' THEN ARRAY[OLD.blend_ticket_id]
    ELSE ARRAY[OLD.blend_ticket_id, NEW.blend_ticket_id]
  END;

  PERFORM id
    FROM public.blend_tickets
   WHERE id = ANY(v_ticket_ids)
   ORDER BY id
   FOR UPDATE;

  UPDATE public.blend_tickets
     SET updated_at = clock_timestamp()
   WHERE id = ANY(v_ticket_ids);

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

REVOKE ALL ON FUNCTION public.touch_blend_ticket_product_parent_version()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_blend_ticket_product_parent_version
  ON public.blend_ticket_products;
CREATE TRIGGER trg_blend_ticket_product_parent_version
  AFTER INSERT OR UPDATE OR DELETE ON public.blend_ticket_products
  FOR EACH ROW EXECUTE FUNCTION public.touch_blend_ticket_product_parent_version();

CREATE OR REPLACE FUNCTION public.enforce_blend_ticket_fields_downstream_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_ticket_ids uuid[];
BEGIN
  v_ticket_ids := CASE
    WHEN TG_OP = 'INSERT' THEN ARRAY[NEW.blend_ticket_id]
    WHEN TG_OP = 'DELETE' THEN ARRAY[OLD.blend_ticket_id]
    ELSE ARRAY[OLD.blend_ticket_id, NEW.blend_ticket_id]
  END;

  PERFORM id
    FROM public.blend_tickets
   WHERE id = ANY(v_ticket_ids)
   ORDER BY id
   FOR UPDATE;

  IF EXISTS (
       SELECT 1 FROM public.invoices
        WHERE blend_ticket_id = ANY(v_ticket_ids)
          AND deleted_at IS NULL
          AND COALESCE(status, '') NOT IN ('voided', 'cancelled')
     ) OR EXISTS (
       SELECT 1 FROM public.application_records
        WHERE source_type = 'blend_ticket'
          AND source_id = ANY(v_ticket_ids)
     ) THEN
    RAISE EXCEPTION 'BLEND_TICKET_DOWNSTREAM_FIELDS_LOCKED';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;


REVOKE ALL ON FUNCTION public.enforce_blend_ticket_fields_downstream_lock()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_blend_ticket_fields_downstream_lock ON public.blend_ticket_fields;
CREATE TRIGGER trg_blend_ticket_fields_downstream_lock
  BEFORE INSERT OR UPDATE OR DELETE ON public.blend_ticket_fields
  FOR EACH ROW EXECUTE FUNCTION public.enforce_blend_ticket_fields_downstream_lock();

-- Storage must enforce the same 10 MiB and MIME contract as the application.
UPDATE storage.buckets
   SET file_size_limit = 10485760,
       allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp']::text[]
 WHERE id = 'blend-ticket-images';

DROP POLICY IF EXISTS "blend_ticket_images_insert" ON storage.objects;
DROP POLICY IF EXISTS "blend_ticket_images_select" ON storage.objects;
DROP POLICY IF EXISTS "blend_ticket_images_update" ON storage.objects;
DROP POLICY IF EXISTS "blend_ticket_images_delete" ON storage.objects;

CREATE POLICY "blend_ticket_images_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'blend-ticket-images'
    AND (public.is_admin() OR public.is_sales_rep())
  );

CREATE POLICY "blend_ticket_images_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'blend-ticket-images'
    AND (public.is_admin() OR public.is_sales_rep())
  );

-- Bulk retries intentionally upsert the same stable ticket path after a lost
-- RPC response. UPDATE is therefore required in addition to INSERT/SELECT,
-- but only the original object owner/ticket uploader (or an admin) may mutate
-- bytes, and ownership never bypasses the active office-role gate. This
-- prevents legacy applicator/deactivated owners and other sales accounts from
-- tampering with a ticket.
CREATE POLICY "blend_ticket_images_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'blend-ticket-images'
    AND (
      public.is_admin()
      OR (
        public.is_sales_rep()
        AND (
          owner_id = (SELECT auth.uid())::text
          OR EXISTS (
            SELECT 1 FROM public.blend_tickets bt
             WHERE bt.id::text = (storage.foldername(name))[1]
               AND bt.uploaded_by = (SELECT auth.uid())
          )
        )
      )
    )
  )
  WITH CHECK (
    bucket_id = 'blend-ticket-images'
    AND (
      public.is_admin()
      OR (
        public.is_sales_rep()
        AND (
          owner_id = (SELECT auth.uid())::text
          OR EXISTS (
            SELECT 1 FROM public.blend_tickets bt
             WHERE bt.id::text = (storage.foldername(name))[1]
               AND bt.uploaded_by = (SELECT auth.uid())
          )
        )
      )
    )
  );

CREATE POLICY "blend_ticket_images_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'blend-ticket-images'
    AND (
      public.is_admin()
      OR (
        public.is_sales_rep()
        AND (
          owner_id = (SELECT auth.uid())::text
          OR EXISTS (
            SELECT 1 FROM public.blend_tickets bt
             WHERE bt.id::text = (storage.foldername(name))[1]
               AND bt.uploaded_by = (SELECT auth.uid())
          )
        )
      )
    )
  );

-- ---------------------------------------------------------------------------
-- One transactional creation boundary for manual tickets and OCR uploads.
-- Storage bytes are uploaded first; this RPC atomically commits all database
-- metadata. The client removes uploaded bytes if this transaction definitely
-- fails before a ticket exists.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_blend_ticket(
  p_ticket_id uuid,
  p_ticket_payload jsonb,
  p_products jsonb DEFAULT '[]'::jsonb,
  p_images jsonb DEFAULT '[]'::jsonb,
  p_enqueue_ocr boolean DEFAULT false,
  p_performed_by uuid DEFAULT auth.uid(),
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_ticket_number text;
  v_customer_id uuid;
  v_existing jsonb;
  v_result jsonb;
  v_image_count integer;
  v_product jsonb;
  v_image jsonb;
  v_ordinality bigint;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: active admin or sales role required';
  END IF;
  IF p_ticket_id IS NULL THEN
    RAISE EXCEPTION 'BLEND_TICKET_ID_REQUIRED';
  END IF;
  IF jsonb_typeof(COALESCE(p_ticket_payload, '{}'::jsonb)) <> 'object'
     OR jsonb_typeof(COALESCE(p_products, '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(COALESCE(p_images, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'BLEND_TICKET_PAYLOAD_INVALID';
  END IF;
  IF jsonb_array_length(COALESCE(p_products, '[]'::jsonb)) > 200 THEN
    RAISE EXCEPTION 'BLEND_TICKET_PRODUCT_COUNT_INVALID';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(
      p_idempotency_key,
      'create_blend_ticket'
    );
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  v_customer_id := NULLIF(p_ticket_payload->>'customer_id', '')::uuid;
  IF v_customer_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.customers c
     WHERE c.id = v_customer_id
       AND c.is_active = true
  ) THEN
    RAISE EXCEPTION 'BLEND_TICKET_CUSTOMER_INVALID';
  END IF;

  IF NOT p_enqueue_ocr AND v_customer_id IS NULL THEN
    RAISE EXCEPTION 'BLEND_TICKET_CUSTOMER_REQUIRED';
  END IF;

  IF (NULLIF(p_ticket_payload->>'total_acres', '')::numeric)::text
       IN ('NaN', 'Infinity', '-Infinity')
     OR (NULLIF(p_ticket_payload->>'total_volume', '')::numeric)::text
       IN ('NaN', 'Infinity', '-Infinity')
     OR COALESCE(NULLIF(p_ticket_payload->>'total_acres', '')::numeric, 0) < 0
     OR COALESCE(NULLIF(p_ticket_payload->>'total_volume', '')::numeric, 0) < 0 THEN
    RAISE EXCEPTION 'BLEND_TICKET_NUMERIC_INVALID';
  END IF;

  v_image_count := jsonb_array_length(COALESCE(p_images, '[]'::jsonb));
  IF p_enqueue_ocr AND (v_image_count < 1 OR v_image_count > 20) THEN
    RAISE EXCEPTION 'BLEND_TICKET_IMAGE_COUNT_INVALID: OCR uploads require 1 to 20 images';
  END IF;
  IF NOT p_enqueue_ocr AND v_image_count <> 0 THEN
    RAISE EXCEPTION 'BLEND_TICKET_IMAGE_MODE_INVALID';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(COALESCE(p_images, '[]'::jsonb)) image
     WHERE COALESCE((image->>'file_size')::bigint, 0) < 1
        OR COALESCE((image->>'file_size')::bigint, 0) > 10485760
        OR image->>'mime_type' NOT IN ('image/jpeg', 'image/png', 'image/webp')
        OR NULLIF(btrim(image->>'storage_path'), '') IS NULL
        OR image->>'storage_path' !~ (
          '^' || p_ticket_id::text || '/[1-9][0-9]*\.(jpg|jpeg|png|webp)$'
        )
        OR COALESCE((image->>'upload_order')::integer, 0) < 1
        OR COALESCE((image->>'upload_order')::integer, 0) > 20
  ) THEN
    RAISE EXCEPTION 'BLEND_TICKET_IMAGE_METADATA_INVALID';
  END IF;

  IF (
    SELECT count(DISTINCT image->>'storage_path')
      FROM jsonb_array_elements(COALESCE(p_images, '[]'::jsonb)) image
  ) <> v_image_count OR (
    SELECT count(DISTINCT (image->>'upload_order')::integer)
      FROM jsonb_array_elements(COALESCE(p_images, '[]'::jsonb)) image
  ) <> v_image_count THEN
    RAISE EXCEPTION 'BLEND_TICKET_IMAGE_METADATA_DUPLICATE';
  END IF;

  -- serialize MAX+1 ticket-number generation for this date
  PERFORM pg_advisory_xact_lock(
    hashtextextended('crx:blend-ticket-number:' || current_date::text, 0)
  );
  v_ticket_number := public.generate_ticket_number();

  INSERT INTO public.blend_tickets (
    id, ticket_number, uploaded_by, upload_date,
    customer_id, ticket_date, ticket_time,
    status, review_status, source, ocr_confidence_score,
    signature_detected, job_number, invoice_number,
    driver_name, applicator_name, mixer_name, tank_number, vehicle_info,
    field_names, total_acres, application_rate, total_volume,
    total_volume_unit, notes
  ) VALUES (
    p_ticket_id, v_ticket_number, v_actor, now(),
    v_customer_id,
    NULLIF(p_ticket_payload->>'ticket_date', '')::date,
    NULLIF(p_ticket_payload->>'ticket_time', ''),
    CASE WHEN p_enqueue_ocr THEN 'pending' ELSE 'completed' END,
    'unreviewed',
    CASE WHEN p_enqueue_ocr THEN 'ocr' ELSE 'manual' END,
    CASE WHEN p_enqueue_ocr THEN 0 ELSE 100 END,
    false,
    NULLIF(btrim(p_ticket_payload->>'job_number'), ''),
    NULLIF(btrim(p_ticket_payload->>'invoice_number'), ''),
    NULLIF(btrim(p_ticket_payload->>'driver_name'), ''),
    NULLIF(btrim(p_ticket_payload->>'applicator_name'), ''),
    NULLIF(btrim(p_ticket_payload->>'mixer_name'), ''),
    NULLIF(btrim(p_ticket_payload->>'tank_number'), ''),
    NULLIF(btrim(p_ticket_payload->>'vehicle_info'), ''),
    NULLIF(btrim(p_ticket_payload->>'field_names'), ''),
    NULLIF(p_ticket_payload->>'total_acres', '')::numeric,
    NULLIF(btrim(p_ticket_payload->>'application_rate'), ''),
    NULLIF(p_ticket_payload->>'total_volume', '')::numeric,
    NULLIF(btrim(p_ticket_payload->>'total_volume_unit'), ''),
    NULLIF(btrim(p_ticket_payload->>'notes'), '')
  );

  FOR v_product, v_ordinality IN
    SELECT value, ordinality
      FROM jsonb_array_elements(COALESCE(p_products, '[]'::jsonb))
      WITH ORDINALITY
  LOOP
    IF jsonb_typeof(v_product) <> 'object'
       OR NULLIF(btrim(v_product->>'product_name'), '') IS NULL
       OR COALESCE((v_product->>'quantity')::numeric, 0) < 0
       OR ((v_product->>'quantity')::numeric)::text IN ('NaN', 'Infinity', '-Infinity')
       OR (NULLIF(v_product->>'rate_per_acre', '')::numeric)::text IN ('NaN', 'Infinity', '-Infinity')
       OR COALESCE(NULLIF(v_product->>'rate_per_acre', '')::numeric, 0) < 0
       OR (NULLIF(v_product->>'confidence_score', '')::numeric)::text IN ('NaN', 'Infinity', '-Infinity')
       OR COALESCE(NULLIF(v_product->>'confidence_score', '')::numeric, 0) < 0
       OR COALESCE(NULLIF(v_product->>'confidence_score', '')::numeric, 0) > 100 THEN
      RAISE EXCEPTION 'BLEND_TICKET_PRODUCT_INVALID';
    END IF;
    IF NULLIF(v_product->>'product_id', '') IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.products p
       WHERE p.id = (v_product->>'product_id')::uuid
         AND p.is_active = true
    ) THEN
      RAISE EXCEPTION 'BLEND_TICKET_PRODUCT_MATCH_INVALID';
    END IF;

    INSERT INTO public.blend_ticket_products (
      blend_ticket_id, product_id, product_name, quantity, unit,
      rate_per_acre, rate_per_acre_unit, lot_number, sequence_order,
      confidence_score, manually_corrected
    ) VALUES (
      p_ticket_id,
      NULLIF(v_product->>'product_id', '')::uuid,
      btrim(v_product->>'product_name'),
      COALESCE((v_product->>'quantity')::numeric, 0),
      NULLIF(btrim(v_product->>'unit'), ''),
      NULLIF(v_product->>'rate_per_acre', '')::numeric,
      NULLIF(btrim(v_product->>'rate_per_acre_unit'), ''),
      NULLIF(btrim(v_product->>'lot_number'), ''),
      COALESCE(NULLIF(v_product->>'sequence_order', '')::integer, v_ordinality::integer),
      CASE WHEN p_enqueue_ocr
        THEN COALESCE(NULLIF(v_product->>'confidence_score', '')::numeric, 0)
        ELSE 100
      END,
      false
    );
  END LOOP;

  FOR v_image IN
    SELECT value
      FROM jsonb_array_elements(COALESCE(p_images, '[]'::jsonb))
  LOOP
    INSERT INTO public.blend_ticket_images (
      blend_ticket_id, storage_path, image_url,
      file_size, mime_type, upload_order
    ) VALUES (
      p_ticket_id,
      v_image->>'storage_path',
      v_image->>'storage_path',
      (v_image->>'file_size')::bigint,
      v_image->>'mime_type',
      (v_image->>'upload_order')::integer
    );
  END LOOP;

  IF p_enqueue_ocr THEN
    INSERT INTO public.ocr_processing_queue (
      blend_ticket_id, status, priority, retry_count, max_retries
    ) VALUES (
      p_ticket_id, 'pending', 0, 0, 3
    );
  END IF;

  INSERT INTO public.activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'blend_ticket_created',
    'Blend ticket ' || v_ticket_number ||
      CASE WHEN p_enqueue_ocr THEN ' uploaded for OCR' ELSE ' created manually' END,
    v_actor, 'blend_ticket', p_ticket_id, v_customer_id
  );

  v_result := jsonb_build_object(
    'success', true,
    'ticket_id', p_ticket_id,
    'ticket_number', v_ticket_number
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(
      p_idempotency_key,
      'create_blend_ticket',
      v_result
    );
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.create_blend_ticket(
  uuid, jsonb, jsonb, jsonb, boolean, uuid, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_blend_ticket(
  uuid, jsonb, jsonb, jsonb, boolean, uuid, text
) TO authenticated, service_role;

DO $verify$
DECLARE
  v_source text;
BEGIN
  IF (
    SELECT count(*) FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND proname = 'create_blend_ticket'
  ) <> 1 THEN
    RAISE EXCEPTION 'create_blend_ticket must have exactly one overload';
  END IF;

  SELECT p.prosrc INTO v_source
    FROM pg_proc p
   WHERE p.oid = 'public.create_blend_ticket(uuid,jsonb,jsonb,jsonb,boolean,uuid,text)'::regprocedure;
  IF v_source NOT LIKE '%ACTOR_MISMATCH%'
     OR v_source NOT LIKE '%check_idempotency%'
     OR v_source NOT LIKE '%BLEND_TICKET_IMAGE_METADATA_INVALID%' THEN
    RAISE EXCEPTION 'create_blend_ticket security/atomicity markers missing';
  END IF;

  IF has_function_privilege(
       'anon',
       'public.create_blend_ticket(uuid,jsonb,jsonb,jsonb,boolean,uuid,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'anon must not execute create_blend_ticket';
  END IF;
END;
$verify$;

-- Commit OCR output and queue completion as one transaction. The Edge worker
-- performs slow external OCR outside PostgreSQL, then hands the parsed result
-- to this service-role-only function. The ticket and owned queue lease are
-- locked and all lifecycle conditions are rechecked immediately before any
-- final result becomes visible.
CREATE OR REPLACE FUNCTION public.commit_blend_ticket_ocr_result(
  p_blend_ticket_id uuid,
  p_queue_id uuid,
  p_lease_token uuid,
  p_ticket_update jsonb,
  p_products jsonb,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_ticket public.blend_tickets%ROWTYPE;
  v_queue public.ocr_processing_queue%ROWTYPE;
  v_existing jsonb;
  v_result jsonb;
  v_product jsonb;
  v_status text;
  v_confidence numeric;
  v_quantity numeric;
  v_product_confidence numeric;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'OCR_COMMIT_IDEMPOTENCY_REQUIRED';
  END IF;

  v_existing := public.check_idempotency(
    p_idempotency_key,
    'commit_blend_ticket_ocr_result'
  );
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  IF jsonb_typeof(p_ticket_update) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_products) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_products) > 200 THEN
    RAISE EXCEPTION 'OCR_COMMIT_PAYLOAD_INVALID';
  END IF;

  v_status := btrim(COALESCE(p_ticket_update->>'status', ''));
  IF v_status NOT IN ('completed', 'needs_review') THEN
    RAISE EXCEPTION 'OCR_COMMIT_STATUS_INVALID';
  END IF;

  v_confidence := (p_ticket_update->>'ocr_confidence_score')::numeric;
  IF v_confidence IS NULL
     OR v_confidence::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_confidence < 0 OR v_confidence > 100 THEN
    RAISE EXCEPTION 'OCR_COMMIT_CONFIDENCE_INVALID';
  END IF;

  SELECT * INTO v_ticket
    FROM public.blend_tickets
   WHERE id = p_blend_ticket_id
     AND deleted_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OCR_COMMIT_TICKET_NOT_FOUND';
  END IF;

  SELECT * INTO v_queue
    FROM public.ocr_processing_queue
   WHERE id = p_queue_id
     AND blend_ticket_id = p_blend_ticket_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_queue.status <> 'processing'
     OR v_queue.lease_token IS DISTINCT FROM p_lease_token THEN
    RAISE EXCEPTION 'OCR_COMMIT_LEASE_LOST';
  END IF;

  IF v_ticket.review_status <> 'unreviewed'
     OR v_ticket.order_link_status <> 'unlinked'
     OR v_ticket.payment_status <> 'unbilled' THEN
    RAISE EXCEPTION 'OCR_COMMIT_LIFECYCLE_CHANGED';
  END IF;

  IF EXISTS (
       SELECT 1 FROM public.invoices
        WHERE blend_ticket_id = p_blend_ticket_id
          AND deleted_at IS NULL
          AND COALESCE(status, '') NOT IN ('voided', 'cancelled')
     ) OR EXISTS (
       SELECT 1 FROM public.application_records
        WHERE source_type = 'blend_ticket'
          AND source_id = p_blend_ticket_id
     ) THEN
    RAISE EXCEPTION 'OCR_COMMIT_DOWNSTREAM_RECORD_EXISTS';
  END IF;

  -- Validate the whole product payload before deleting any previous OCR rows.
  FOR v_product IN SELECT value FROM jsonb_array_elements(p_products)
  LOOP
    IF jsonb_typeof(v_product) IS DISTINCT FROM 'object'
       OR NULLIF(btrim(v_product->>'product_name'), '') IS NULL THEN
      RAISE EXCEPTION 'OCR_COMMIT_PRODUCT_INVALID';
    END IF;

    v_quantity := (v_product->>'quantity')::numeric;
    v_product_confidence := NULLIF(v_product->>'confidence_score', '')::numeric;
    IF v_quantity IS NULL
       OR v_quantity::text IN ('NaN', 'Infinity', '-Infinity')
       OR v_quantity < 0
       OR v_product_confidence::text IN ('NaN', 'Infinity', '-Infinity')
       OR v_product_confidence < 0 OR v_product_confidence > 100 THEN
      RAISE EXCEPTION 'OCR_COMMIT_PRODUCT_NUMERIC_INVALID';
    END IF;
    IF NULLIF(v_product->>'product_id', '') IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.products p
       WHERE p.id = (v_product->>'product_id')::uuid
         AND p.is_active = true
    ) THEN
      RAISE EXCEPTION 'OCR_COMMIT_PRODUCT_MATCH_INVALID';
    END IF;
  END LOOP;

  UPDATE public.blend_tickets
     SET status = v_status,
         raw_ocr_text = p_ticket_update->>'raw_ocr_text',
         ocr_confidence_score = v_confidence,
         signature_detected = COALESCE(
           (p_ticket_update->>'signature_detected')::boolean,
           false
         ),
         customer_id = CASE
           WHEN v_ticket.customer_id IS NULL
             AND NOT ('customer_id' = ANY(COALESCE(v_ticket.manually_corrected_fields, '{}'::text[])))
             AND NULLIF(p_ticket_update->>'customer_id', '') IS NOT NULL
             THEN (p_ticket_update->>'customer_id')::uuid
           ELSE v_ticket.customer_id
         END,
         ticket_date = CASE
           WHEN v_ticket.ticket_date IS NULL
             AND NOT ('ticket_date' = ANY(COALESCE(v_ticket.manually_corrected_fields, '{}'::text[])))
             AND NULLIF(p_ticket_update->>'ticket_date', '') IS NOT NULL
             THEN (p_ticket_update->>'ticket_date')::date
           ELSE v_ticket.ticket_date
         END,
         driver_name = CASE
           WHEN NULLIF(btrim(v_ticket.driver_name), '') IS NULL
             AND NOT ('driver_name' = ANY(COALESCE(v_ticket.manually_corrected_fields, '{}'::text[])))
             THEN COALESCE(NULLIF(p_ticket_update->>'driver_name', ''), v_ticket.driver_name)
           ELSE v_ticket.driver_name
         END,
         tank_number = CASE
           WHEN NULLIF(btrim(v_ticket.tank_number), '') IS NULL
             AND NOT ('tank_number' = ANY(COALESCE(v_ticket.manually_corrected_fields, '{}'::text[])))
             THEN COALESCE(NULLIF(p_ticket_update->>'tank_number', ''), v_ticket.tank_number)
           ELSE v_ticket.tank_number
         END,
         applicator_name = CASE
           WHEN NULLIF(btrim(v_ticket.applicator_name), '') IS NULL
             AND NOT ('applicator_name' = ANY(COALESCE(v_ticket.manually_corrected_fields, '{}'::text[])))
             THEN COALESCE(NULLIF(p_ticket_update->>'applicator_name', ''), v_ticket.applicator_name)
           ELSE v_ticket.applicator_name
         END,
         job_number = CASE
           WHEN NULLIF(btrim(v_ticket.job_number), '') IS NULL
             AND NOT ('job_number' = ANY(COALESCE(v_ticket.manually_corrected_fields, '{}'::text[])))
             THEN COALESCE(NULLIF(p_ticket_update->>'job_number', ''), v_ticket.job_number)
           ELSE v_ticket.job_number
         END,
         ticket_time = CASE
           WHEN v_ticket.ticket_time IS NULL
             AND NOT ('ticket_time' = ANY(COALESCE(v_ticket.manually_corrected_fields, '{}'::text[])))
             AND NULLIF(p_ticket_update->>'ticket_time', '') IS NOT NULL
             THEN p_ticket_update->>'ticket_time'
           ELSE v_ticket.ticket_time
         END,
         vehicle_info = CASE
           WHEN NULLIF(btrim(v_ticket.vehicle_info), '') IS NULL
             AND NOT ('vehicle_info' = ANY(COALESCE(v_ticket.manually_corrected_fields, '{}'::text[])))
             THEN COALESCE(NULLIF(p_ticket_update->>'vehicle_info', ''), v_ticket.vehicle_info)
           ELSE v_ticket.vehicle_info
         END,
         mixer_name = CASE
           WHEN NULLIF(btrim(v_ticket.mixer_name), '') IS NULL
             AND NOT ('mixer_name' = ANY(COALESCE(v_ticket.manually_corrected_fields, '{}'::text[])))
             THEN COALESCE(NULLIF(p_ticket_update->>'mixer_name', ''), v_ticket.mixer_name)
           ELSE v_ticket.mixer_name
         END,
         field_names = CASE
           WHEN NULLIF(btrim(v_ticket.field_names), '') IS NULL
             AND NOT ('field_names' = ANY(COALESCE(v_ticket.manually_corrected_fields, '{}'::text[])))
             THEN COALESCE(NULLIF(p_ticket_update->>'field_names', ''), v_ticket.field_names)
           ELSE v_ticket.field_names
         END,
         total_acres = CASE
           WHEN v_ticket.total_acres IS NULL
             AND NOT ('total_acres' = ANY(COALESCE(v_ticket.manually_corrected_fields, '{}'::text[])))
             AND NULLIF(p_ticket_update->>'total_acres', '') IS NOT NULL
             THEN (p_ticket_update->>'total_acres')::numeric
           ELSE v_ticket.total_acres
         END,
         application_rate = CASE
           WHEN NULLIF(btrim(v_ticket.application_rate), '') IS NULL
             AND NOT ('application_rate' = ANY(COALESCE(v_ticket.manually_corrected_fields, '{}'::text[])))
             THEN COALESCE(NULLIF(p_ticket_update->>'application_rate', ''), v_ticket.application_rate)
           ELSE v_ticket.application_rate
         END,
         total_volume = CASE
           WHEN v_ticket.total_volume IS NULL
             AND NOT ('total_volume' = ANY(COALESCE(v_ticket.manually_corrected_fields, '{}'::text[])))
             AND NULLIF(p_ticket_update->>'total_volume', '') IS NOT NULL
             THEN (p_ticket_update->>'total_volume')::numeric
           ELSE v_ticket.total_volume
         END,
         invoice_number = CASE
           WHEN NULLIF(btrim(v_ticket.invoice_number), '') IS NULL
             AND NOT ('invoice_number' = ANY(COALESCE(v_ticket.manually_corrected_fields, '{}'::text[])))
             THEN COALESCE(NULLIF(p_ticket_update->>'invoice_number', ''), v_ticket.invoice_number)
           ELSE v_ticket.invoice_number
         END,
         notes = CASE
           WHEN NULLIF(btrim(v_ticket.notes), '') IS NULL
             AND NOT ('notes' = ANY(COALESCE(v_ticket.manually_corrected_fields, '{}'::text[])))
             THEN COALESCE(NULLIF(p_ticket_update->>'notes', ''), v_ticket.notes)
           ELSE v_ticket.notes
         END,
         updated_at = now()
   WHERE id = p_blend_ticket_id;

  DELETE FROM public.blend_ticket_products
   WHERE blend_ticket_id = p_blend_ticket_id
     AND COALESCE(manually_corrected, false) = false;

  FOR v_product IN SELECT value FROM jsonb_array_elements(p_products)
  LOOP
    INSERT INTO public.blend_ticket_products (
      blend_ticket_id, product_id, product_name, quantity, unit,
      lot_number, sequence_order, confidence_score, manually_corrected
    ) VALUES (
      p_blend_ticket_id,
      NULLIF(v_product->>'product_id', '')::uuid,
      btrim(v_product->>'product_name'),
      (v_product->>'quantity')::numeric,
      NULLIF(v_product->>'unit', ''),
      NULLIF(v_product->>'lot_number', ''),
      (v_product->>'sequence_order')::integer,
      NULLIF(v_product->>'confidence_score', '')::numeric,
      false
    );
  END LOOP;

  UPDATE public.ocr_processing_queue
     SET status = 'completed',
         completed_at = now(),
         lease_token = NULL,
         lease_heartbeat_at = NULL,
         updated_at = now()
   WHERE id = p_queue_id
     AND lease_token = p_lease_token
     AND status = 'processing';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OCR_COMMIT_LEASE_LOST';
  END IF;

  v_result := jsonb_build_object(
    'success', true,
    'ticket_id', p_blend_ticket_id,
    'queue_id', p_queue_id,
    'status', v_status,
    'product_count', jsonb_array_length(p_products)
  );
  PERFORM public.save_idempotency(
    p_idempotency_key,
    'commit_blend_ticket_ocr_result',
    v_result
  );
  RETURN v_result;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.commit_blend_ticket_ocr_result(
  uuid, uuid, uuid, jsonb, jsonb, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_blend_ticket_ocr_result(
  uuid, uuid, uuid, jsonb, jsonb, text
) TO service_role;

DO $verify_ocr_commit$
DECLARE
  v_source text;
BEGIN
  SELECT p.prosrc INTO v_source
    FROM pg_proc p
   WHERE p.oid = 'public.commit_blend_ticket_ocr_result(uuid,uuid,uuid,jsonb,jsonb,text)'::regprocedure;
  IF v_source NOT LIKE '%FOR UPDATE%'
     OR v_source NOT LIKE '%OCR_COMMIT_LEASE_LOST%'
     OR v_source NOT LIKE '%OCR_COMMIT_LIFECYCLE_CHANGED%'
     OR v_source NOT LIKE '%check_idempotency%'
     OR v_source NOT LIKE '%save_idempotency%' THEN
    RAISE EXCEPTION 'commit_blend_ticket_ocr_result atomicity markers missing';
  END IF;
  IF has_function_privilege(
       'authenticated',
       'public.commit_blend_ticket_ocr_result(uuid,uuid,uuid,jsonb,jsonb,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'authenticated must not execute OCR commit';
  END IF;
END;
$verify_ocr_commit$;

-- Re-emit the existing ticket save with a row lock and optimistic version
-- check. A save queued behind OCR must not apply a stale full-form snapshot
-- after the worker commits newer fields/products.
CREATE OR REPLACE FUNCTION public.save_blend_ticket(
  p_ticket_id uuid,
  p_ticket_payload jsonb,
  p_products jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_ticket public.blend_tickets%ROWTYPE;
  v_existing jsonb;
  v_result jsonb;
  v_actor uuid := auth.uid();
  v_effective_customer uuid;
  v_effective_job_id uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = v_actor
       AND is_active = true
       AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(
      p_idempotency_key,
      'save_blend_ticket'
    );
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_ticket
    FROM public.blend_tickets
   WHERE id = p_ticket_id
     AND deleted_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Blend ticket not found: %', p_ticket_id;
  END IF;
  IF v_ticket.status = 'processing' THEN
    RAISE EXCEPTION 'BLEND_TICKET_OCR_PROCESSING';
  END IF;
  IF NULLIF(p_ticket_payload->>'_expected_updated_at', '') IS NULL THEN
    RAISE EXCEPTION 'BLEND_TICKET_EXPECTED_VERSION_REQUIRED';
  END IF;
  IF (p_ticket_payload->>'_expected_updated_at')::timestamptz
       IS DISTINCT FROM v_ticket.updated_at THEN
    RAISE EXCEPTION 'BLEND_TICKET_STALE_EDIT';
  END IF;

  v_effective_customer := CASE
    WHEN p_ticket_payload ? 'customer_id'
      THEN NULLIF(p_ticket_payload->>'customer_id', '')::uuid
    ELSE v_ticket.customer_id
  END;
  v_effective_job_id := CASE
    WHEN p_ticket_payload ? 'job_id'
      THEN NULLIF(p_ticket_payload->>'job_id', '')::uuid
    ELSE v_ticket.job_id
  END;
  IF v_effective_job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.jobs j
     WHERE j.id = v_effective_job_id
       AND j.customer_id = v_effective_customer
  ) THEN
    RAISE EXCEPTION 'BLEND_JOB_CUSTOMER_MISMATCH';
  END IF;
  IF jsonb_typeof(p_products) IS DISTINCT FROM 'array'
     OR EXISTS (
       SELECT 1
         FROM jsonb_array_elements(p_products) AS product_row(product)
        WHERE jsonb_typeof(product) IS DISTINCT FROM 'object'
           OR NULLIF(product->>'id', '') IS NULL
  ) THEN
    RAISE EXCEPTION 'BLEND_TICKET_PRODUCT_SNAPSHOT_INVALID';
  END IF;
  IF jsonb_array_length(p_products) > 200 THEN
    RAISE EXCEPTION 'BLEND_TICKET_PRODUCT_COUNT_INVALID';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_products) AS product_row(product)
     GROUP BY (product->>'id')::uuid
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'BLEND_TICKET_PRODUCT_SNAPSHOT_DUPLICATE';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_products) AS product_row(product)
      JOIN public.blend_ticket_products existing
        ON existing.id = (product->>'id')::uuid
     WHERE existing.blend_ticket_id <> p_ticket_id
  ) THEN
    RAISE EXCEPTION 'BLEND_TICKET_PRODUCT_OWNERSHIP_MISMATCH';
  END IF;

  UPDATE public.blend_tickets SET
    customer_id = CASE WHEN p_ticket_payload ? 'customer_id'
      THEN NULLIF(p_ticket_payload->>'customer_id', '')::uuid ELSE customer_id END,
    ticket_date = CASE WHEN p_ticket_payload ? 'ticket_date'
      THEN NULLIF(p_ticket_payload->>'ticket_date', '')::date ELSE ticket_date END,
    ticket_time = CASE WHEN p_ticket_payload ? 'ticket_time'
      THEN NULLIF(p_ticket_payload->>'ticket_time', '') ELSE ticket_time END,
    job_number = CASE WHEN p_ticket_payload ? 'job_number'
      THEN NULLIF(p_ticket_payload->>'job_number', '') ELSE job_number END,
    invoice_number = CASE WHEN p_ticket_payload ? 'invoice_number'
      THEN NULLIF(p_ticket_payload->>'invoice_number', '') ELSE invoice_number END,
    driver_name = CASE WHEN p_ticket_payload ? 'driver_name'
      THEN NULLIF(p_ticket_payload->>'driver_name', '') ELSE driver_name END,
    applicator_name = CASE WHEN p_ticket_payload ? 'applicator_name'
      THEN NULLIF(p_ticket_payload->>'applicator_name', '') ELSE applicator_name END,
    mixer_name = CASE WHEN p_ticket_payload ? 'mixer_name'
      THEN NULLIF(p_ticket_payload->>'mixer_name', '') ELSE mixer_name END,
    tank_number = CASE WHEN p_ticket_payload ? 'tank_number'
      THEN NULLIF(p_ticket_payload->>'tank_number', '') ELSE tank_number END,
    vehicle_info = CASE WHEN p_ticket_payload ? 'vehicle_info'
      THEN NULLIF(p_ticket_payload->>'vehicle_info', '') ELSE vehicle_info END,
    field_names = CASE WHEN p_ticket_payload ? 'field_names'
      THEN NULLIF(p_ticket_payload->>'field_names', '') ELSE field_names END,
    total_acres = CASE WHEN p_ticket_payload ? 'total_acres'
      THEN NULLIF(p_ticket_payload->>'total_acres', '')::numeric ELSE total_acres END,
    application_rate = CASE WHEN p_ticket_payload ? 'application_rate'
      THEN NULLIF(p_ticket_payload->>'application_rate', '') ELSE application_rate END,
    total_volume = CASE WHEN p_ticket_payload ? 'total_volume'
      THEN NULLIF(p_ticket_payload->>'total_volume', '')::numeric ELSE total_volume END,
    total_volume_unit = CASE WHEN p_ticket_payload ? 'total_volume_unit'
      THEN NULLIF(p_ticket_payload->>'total_volume_unit', '') ELSE total_volume_unit END,
    notes = CASE WHEN p_ticket_payload ? 'notes'
      THEN NULLIF(p_ticket_payload->>'notes', '') ELSE notes END,
    job_id = CASE WHEN p_ticket_payload ? 'job_id'
      THEN NULLIF(p_ticket_payload->>'job_id', '')::uuid ELSE job_id END,
    application_service_id = CASE WHEN p_ticket_payload ? 'application_service_id'
      THEN NULLIF(p_ticket_payload->>'application_service_id', '')::uuid ELSE application_service_id END,
    manually_corrected_fields = ARRAY(
      SELECT DISTINCT touched.field_name
        FROM unnest(
          COALESCE(manually_corrected_fields, '{}'::text[])
          || ARRAY[
            CASE WHEN p_ticket_payload ? 'customer_id' THEN 'customer_id' END,
            CASE WHEN p_ticket_payload ? 'ticket_date' THEN 'ticket_date' END,
            CASE WHEN p_ticket_payload ? 'driver_name' THEN 'driver_name' END,
            CASE WHEN p_ticket_payload ? 'tank_number' THEN 'tank_number' END,
            CASE WHEN p_ticket_payload ? 'applicator_name' THEN 'applicator_name' END,
            CASE WHEN p_ticket_payload ? 'job_number' THEN 'job_number' END,
            CASE WHEN p_ticket_payload ? 'ticket_time' THEN 'ticket_time' END,
            CASE WHEN p_ticket_payload ? 'vehicle_info' THEN 'vehicle_info' END,
            CASE WHEN p_ticket_payload ? 'mixer_name' THEN 'mixer_name' END,
            CASE WHEN p_ticket_payload ? 'field_names' THEN 'field_names' END,
            CASE WHEN p_ticket_payload ? 'total_acres' THEN 'total_acres' END,
            CASE WHEN p_ticket_payload ? 'application_rate' THEN 'application_rate' END,
            CASE WHEN p_ticket_payload ? 'total_volume' THEN 'total_volume' END,
            CASE WHEN p_ticket_payload ? 'invoice_number' THEN 'invoice_number' END,
            CASE WHEN p_ticket_payload ? 'notes' THEN 'notes' END
          ]::text[]
        ) AS touched(field_name)
       WHERE touched.field_name IS NOT NULL
       ORDER BY touched.field_name
    ),
    updated_at = now()
  WHERE id = p_ticket_id;

  -- p_products is the complete editor snapshot. Add/remove stay local until
  -- this version-checked transaction, so a page never invalidates its own
  -- optimistic token and header + product changes commit as one unit.
  DELETE FROM public.blend_ticket_products btp
   WHERE btp.blend_ticket_id = p_ticket_id
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements(p_products) AS product_row(product)
        WHERE (product->>'id')::uuid = btp.id
     );

  UPDATE public.blend_ticket_products btp SET
    product_id = CASE WHEN prod ? 'product_id'
      THEN NULLIF(prod->>'product_id', '')::uuid ELSE btp.product_id END,
    product_name = COALESCE(NULLIF(prod->>'product_name', ''), btp.product_name),
    quantity = COALESCE(NULLIF(prod->>'quantity', '')::numeric, btp.quantity),
    unit = CASE WHEN prod ? 'unit' THEN NULLIF(prod->>'unit', '') ELSE btp.unit END,
    lot_number = CASE WHEN prod ? 'lot_number' THEN NULLIF(prod->>'lot_number', '') ELSE btp.lot_number END,
    rate_per_acre = CASE WHEN prod ? 'rate_per_acre'
      THEN NULLIF(prod->>'rate_per_acre', '')::numeric ELSE btp.rate_per_acre END,
    rate_per_acre_unit = CASE WHEN prod ? 'rate_per_acre_unit'
      THEN NULLIF(prod->>'rate_per_acre_unit', '') ELSE btp.rate_per_acre_unit END,
    sequence_order = product_row.ordinality::integer,
    manually_corrected = true
  FROM jsonb_array_elements(p_products) WITH ORDINALITY AS product_row(prod, ordinality)
  WHERE btp.id = (product_row.prod->>'id')::uuid
    AND btp.blend_ticket_id = p_ticket_id;

  INSERT INTO public.blend_ticket_products (
    id, blend_ticket_id, product_id, product_name, quantity, unit,
    lot_number, rate_per_acre, rate_per_acre_unit, sequence_order,
    confidence_score, manually_corrected
  )
  SELECT
    (product_row.prod->>'id')::uuid,
    p_ticket_id,
    NULLIF(product_row.prod->>'product_id', '')::uuid,
    COALESCE(product_row.prod->>'product_name', ''),
    COALESCE(NULLIF(product_row.prod->>'quantity', '')::numeric, 0),
    NULLIF(product_row.prod->>'unit', ''),
    NULLIF(product_row.prod->>'lot_number', ''),
    NULLIF(product_row.prod->>'rate_per_acre', '')::numeric,
    NULLIF(product_row.prod->>'rate_per_acre_unit', ''),
    product_row.ordinality::integer,
    0,
    true
  FROM jsonb_array_elements(p_products) WITH ORDINALITY AS product_row(prod, ordinality)
  WHERE NOT EXISTS (
    SELECT 1
      FROM public.blend_ticket_products existing
     WHERE existing.id = (product_row.prod->>'id')::uuid
  );

  INSERT INTO public.activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id
  ) VALUES (
    'blend_ticket_updated',
    'Blend ticket ' || COALESCE(v_ticket.ticket_number, '') || ' updated',
    v_actor, 'blend_ticket', p_ticket_id
  );

  v_result := jsonb_build_object(
    'success', true,
    'ticket_id', p_ticket_id,
    'ticket_number', v_ticket.ticket_number
  );
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(
      p_idempotency_key,
      'save_blend_ticket',
      v_result
    );
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.save_blend_ticket(uuid,jsonb,jsonb,uuid,text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_blend_ticket(uuid,jsonb,jsonb,uuid,text)
  TO authenticated, service_role;

DO $verify_save_blend_ticket$
DECLARE
  v_create_source text;
  v_commit_source text;
  v_save_source text;
BEGIN
  SELECT p.prosrc INTO v_create_source
    FROM pg_proc p
   WHERE p.oid = 'public.create_blend_ticket(uuid,jsonb,jsonb,jsonb,boolean,uuid,text)'::regprocedure;
  IF v_create_source NOT LIKE '%BLEND_TICKET_PRODUCT_COUNT_INVALID%'
     OR v_create_source NOT LIKE '%jsonb_array_length%> 200%' THEN
    RAISE EXCEPTION 'create_blend_ticket product cap missing';
  END IF;

  SELECT p.prosrc INTO v_commit_source
    FROM pg_proc p
   WHERE p.oid = 'public.commit_blend_ticket_ocr_result(uuid,uuid,uuid,jsonb,jsonb,text)'::regprocedure;
  IF v_commit_source NOT LIKE '%OCR_COMMIT_PRODUCT_MATCH_INVALID%'
     OR v_commit_source NOT LIKE '%manually_corrected_fields%' THEN
    RAISE EXCEPTION 'OCR active-product or manual-field preservation guard missing';
  END IF;

  SELECT p.prosrc INTO v_save_source
    FROM pg_proc p
   WHERE p.oid = 'public.save_blend_ticket(uuid,jsonb,jsonb,uuid,text)'::regprocedure;
  IF v_save_source NOT LIKE '%BLEND_TICKET_PRODUCT_COUNT_INVALID%'
     OR v_save_source NOT LIKE '%manually_corrected_fields%'
     OR v_save_source NOT LIKE '%p_ticket_payload ? ''tank_number''%' THEN
    RAISE EXCEPTION 'save_blend_ticket product cap or touched-field tracking missing';
  END IF;
END;
$verify_save_blend_ticket$;
