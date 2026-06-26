-- Field-app parity #16 FIXUPS: align job-attachments storage policies to the
-- codebase's PROVEN private-bucket pattern, and relax the uploaded_by FK so it
-- never blocks deleting a user. ADDITIVE / corrective only — re-shapes policies
-- and one FK created by 20260625200000_job_attachments.sql. Never edits that file.
--
-- WHY (independent review of #16):
--
--  HIGH — owner-NULL upload DOA. The 20260625200000 storage INSERT policy gated its
--  WITH CHECK on `owner = auth.uid()`. `storage.objects.owner` is NULLABLE, deprecated in
--  favor of owner_id, and populated by the storage-api SERVER (not our SQL) — several
--  storage-api versions insert owner = NULL. If THIS project's storage-api leaves owner
--  NULL at insert, the INSERT WITH CHECK is false and EVERY upload 403s (dead on
--  arrival), while mocked unit tests stay green. No other bucket in the codebase gates an
--  INSERT on owner — every proven bucket (team-note-attachments, document-uploads,
--  delivery-photos/-signatures, receiving-photos, blend-ticket-images) gates INSERT ONLY
--  on bucket_id + a path/visibility predicate. We COPY that proven shape: the INSERT (and
--  SELECT) policies carry NO owner/owner_id term — the path's first segment (the job id)
--  confines the upload to a job the caller can see. The DELETE policy DOES keep an
--  ownership term, but uses owner_id (not the deprecated owner): owner_id is read only on
--  DELETE, when the object already exists and the column is reliably set, so it carries
--  none of the insert-time owner-NULL DOA risk while keeping object-delete exactly as
--  strict as the catalog-row delete (see the DELETE policy comment / Codex P1 below).
--
--  LOW — uuid-cast availability gap. The same policies compared the path segment with
--  `::uuid` ((storage.foldername(name))[1]::uuid). A cast to uuid THROWS (22P02) for the
--  whole query if ANY object in the bucket has a non-UUID first segment, which would
--  surface as a hard error to non-admin callers. The proven team-note pattern compares
--  the segment as TEXT. We do the same: `j.id::text = (storage.foldername(name))[1]`.
--
--  MED — uploaded_by FK was ON DELETE RESTRICT (the default/NO ACTION). profiles.id
--  cascades from auth.users ON DELETE CASCADE, so once anyone uploads an attachment,
--  deleting that user in Supabase Auth FAILS with a FK error. Every sibling
--  uploader/audit FK uses ON DELETE SET NULL (job_batches.created_by,
--  job_tags.created_by, ground_crew_members.profile_id). The column is nullable and the
--  UI renders a null uploader as '—'. Re-add the FK with ON DELETE SET NULL.
--
-- The job-visibility predicate stays IDENTICAL to the live jobs_select policy:
--   is_admin() OR is_sales_rep() OR (is_applicator() AND <job>.applicator_id = auth.uid())

-- ─────────── 1. STORAGE.OBJECTS RLS — re-shape to the proven pattern ───────────
-- Drop the owner-bearing / uuid-casting policies and recreate them gating ONLY on
-- bucket_id + the text-compared job-visibility predicate. Exactly one policy per verb.

-- SELECT (download / list): caller can view the job encoded in the path's first segment.
DROP POLICY IF EXISTS job_attachments_objects_select ON storage.objects;
CREATE POLICY job_attachments_objects_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'job-attachments'
    AND (
      is_admin()
      OR is_sales_rep()
      OR (
        is_applicator()
        AND EXISTS (
          SELECT 1 FROM public.jobs j
          WHERE j.id::text = (storage.foldername(name))[1]
            AND j.applicator_id = (select auth.uid())
        )
      )
    )
  );

-- INSERT (upload): caller can view the job in the path. NO owner term (the DOA fix) —
-- the path segment already confines the upload to a visible job's folder.
DROP POLICY IF EXISTS job_attachments_objects_insert ON storage.objects;
CREATE POLICY job_attachments_objects_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'job-attachments'
    AND (
      is_admin()
      OR is_sales_rep()
      OR (
        is_applicator()
        AND EXISTS (
          SELECT 1 FROM public.jobs j
          WHERE j.id::text = (storage.foldername(name))[1]
            AND j.applicator_id = (select auth.uid())
        )
      )
    )
  );

-- DELETE: caller can view the job in the path AND (is admin / sales rep, OR owns the
-- object). This is kept AT LEAST AS STRICT as the catalog-row DELETE policy on
-- public.job_attachments (admin/sales_rep, OR uploaded_by = caller) so the two can
-- never diverge — otherwise an assigned applicator could delete the BYTES of a file a
-- teammate uploaded (object policy job-visibility-only) while the catalog ROW survives
-- (row policy rejects non-uploaders), orphaning a row that points at missing bytes and
-- effectively destroying another user's log file. Codex review P1.
--   Ownership here uses owner_id, NOT the deprecated owner: owner_id is the modern,
-- reliably-populated column (verified: storage-api sets it at insert). It is only read
-- here on DELETE — AFTER the object already exists and owner_id is set — so it carries
-- NONE of the insert-time owner-NULL DOA risk that this migration removes from INSERT.
DROP POLICY IF EXISTS job_attachments_objects_delete ON storage.objects;
CREATE POLICY job_attachments_objects_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'job-attachments'
    AND (
      is_admin()
      OR is_sales_rep()
      OR (
        is_applicator()
        AND EXISTS (
          SELECT 1 FROM public.jobs j
          WHERE j.id::text = (storage.foldername(name))[1]
            AND j.applicator_id = (select auth.uid())
        )
      )
    )
    -- Finer rule mirroring the catalog-row DELETE: non-admin/non-sales-rep may only
    -- remove an object they uploaded. NOTE storage.objects.owner_id is TEXT (the
    -- deprecated owner is uuid), so compare against auth.uid()::text.
    AND (
      is_admin()
      OR is_sales_rep()
      OR owner_id = (select auth.uid())::text
    )
  );

-- ─────────── 2. uploaded_by FK → ON DELETE SET NULL ───────────
-- Drop the RESTRICT (NO ACTION) FK and re-add it as SET NULL so deleting a user who
-- uploaded an attachment succeeds (the row's uploaded_by becomes NULL, rendered '—').
ALTER TABLE public.job_attachments
  DROP CONSTRAINT IF EXISTS job_attachments_uploaded_by_fkey;
ALTER TABLE public.job_attachments
  ADD CONSTRAINT job_attachments_uploaded_by_fkey
  FOREIGN KEY (uploaded_by) REFERENCES public.profiles(id) ON DELETE SET NULL;
