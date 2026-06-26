-- Field-app parity #16: Map / Logs per job + Attach Log Files.
--
-- Adds a per-job attachments table + a PRIVATE storage bucket so a field job can
-- hold its application log files (equipment/GPS coverage logs, PDFs, images) with
-- the job's record. ADDITIVE ONLY — no existing object is modified.
--
-- SECURITY (the high-risk part): every access path is gated on the SAME predicate
-- as "can the caller VIEW the parent job", mirroring the live jobs_select policy
-- exactly:
--   is_admin() OR is_sales_rep()
--   OR (is_applicator() AND the job's applicator_id = the caller)
-- so a job's logs are visible to admins/sales reps and to the assigned applicator,
-- and to nobody else. anon gets NO policy → denied. The bucket is PRIVATE
-- (public=false); downloads use short-lived signed URLs.
--
-- Object path convention: '<job_id>/<uuid>_<sanitized filename>'. The storage.objects
-- policies extract the job id from the FIRST path segment — (storage.foldername(name))[1]
-- — and gate on the same job-visibility predicate, so a forged path can only ever
-- reach a job the caller is already allowed to see.

-- ─────────────────────────── 1. TABLE ───────────────────────────
CREATE TABLE IF NOT EXISTS public.job_attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  storage_path  text NOT NULL,            -- object path in the job-attachments bucket
  file_name     text NOT NULL,            -- original (display) filename
  file_size     bigint,                   -- bytes
  content_type  text,                     -- MIME type
  uploaded_by   uuid REFERENCES public.profiles(id),
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  -- INTEGRITY: the object path MUST live under this job's folder (path convention
  -- '<job_id>/...'). This binds the catalog row to the same job the storage RLS
  -- scopes on, so a caller can never catalog a row that points at ANOTHER job's
  -- object (which would let the UI sign/delete the wrong file). Codex #16 P2.
  CONSTRAINT job_attachments_storage_path_scoped
    CHECK (storage_path LIKE (job_id::text || '/%'))
);

CREATE INDEX IF NOT EXISTS idx_job_attachments_job_id
  ON public.job_attachments (job_id);

-- Convention (matches recent CRX migrations, e.g. job_parity_scheduling_agronomy_shares):
-- explicitly grant table privileges to `authenticated` so PostgREST exposes the table
-- even where auto-expose is off. RLS (below) is the real boundary — anon gets no policy
-- and is therefore denied regardless of any default grant.
GRANT SELECT, INSERT, DELETE ON public.job_attachments TO authenticated;

COMMENT ON TABLE public.job_attachments IS
  'Field-app parity #16: log files / proof documents attached to a field job. '
  'Job-scoped RLS mirrors jobs_select; bytes live in the private job-attachments bucket.';

-- ─────────────────────── 2. TABLE RLS ───────────────────────
ALTER TABLE public.job_attachments ENABLE ROW LEVEL SECURITY;

-- Reusable "can the caller view the parent job" predicate, inlined per policy.
-- Mirrors public.jobs jobs_select EXACTLY.

-- SELECT: anyone who can view the parent job.
DROP POLICY IF EXISTS job_attachments_select ON public.job_attachments;
CREATE POLICY job_attachments_select ON public.job_attachments
  FOR SELECT TO authenticated
  USING (
    is_admin()
    OR is_sales_rep()
    OR (
      is_applicator()
      AND EXISTS (
        SELECT 1 FROM public.jobs j
        WHERE j.id = job_attachments.job_id
          AND j.applicator_id = (select auth.uid())
      )
    )
  );

-- INSERT: caller must be able to view the parent job AND stamp themselves as the
-- uploader (no forged uploaded_by).
DROP POLICY IF EXISTS job_attachments_insert ON public.job_attachments;
CREATE POLICY job_attachments_insert ON public.job_attachments
  FOR INSERT TO authenticated
  WITH CHECK (
    uploaded_by = (select auth.uid())
    AND (
      is_admin()
      OR is_sales_rep()
      OR (
        is_applicator()
        AND EXISTS (
          SELECT 1 FROM public.jobs j
          WHERE j.id = job_attachments.job_id
            AND j.applicator_id = (select auth.uid())
        )
      )
    )
  );

-- DELETE: caller must be able to view the parent job AND be an admin / sales rep,
-- OR be the original uploader. (Documented choice: applicators may remove only
-- files they uploaded; admins/sales reps may remove any file on a job they can see.)
DROP POLICY IF EXISTS job_attachments_delete ON public.job_attachments;
CREATE POLICY job_attachments_delete ON public.job_attachments
  FOR DELETE TO authenticated
  USING (
    (
      is_admin()
      OR is_sales_rep()
      OR (
        is_applicator()
        AND EXISTS (
          SELECT 1 FROM public.jobs j
          WHERE j.id = job_attachments.job_id
            AND j.applicator_id = (select auth.uid())
        )
      )
    )
    AND (
      is_admin()
      OR is_sales_rep()
      OR uploaded_by = (select auth.uid())
    )
  );

-- (No UPDATE policy: attachment rows are immutable once written — replace by
-- delete + re-upload. anon has no policy at all → fully denied.)

-- ─────────────────────── 3. PRIVATE BUCKET ───────────────────────
-- Server-side enforced limits (Codex #16 P2): the UI caps files at 25 MB and narrows
-- accepted types, but an authenticated user can call the Storage API directly and
-- bypass the file input. Setting file_size_limit + allowed_mime_types on the bucket
-- makes the storage layer reject oversized / unexpected uploads regardless of client.
-- DO UPDATE (not DO NOTHING) so re-applying the migration enforces the limits even if
-- the bucket row already existed.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'job-attachments', 'job-attachments', false,
  26214400,  -- 25 MiB, matches MAX_ATTACHMENT_BYTES in src/lib/jobAttachments.ts
  ARRAY[
    'application/pdf',
    'image/png', 'image/jpeg', 'image/gif', 'image/webp',
    'text/csv', 'text/plain', 'text/xml', 'application/xml',
    'application/vnd.google-earth.kml+xml', 'application/gpx+xml',
    'application/octet-stream', 'application/zip'
  ]
)
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ─────────────── 4. STORAGE.OBJECTS RLS (bucket-scoped, job-scoped by path) ───────────────
-- Path convention: '<job_id>/<uuid>_<filename>'. (storage.foldername(name))[1] is
-- the <job_id> segment; we cast it to uuid and gate on the SAME job-visibility
-- predicate as the table policies above. RLS is already enabled on storage.objects
-- by Supabase; we only add bucket-scoped policies.

-- SELECT (download / list): caller can view the job encoded in the path.
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
          WHERE j.id = (storage.foldername(name))[1]::uuid
            AND j.applicator_id = (select auth.uid())
        )
      )
    )
  );

-- INSERT (upload): the uploader owns the object AND can view the job in the path.
DROP POLICY IF EXISTS job_attachments_objects_insert ON storage.objects;
CREATE POLICY job_attachments_objects_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'job-attachments'
    AND owner = (select auth.uid())
    AND (
      is_admin()
      OR is_sales_rep()
      OR (
        is_applicator()
        AND EXISTS (
          SELECT 1 FROM public.jobs j
          WHERE j.id = (storage.foldername(name))[1]::uuid
            AND j.applicator_id = (select auth.uid())
        )
      )
    )
  );

-- DELETE: caller can view the job in the path AND is admin/sales rep, OR owns the object.
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
          WHERE j.id = (storage.foldername(name))[1]::uuid
            AND j.applicator_id = (select auth.uid())
        )
      )
    )
    AND (
      is_admin()
      OR is_sales_rep()
      OR owner = (select auth.uid())
    )
  );

-- ─────────── 5. JOB-SCOPED FIELD GEOMETRY RPC (Codex #16 P2) ───────────
-- The per-job map must NOT pull every field of the job's customer to the browser
-- (the prior approach called get_fields_with_geojson(p_customer_id) then filtered
-- client-side, leaking other fields' boundaries/centroids to an applicator). This
-- RPC returns ONLY the fields selected on THIS job (joined via job_fields), in route
-- order, AND gates on the SAME job-visibility predicate as jobs_select — so an
-- applicator only ever receives geometry for a job they're assigned to.
-- DROP first so the migration is safely re-appliable even if an earlier-shaped draft
-- of this (new) function exists locally — Postgres won't CREATE OR REPLACE across a
-- changed OUT-param signature.
DROP FUNCTION IF EXISTS public.get_job_fields_with_geojson(uuid);
CREATE OR REPLACE FUNCTION public.get_job_fields_with_geojson(p_job_id uuid)
RETURNS TABLE(
  id uuid,
  customer_id uuid,
  field_name text,
  total_acres numeric,
  measured_acres numeric,
  override_acres numeric,
  centroid_geojson text,
  boundary_geojson text,
  sort_order integer
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT
    f.id, f.customer_id, f.field_name, f.total_acres,
    -- Two-acre model (migration 20260623120000): the map's billable-acre label uses
    -- override ?? measured ?? total. Carry both so the label isn't stale legacy acres.
    f.measured_acres, f.override_acres,
    ST_AsGeoJSON(f.centroid)::text  AS centroid_geojson,
    -- Codex post-fix P2: fields.boundary_geom is the CANONICAL full-field MultiPolygon
    -- (set by set_field_boundary; multi-part fields union all field_polygons parts into
    -- it). The legacy geography(POLYGON) `boundary` holds only the first/single part, so
    -- using it would silently drop the other parts of a multi-part field on the map.
    -- Prefer boundary_geom; fall back to the legacy boundary only when geom is absent.
    ST_AsGeoJSON(COALESCE(f.boundary_geom, f.boundary::geometry))::text AS boundary_geojson,
    jf.sort_order
  FROM public.job_fields jf
  JOIN public.fields f ON f.id = jf.field_id
  WHERE jf.job_id = p_job_id
    -- Same visibility gate as jobs_select: admin / sales_rep / the assigned applicator.
    AND EXISTS (
      SELECT 1 FROM public.jobs j
      WHERE j.id = p_job_id
        AND (
          is_admin()
          OR is_sales_rep()
          OR (is_applicator() AND j.applicator_id = (SELECT auth.uid()))
        )
    )
  ORDER BY jf.sort_order NULLS LAST, f.field_name;
$$;

REVOKE ALL ON FUNCTION public.get_job_fields_with_geojson(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_job_fields_with_geojson(uuid) TO authenticated;

COMMENT ON FUNCTION public.get_job_fields_with_geojson(uuid) IS
  'Field-app parity #16: returns ONLY the fields selected on a job (job_fields), '
  'gated by the same visibility predicate as jobs_select. Server-side scoping so the '
  'per-job map never over-fetches a customer''s other field geometry. Boundary geojson '
  'comes from the canonical full-field boundary_geom (multi-part safe), falling back to '
  'the legacy single boundary. (Codex #16 P2.)';
