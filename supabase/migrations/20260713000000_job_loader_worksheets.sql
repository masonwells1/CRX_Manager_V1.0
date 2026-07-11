-- ChemMan parity M6a: multiple saved loader worksheets per field job.
--
-- Each row stores one vehicle/tank scenario. Existing loader fields on public.jobs
-- remain untouched and continue to serve as the legacy fallback when a job has no
-- worksheet rows. This migration is additive only; it does not migrate existing data.

CREATE TABLE IF NOT EXISTS public.job_loader_worksheets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id            uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  vehicle_id        uuid REFERENCES public.vehicles(id) ON DELETE SET NULL,
  capacity_gal      numeric NOT NULL CHECK (capacity_gal > 0),
  carrier_rate_gpa  numeric CHECK (carrier_rate_gpa IS NULL OR carrier_rate_gpa >= 0),
  load_balance_mode text NOT NULL DEFAULT 'proportional'
    CHECK (load_balance_mode IN ('proportional', 'full_loads_remainder')),
  -- NULL means auto-split. A non-null value is the user-edited acres for each load.
  per_load_acres    jsonb CHECK (per_load_acres IS NULL OR jsonb_typeof(per_load_acres) = 'array'),
  -- Zero-based indexes of loads the operator has marked complete.
  loads_done        jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(loads_done) = 'array'),
  comment           text,
  is_selected       boolean NOT NULL DEFAULT false,
  created_by        uuid DEFAULT auth.uid(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- A job may save many worksheet scenarios, but only one can be selected at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_loader_worksheets_one_selected_per_job
  ON public.job_loader_worksheets (job_id)
  WHERE is_selected;

CREATE INDEX IF NOT EXISTS idx_job_loader_worksheets_job_id
  ON public.job_loader_worksheets (job_id);

CREATE INDEX IF NOT EXISTS idx_job_loader_worksheets_vehicle_id
  ON public.job_loader_worksheets (vehicle_id);

DROP TRIGGER IF EXISTS set_job_loader_worksheets_updated_at ON public.job_loader_worksheets;
CREATE TRIGGER set_job_loader_worksheets_updated_at
  BEFORE UPDATE ON public.job_loader_worksheets
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE public.job_loader_worksheets IS
  'Saved per-job loader worksheet scenarios, including load balancing, manual acres, and completion tracking.';

ALTER TABLE public.job_loader_worksheets ENABLE ROW LEVEL SECURITY;

-- SELECT: anyone who can view the parent job, including a current per-location
-- dispatchee through the same recursion-safe helper used by job-scoped RLS.
DROP POLICY IF EXISTS job_loader_worksheets_select ON public.job_loader_worksheets;
CREATE POLICY job_loader_worksheets_select ON public.job_loader_worksheets
  FOR SELECT TO authenticated
  USING (
    is_admin()
    OR is_sales_rep()
    OR (
      is_applicator()
      AND EXISTS (
        SELECT 1 FROM public.jobs j
        WHERE j.id = job_loader_worksheets.job_id
          AND j.applicator_id = (select auth.uid())
      )
    )
    OR public._is_dispatched_to_me(job_loader_worksheets.job_id)
  );

-- Writes are office-only. Applicators and other dispatched users can read the
-- selected worksheet but cannot create, edit, select, or delete scenarios.
DROP POLICY IF EXISTS job_loader_worksheets_insert ON public.job_loader_worksheets;
CREATE POLICY job_loader_worksheets_insert ON public.job_loader_worksheets
  FOR INSERT TO authenticated
  -- created_by attribution enforced like job_attachments.uploaded_by: the
  -- DEFAULT auth.uid() fills it, and WITH CHECK rejects any spoofed value.
  WITH CHECK ((is_admin() OR is_sales_rep()) AND created_by = (select auth.uid()));

DROP POLICY IF EXISTS job_loader_worksheets_update ON public.job_loader_worksheets;
CREATE POLICY job_loader_worksheets_update ON public.job_loader_worksheets
  FOR UPDATE TO authenticated
  USING (is_admin() OR is_sales_rep())
  WITH CHECK (is_admin() OR is_sales_rep());

DROP POLICY IF EXISTS job_loader_worksheets_delete ON public.job_loader_worksheets;
CREATE POLICY job_loader_worksheets_delete ON public.job_loader_worksheets
  FOR DELETE TO authenticated
  USING (is_admin() OR is_sales_rep());

-- PostgREST exposure mirrors job_attachments: authenticated receives table
-- privileges and RLS remains the authorization boundary. anon is explicitly denied.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_loader_worksheets TO authenticated;
REVOKE ALL ON public.job_loader_worksheets FROM anon;
