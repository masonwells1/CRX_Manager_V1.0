-- ============================================================================
-- Phase 4: Dispatch View (Pillar 3) — Job columns for dispatch
-- jobs table already has applicator_id and job_date
-- Adding: priority, estimated_hours
-- ============================================================================

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high', 'urgent'));

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS estimated_hours numeric(5,2);

CREATE INDEX IF NOT EXISTS idx_jobs_priority
  ON jobs(priority) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_status_date
  ON jobs(status, job_date) WHERE deleted_at IS NULL;

COMMENT ON COLUMN jobs.priority IS 'Job priority for dispatch scheduling: low, normal, high, urgent';
COMMENT ON COLUMN jobs.estimated_hours IS 'Estimated hours to complete the job';
