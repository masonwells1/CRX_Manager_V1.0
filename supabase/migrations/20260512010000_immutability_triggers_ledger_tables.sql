-- ============================================================================
-- Phase 2 #24 — Immutability triggers on inventory_transactions + prepay_applications
-- ============================================================================
-- Audit finding (Phase 0 verification, 2026-05-11):
--   "inventory_transactions / prepay_applications no immutability triggers.
--    Neither table has any user trigger. Only financial_audit_log has
--    trg_guard_audit_log_immutable."
--
-- Both tables are conceptually append-only ledgers:
--   - inventory_transactions: every booked/received/delivered/adjusted entry
--     stays as an immutable record of what happened.
--   - prepay_applications: every prepay → invoice application stays as
--     evidence of when money moved.
--
-- Scope:
--   - inventory_transactions: block UPDATE and DELETE (zero callers do
--     either — verified via pg_proc scan).
--   - prepay_applications: block UPDATE only. void_invoice currently DELETEs
--     rows when reversing a void; the void operation writes a comprehensive
--     financial_audit_log entry that preserves the evidence, so DELETE is
--     acceptable. UPDATE would let a caller silently tamper with applied
--     amounts after the fact — that's what we're blocking.
--
-- Bypass: privileged maintenance can still run direct SQL via
--   SELECT pg_catalog.set_config('app.bypass_ledger_immutability','true',true);
-- inside a transaction. The guard checks that GUC; admins doing rare data-
-- correction work can set it explicitly. This mirrors the pattern used by
-- `app.admin_override` elsewhere in the codebase.
-- ============================================================================

-- ─── 1. Guard for inventory_transactions (blocks UPDATE + DELETE) ────────

CREATE OR REPLACE FUNCTION public._guard_inventory_transactions_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_setting('app.bypass_ledger_immutability', true) = 'true' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'INVENTORY_TX_IMMUTABLE: inventory_transactions is append-only (op=%, id=%)',
    TG_OP, COALESCE(OLD.id::text, NEW.id::text)
    USING ERRCODE = '42501';
END;
$$;

COMMENT ON FUNCTION public._guard_inventory_transactions_immutable IS
  'Phase 2 #24 — blocks UPDATE/DELETE on inventory_transactions (append-only ledger). Bypass via SET LOCAL app.bypass_ledger_immutability = ''true''.';

DROP TRIGGER IF EXISTS trg_guard_inventory_transactions_immutable ON public.inventory_transactions;

CREATE TRIGGER trg_guard_inventory_transactions_immutable
  BEFORE UPDATE OR DELETE ON public.inventory_transactions
  FOR EACH ROW
  EXECUTE FUNCTION public._guard_inventory_transactions_immutable();

-- ─── 2. Guard for prepay_applications (blocks UPDATE only) ───────────────

CREATE OR REPLACE FUNCTION public._guard_prepay_applications_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_setting('app.bypass_ledger_immutability', true) = 'true' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PREPAY_APPLICATION_IMMUTABLE: prepay_applications rows cannot be modified after creation (id=%)',
    OLD.id
    USING ERRCODE = '42501';
END;
$$;

COMMENT ON FUNCTION public._guard_prepay_applications_immutable IS
  'Phase 2 #24 — blocks UPDATE on prepay_applications (post-creation tampering). DELETE still allowed because void_invoice removes rows when reversing; the void writes a comprehensive financial_audit_log entry that preserves the evidence.';

DROP TRIGGER IF EXISTS trg_guard_prepay_applications_immutable ON public.prepay_applications;

CREATE TRIGGER trg_guard_prepay_applications_immutable
  BEFORE UPDATE ON public.prepay_applications
  FOR EACH ROW
  EXECUTE FUNCTION public._guard_prepay_applications_immutable();

-- ─── Verification ────────────────────────────────────────────────────────

DO $$
DECLARE
  v_inv_trigger_exists boolean;
  v_prepay_trigger_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON t.tgrelid = c.oid
    WHERE c.relname = 'inventory_transactions'
      AND t.tgname = 'trg_guard_inventory_transactions_immutable'
      AND NOT t.tgisinternal
  ) INTO v_inv_trigger_exists;
  IF NOT v_inv_trigger_exists THEN
    RAISE EXCEPTION 'phase-2-24 verification: inventory_transactions immutability trigger missing';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON t.tgrelid = c.oid
    WHERE c.relname = 'prepay_applications'
      AND t.tgname = 'trg_guard_prepay_applications_immutable'
      AND NOT t.tgisinternal
  ) INTO v_prepay_trigger_exists;
  IF NOT v_prepay_trigger_exists THEN
    RAISE EXCEPTION 'phase-2-24 verification: prepay_applications immutability trigger missing';
  END IF;

  RAISE NOTICE 'phase-2-24 verification passed: ledger immutability triggers installed.';
END;
$$;
