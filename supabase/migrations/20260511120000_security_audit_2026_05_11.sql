-- Security advisor fixes from /audit run on 2026-05-11.
-- Addresses:
--   1. function_search_path_mutable on 4 trigger functions
--   2. security_definer_view on profile_public_view (drop — zero callsites in code or DB)
--   3. rls_policy_always_true on blend_ticket_fields (INSERT/UPDATE/DELETE)
--   4. rls_policy_always_true on field_crop_history (INSERT/UPDATE/DELETE)
--   5. public_bucket_allows_listing on storage.objects global qual=true policies

BEGIN;

-- --------------------------------------------------------------------
-- 1. Pin search_path on 4 trigger functions
-- --------------------------------------------------------------------
ALTER FUNCTION public.guard_audit_log_immutable() SET search_path = public, pg_temp;
ALTER FUNCTION public._fill_audit_actor() SET search_path = public, pg_temp;
ALTER FUNCTION public._enforce_quote_status_transition() SET search_path = public, pg_temp;
ALTER FUNCTION public._enforce_return_status_transition() SET search_path = public, pg_temp;

-- --------------------------------------------------------------------
-- 2. Drop unused profile_public_view
--    Grep across src/ + supabase/ + DB pg_proc.prosrc returned zero hits.
-- --------------------------------------------------------------------
DROP VIEW IF EXISTS public.profile_public_view;

-- --------------------------------------------------------------------
-- 3. Replace always-true RLS on blend_ticket_fields
--    Mirror parent blend_tickets: uploader OR admin OR sales_rep can write;
--    admin-only delete. SELECT (currently true) left unchanged — not flagged.
-- --------------------------------------------------------------------
DROP POLICY IF EXISTS blend_ticket_fields_insert ON public.blend_ticket_fields;
DROP POLICY IF EXISTS blend_ticket_fields_update ON public.blend_ticket_fields;
DROP POLICY IF EXISTS blend_ticket_fields_delete ON public.blend_ticket_fields;

CREATE POLICY blend_ticket_fields_insert
  ON public.blend_ticket_fields
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
        FROM public.blend_tickets bt
       WHERE bt.id = blend_ticket_fields.blend_ticket_id
         AND (
              bt.uploaded_by = (SELECT auth.uid())
           OR public.is_admin()
           OR public.is_sales_rep()
         )
    )
  );

CREATE POLICY blend_ticket_fields_update
  ON public.blend_ticket_fields
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1
        FROM public.blend_tickets bt
       WHERE bt.id = blend_ticket_fields.blend_ticket_id
         AND (
              bt.uploaded_by = (SELECT auth.uid())
           OR public.is_admin()
           OR public.is_sales_rep()
         )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
        FROM public.blend_tickets bt
       WHERE bt.id = blend_ticket_fields.blend_ticket_id
         AND (
              bt.uploaded_by = (SELECT auth.uid())
           OR public.is_admin()
           OR public.is_sales_rep()
         )
    )
  );

CREATE POLICY blend_ticket_fields_delete
  ON public.blend_ticket_fields
  FOR DELETE TO authenticated
  USING (public.is_admin());

-- --------------------------------------------------------------------
-- 4. Replace always-true RLS on field_crop_history
--    Mirror parent fields: admin OR sales_rep can write; admin-only delete.
--    SELECT (currently true) left unchanged — not flagged.
-- --------------------------------------------------------------------
DROP POLICY IF EXISTS "Authenticated users can insert crop history" ON public.field_crop_history;
DROP POLICY IF EXISTS "Authenticated users can update crop history" ON public.field_crop_history;
DROP POLICY IF EXISTS "Authenticated users can delete crop history" ON public.field_crop_history;

CREATE POLICY field_crop_history_insert
  ON public.field_crop_history
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin() OR public.is_sales_rep());

CREATE POLICY field_crop_history_update
  ON public.field_crop_history
  FOR UPDATE TO authenticated
  USING (public.is_admin() OR public.is_sales_rep())
  WITH CHECK (public.is_admin() OR public.is_sales_rep());

CREATE POLICY field_crop_history_delete
  ON public.field_crop_history
  FOR DELETE TO authenticated
  USING (public.is_admin());

-- --------------------------------------------------------------------
-- 5. Drop global qual=true storage.objects policies
--    All 6 buckets (blend-ticket-images, delivery-photos, delivery-signatures,
--    document-uploads, receiving-photos, team-note-attachments) have their
--    own bucket-specific INSERT/SELECT/DELETE policies — verified by
--    pg_policies inspection on 2026-05-11.
-- --------------------------------------------------------------------
DROP POLICY IF EXISTS "Authenticated users can upload 1evsna5_0" ON storage.objects;  -- INSERT true
DROP POLICY IF EXISTS "Authenticated users can upload 1evsna5_1" ON storage.objects;  -- UPDATE true
DROP POLICY IF EXISTS "Authenticated users can upload 1evsna5_2" ON storage.objects;  -- SELECT true
DROP POLICY IF EXISTS "Authenticated users can upload 1evsna5_3" ON storage.objects;  -- DELETE true

COMMIT;
