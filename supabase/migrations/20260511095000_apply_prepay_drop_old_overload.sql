-- ============================================================================
-- Codex review fix for PR #59 (P1, 2026-05-11) — Drop legacy 3-arg overload
-- of apply_prepay_to_invoice BEFORE the hardening migration runs.
-- ============================================================================
-- The next migration (20260511100000_apply_prepay_to_invoice_hardening.sql)
-- uses `CREATE OR REPLACE` to define a 5-arg signature of
-- apply_prepay_to_invoice (adds `p_performed_by` and `p_idempotency_key`).
--
-- But PostgreSQL identifies functions by their full input argument list —
-- adding two new defaulted parameters changes the identity signature, so
-- CREATE OR REPLACE on the 5-arg form does NOT replace the existing 3-arg
-- function. Both overloads would coexist, and:
--   1. The hardening migration's own verification block (`expected exactly
--      1 overload`) would RAISE at apply time and roll the whole thing back.
--   2. `batch_apply_prepayments` calls `apply_prepay_to_invoice(...)` with
--      only the original 3 args — PostgreSQL would still bind it to the
--      legacy un-hardened body (no actor check, no role gate, no idempotency).
--
-- This migration drops the legacy 3-arg function so the hardening migration
-- can create the canonical 5-arg version cleanly. Timestamped 20260511095000
-- to sit between the prior perf migrations and 20260511100000 in apply order.
--
-- Brief window note: between this migration and the next, no
-- apply_prepay_to_invoice function exists at all. Migrations apply
-- sequentially via Supabase MCP one at a time; there is no real concurrent-
-- caller exposure in practice.
-- ============================================================================

DROP FUNCTION IF EXISTS public.apply_prepay_to_invoice(uuid, uuid, bigint);

DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc
  WHERE proname = 'apply_prepay_to_invoice' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'codex-fix verification: expected 0 overloads of apply_prepay_to_invoice after drop, found %', v_count;
  END IF;
  RAISE NOTICE 'codex-fix: legacy 3-arg apply_prepay_to_invoice dropped — 20260511100000 hardening migration can now run cleanly.';
END
$$;
