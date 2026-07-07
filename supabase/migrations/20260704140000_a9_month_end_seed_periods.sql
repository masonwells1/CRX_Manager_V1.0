-- ============================================================================
-- A9 — Month-end catch-up: seed elapsed accounting_periods as 'open'
-- PARKED: owner-gated. Do NOT apply without Mason's explicit OK.
-- ----------------------------------------------------------------------------
-- WHY: only ONE accounting_period exists live (2026-01-01..01-31, open), and
--   MonthEndClose.tsx is hard-locked to the CURRENT calendar month, so the admin
--   can't see or close any prior month. Seeding the current season's elapsed months
--   as 'open' gives the month-end page a visible catch-up worklist; the coupled
--   frontend adds a month/year picker so any listed month can be viewed/closed.
--
-- SAFETY: this is a PURELY COSMETIC / visibility change with ZERO enforcement or
--   financial impact. check_period_open(date) only raises when a *closed* period
--   covers the date — it ignores 'open' and missing periods — so adding 'open'
--   rows changes nothing about posting, backdating, or month-end math. Closing a
--   month still goes through close_accounting_period() (which upserts to 'closed').
--   Idempotent: ON CONFLICT (period_start, period_end) DO NOTHING (Jan 2026 exists
--   and is skipped).
--
-- OWNER-CONFIRM (surface at apply): seeded range = the current season's elapsed
--   full months, Oct 2025 -> Jun 2026 (season = Oct 1..Sep 30; Jul 2026 is the
--   in-progress current month, already handled by the page). Adjust the range if
--   real billing started earlier/later — it only affects which rows appear in the
--   month-end list, nothing financial.
--
-- PROOF: rolled-back live smoke (row count + status). Codex verdict: <pending>.
-- ============================================================================

INSERT INTO accounting_periods (period_start, period_end, status)
VALUES
  ('2025-10-01', '2025-10-31', 'open'),
  ('2025-11-01', '2025-11-30', 'open'),
  ('2025-12-01', '2025-12-31', 'open'),
  ('2026-01-01', '2026-01-31', 'open'),  -- already exists -> skipped by ON CONFLICT
  ('2026-02-01', '2026-02-28', 'open'),  -- 2026 is not a leap year
  ('2026-03-01', '2026-03-31', 'open'),
  ('2026-04-01', '2026-04-30', 'open'),
  ('2026-05-01', '2026-05-31', 'open'),
  ('2026-06-01', '2026-06-30', 'open')
ON CONFLICT (period_start, period_end) DO NOTHING;
