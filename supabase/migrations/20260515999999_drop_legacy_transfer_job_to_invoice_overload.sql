-- ============================================================================
-- Codex P1 fix (PR #59, 2026-05-16 review of commit 96ba99a) — drop the
-- legacy 2-arg transfer_job_to_invoice overload BEFORE the safe_cents_qty
-- rewrite tries to install the 3-arg version.
-- ============================================================================
-- Codex finding on 20260516000000_safe_cents_transfer_job_to_invoice.sql:
-- the rewrite uses CREATE OR REPLACE with a defaulted 3rd parameter, but
-- earlier migrations created `transfer_job_to_invoice(uuid, uuid)`. On a
-- fresh-DB replay, CREATE OR REPLACE matches by full signature — so both
-- overloads would coexist briefly. The migration's own verification block
-- (`expected 1 overload, found N`) then raises and aborts the migration.
--
-- Live impact: NONE. Verified via pg_proc on 2026-05-16 — only the canonical
-- 3-arg overload exists. Mason's earlier MCP-by-hand apply path happened to
-- avoid the collision (the 2-arg overload had been consolidated away in a
-- prior cleanup migration), so live applied cleanly.
--
-- Replay safety: this file's filename sorts lexically BEFORE 20260516000000_*,
-- so on any fresh-DB replay this DROP IF EXISTS runs first. On live where
-- the 2-arg overload was never present (or already gone), this is a no-op.
--
-- Intentionally minimal: no body changes, just the cleanup. The verification
-- block confirms zero overloads remain so the follow-up CREATE OR REPLACE
-- in 20260516000000 lands as the sole definition.
-- ============================================================================

DROP FUNCTION IF EXISTS public.transfer_job_to_invoice(uuid, uuid);
DROP FUNCTION IF EXISTS public.transfer_job_to_invoice(uuid);

-- ─── Verification ─────────────────────────────────────────────

DO $$
DECLARE
  v_overload_count integer;
  v_remaining_args text;
BEGIN
  SELECT count(*), string_agg(pg_get_function_identity_arguments(oid), ' | ')
    INTO v_overload_count, v_remaining_args
  FROM pg_proc
  WHERE proname = 'transfer_job_to_invoice'
    AND pronamespace = 'public'::regnamespace;

  -- After this migration runs, only the canonical 3-arg overload should
  -- remain (if it was already in place from a later migration), OR zero
  -- overloads should remain (if this is a fresh replay before 20260516000000).
  -- Either is acceptable; the assertion is "no legacy 2-arg or 1-arg".
  IF v_overload_count > 0 AND v_remaining_args NOT LIKE '%p_idempotency_key%' THEN
    RAISE EXCEPTION 'replay-safety verification: transfer_job_to_invoice has unexpected overload(s): %', v_remaining_args;
  END IF;

  RAISE NOTICE 'replay-safety: legacy transfer_job_to_invoice overloads cleared (% canonical overload(s) remain).', v_overload_count;
END
$$;
