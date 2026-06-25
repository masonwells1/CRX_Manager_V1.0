-- ============================================================================
-- FIELD-APP PARITY #20: Tach hours (beginning / end / net engine hours)
-- CRX Manager V1.0
-- Date: 2026-06-24
--
-- ChemMan's "Add Applied Info" captures Beg. Tach, End Tach, and Net Tach — the
-- engine-hour meter ("tach") on the application equipment before and after a job.
-- Net Tach is the difference (End - Beg). These ride alongside the existing
-- per-application record (applicator / vehicle / date / acres / weather).
--
-- This migration adds three tach columns to job_applied_records (#17):
--   beginning_tach : the engine-hour meter reading at the START of the pass.
--   end_tach       : the engine-hour meter reading at the END of the pass.
--   net_tach       : engine hours used = GREATEST(end_tach - beginning_tach, 0).
--
-- net_tach is a GENERATED ALWAYS column (like jobs.remaining_acres) so it can
-- NEVER drift from beginning/end — the DB computes it on every read, the UI only
-- ever writes beginning/end. GREATEST(..,0) clamps at 0 so a partial entry (only
-- one of the two present, where the subtraction is NULL) and a clamped value are
-- both safe; the real end<beg case is rejected by the CHECK below before it can
-- ever store a clamped-to-zero value.
--
-- TACH IS OPTIONAL: engine hours are a convenience/maintenance capture, never a
-- save gate. All three columns are nullable; a job with no tach tracking saves
-- exactly as before.
--
-- VALIDATION (CHECK constraints):
--   - beginning_tach and end_tach are each non-negative when present (a meter
--     reading cannot be below zero).
--   - when BOTH are present, end_tach >= beginning_tach (a meter only counts up;
--     an end below the beginning is a data-entry error). Partial entry (one side
--     NULL) is explicitly allowed so a crew can record the beginning reading and
--     fill in the end later. The UI warns on end<beg BEFORE save so the user sees
--     a friendly message rather than a raw constraint error.
--
-- WHY COLUMNS ON job_applied_records (not a child table):
--   A tach pair is strictly 1:1 with an as-applied entry (one beginning + one end
--   reading per pass), exactly like the #19 weather pair. Columns keep the
--   read/write a single row and avoid a join.
--
-- DOES NOT AFFECT THE #18 APPLIED-ACRES ROLLUP:
--   recompute_job_applied_acres() reads ONLY job_applied_record_fields and writes
--   jobs.applied_acres -> GENERATED jobs.remaining_acres. Adding tach columns to
--   job_applied_records touches neither — the trigger is left UNTOUCHED. The
--   existing set_job_applied_records_updated_at BEFORE-UPDATE trigger keeps
--   updated_at fresh.
--
-- ALL changes are ADDITIVE: only new columns on an existing table (two plain
-- nullable + one GENERATED + two CHECKs). No column/table/policy/RPC is removed
-- or weakened. RLS is row-level and already covers every column on
-- job_applied_records (job-scoped, all 4 verbs from #17), so the new columns need
-- NO new policy. No money, no lifecycle transition, no actor-sensitive financial
-- write -> plain RLS-gated mutations, no RPC.
-- ============================================================================

ALTER TABLE job_applied_records
  ADD COLUMN IF NOT EXISTS beginning_tach numeric
    CHECK (beginning_tach IS NULL OR beginning_tach >= 0),
  ADD COLUMN IF NOT EXISTS end_tach numeric
    CHECK (end_tach IS NULL OR end_tach >= 0),
  -- net_tach is DERIVED: end - beginning, clamped at 0. GENERATED so it always
  -- reflects the two source readings and can never be written/drift independently.
  ADD COLUMN IF NOT EXISTS net_tach numeric
    GENERATED ALWAYS AS (
      CASE
        WHEN beginning_tach IS NULL OR end_tach IS NULL THEN NULL
        ELSE GREATEST(end_tach - beginning_tach, 0)
      END
    ) STORED;

-- end_tach must not be below beginning_tach when both are present (a meter only
-- counts up). Partial entry (one side NULL) is allowed. Added as a named, table
-- level CHECK (not inline) so it can reference both columns. Guarded so a re-run
-- doesn't fail on the existing constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'job_applied_records'::regclass
      AND conname = 'job_applied_records_tach_end_ge_begin_check'
  ) THEN
    ALTER TABLE job_applied_records
      ADD CONSTRAINT job_applied_records_tach_end_ge_begin_check
      CHECK (
        beginning_tach IS NULL
        OR end_tach IS NULL
        OR end_tach >= beginning_tach
      );
  END IF;
END$$;

COMMENT ON COLUMN job_applied_records.beginning_tach IS 'Field-app #20: engine-hour meter (tach) reading at the START of the pass. Nullable (optional).';
COMMENT ON COLUMN job_applied_records.end_tach IS 'Field-app #20: engine-hour meter (tach) reading at the END of the pass. Nullable; must be >= beginning_tach when both present.';
COMMENT ON COLUMN job_applied_records.net_tach IS 'Field-app #20: GENERATED engine hours used = GREATEST(end_tach - beginning_tach, 0); NULL when either reading is missing. Never written directly.';
