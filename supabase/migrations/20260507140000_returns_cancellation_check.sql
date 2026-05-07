-- ============================================================================
-- Wave B audit follow-up — guarantee cancelled returns always have a reason
-- (audit finding B-10)
-- ----------------------------------------------------------------------------
-- Wave B.2 added cancelled_at/cancelled_by/cancellation_reason as nullable
-- columns. The cancel_return RPC enforces the reason at write time, but
-- nothing at the DB level prevents a future bare .update({status:'cancelled'})
-- from sneaking past the RPC and leaving the cancellation triplet blank.
-- Reports/queries that JOIN on cancelled_by or display cancellation_reason
-- would then need defensive COALESCE forever.
--
-- Defensive backfill first (no-op against the live database which has zero
-- rows in status='cancelled' as of 2026-05-07; safe to run regardless),
-- then add a CHECK constraint that ties status='cancelled' to a non-null
-- cancellation_reason. cancel_return already enforces non-blank reason at
-- the RPC layer, so legitimate writes pass cleanly. Any future code path
-- that tries to flip status to 'cancelled' without going through the RPC
-- will now hit a constraint violation at the database — the audit log is
-- preserved and the books stay consistent.
--
-- Note: cancelled_at and cancelled_by are intentionally left out of the
-- constraint. cancelled_at is set automatically by the RPC, and cancelled_by
-- can legitimately be NULL for system-initiated cancellations (none today,
-- but the column allows it via the nullable FK to profiles(id)). The reason
-- is the only field with both legal and operational significance.
-- ============================================================================

-- 1) Defensive backfill (no-op today, safe in any environment).
UPDATE returns
   SET cancellation_reason = '(legacy — reason not captured before Wave B.2)'
 WHERE status = 'cancelled'
   AND cancellation_reason IS NULL;

-- 2) Add the CHECK constraint.
ALTER TABLE returns
  ADD CONSTRAINT returns_cancelled_has_reason_check
  CHECK (status <> 'cancelled' OR cancellation_reason IS NOT NULL);

COMMENT ON CONSTRAINT returns_cancelled_has_reason_check ON returns IS
  'Wave B audit B-10: every cancelled return must have a cancellation_reason. cancel_return RPC enforces this at write time; this constraint guarantees the invariant at the DB level so any future code path that bypasses the RPC will fail loudly instead of leaving books inconsistent.';
