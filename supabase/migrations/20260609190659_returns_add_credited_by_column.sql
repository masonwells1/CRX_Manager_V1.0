-- Fix (Codex cross-review follow-on — completes B1 end-to-end).
--
-- The `returns` table is missing a `credited_by` column, but TWO live RPCs write it:
--   * issue_return_credit:  UPDATE returns SET ... credited_by = v_actor ...
--   * unapply_credit_memo:  UPDATE returns SET ... credited_by = NULL ...
-- So `UPDATE returns SET credited_by = ...` fails with "column credited_by does not exist".
--
-- This is why B1 (return -> credit) was NOT actually fixed end-to-end: the 2026-06-09
-- constraint + draft-insert-trigger fixes let issue_return_credit's invoice INSERT succeed,
-- but its SUBSEQUENT `UPDATE returns SET ... credited_by = v_actor` would still throw. The
-- earlier B1 smoke test only exercised the invoice INSERT in isolation (a DO block), not the
-- full RPC, so the missing column went unnoticed. Codex flagged the adjacent total_credit_cents
-- NULL issue in unapply_credit_memo; this is the same lifecycle gap on the issue path.
--
-- Fix: add the missing column (nullable uuid), matching the table's existing `_by` lifecycle
-- columns (requested_by / approved_by / received_by / cancelled_by). No FK, matching the
-- closest analogs approved_by / received_by (only cancelled_by carries an FK). Existing rows
-- get NULL; no data change; no RLS impact. Reversible: DROP COLUMN credited_by.

ALTER TABLE public.returns ADD COLUMN IF NOT EXISTS credited_by uuid;
