-- Fix cycle_counts FK constraints to point to public.profiles instead of auth.users.
-- The CycleCounts page uses PostgREST embedding:
--   profiles!cycle_counts_initiated_by_fkey(full_name)
-- This requires the FK to reference profiles, not auth.users.
-- Without this fix, the CycleCounts page shows "Failed to load cycle counts" error
-- because PostgREST can't resolve profiles through an FK to auth.users.

ALTER TABLE cycle_counts DROP CONSTRAINT IF EXISTS cycle_counts_initiated_by_fkey;
ALTER TABLE cycle_counts DROP CONSTRAINT IF EXISTS cycle_counts_completed_by_fkey;

ALTER TABLE cycle_counts
  ADD CONSTRAINT cycle_counts_initiated_by_fkey
  FOREIGN KEY (initiated_by) REFERENCES profiles(id);

ALTER TABLE cycle_counts
  ADD CONSTRAINT cycle_counts_completed_by_fkey
  FOREIGN KEY (completed_by) REFERENCES profiles(id);
