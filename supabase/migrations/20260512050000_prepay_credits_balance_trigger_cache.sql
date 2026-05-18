-- ============================================================================
-- Audit #5 — prepay_credits.balance_cents trigger-maintained cache
-- ============================================================================
-- Audit finding (Phase 0 verification, 2026-05-11 — corrected by Codex):
--   prepay_credits.balance_cents is a regular bigint manually decremented by
--   apply_prepay_to_invoice. Original audit framed as "should be GENERATED"
--   but Codex correctly noted that's impossible — it's a cross-table SUM
--   (prepay_applications). Correct shape: trigger-maintained cache + (someday)
--   reconciliation view.
--
-- Mason's decision (2026-05-12): Option A — trigger-maintained cache. Drift
-- check on session start showed 0 rows in prepay_credits (no existing drift
-- to migrate around), so this is a clean install.
--
-- Trigger pattern: AFTER INSERT OR DELETE on prepay_applications recomputes
-- the affected prepay_credits.balance_cents FROM SCRATCH (not increment/
-- decrement). Recompute-from-scratch is drift-impossible by construction —
-- the only failure mode would be the trigger not firing at all, which the
-- DO-block verification asserts.
--
-- UPDATE handling NOT needed — prepay_applications is UPDATE-immutable per
-- migration `20260512010000_immutability_triggers_ledger_tables.sql`.
-- DELETE handling is needed because void_invoice currently removes rows when
-- reversing a void (the audit log preserves evidence).
--
-- Idempotency: the apply_prepay_to_invoice RPC still hand-decrements
-- balance_cents in its body. The trigger fires AFTER that hand-decrement and
-- overwrites with the recomputed value. End result is identical; the hand-
-- decrement becomes redundant but isn't wrong. A future cleanup can drop the
-- hand-decrement from apply_prepay_to_invoice once we've watched the trigger
-- behave in prod for a few weeks.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._recompute_prepay_credit_balance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_target uuid;
BEGIN
  -- Same target whether INSERT (NEW) or DELETE (OLD)
  v_target := COALESCE(NEW.prepay_credit_id, OLD.prepay_credit_id);

  UPDATE prepay_credits
     SET balance_cents = original_amount_cents - COALESCE(
           (SELECT SUM(applied_amount_cents)
              FROM prepay_applications
             WHERE prepay_credit_id = v_target),
           0
         ),
         updated_at = now()
   WHERE id = v_target;

  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public._recompute_prepay_credit_balance IS
  'Audit #5 — recomputes prepay_credits.balance_cents = original - SUM(applied) after INSERT/DELETE on prepay_applications. UPDATE not handled because prepay_applications is UPDATE-immutable.';

DROP TRIGGER IF EXISTS trg_recompute_prepay_credit_balance ON public.prepay_applications;

CREATE TRIGGER trg_recompute_prepay_credit_balance
  AFTER INSERT OR DELETE ON public.prepay_applications
  FOR EACH ROW
  EXECUTE FUNCTION public._recompute_prepay_credit_balance();

-- ─── Baseline reconciliation ─────────────────────────────────────────────
-- Re-set every prepay_credits.balance_cents to the computed value so the
-- trigger's invariant is true from this moment on. Drift check showed 0
-- mismatches so this is a no-op on production data, but it keeps the
-- migration deterministic against any unknown state.

UPDATE prepay_credits pc
   SET balance_cents = pc.original_amount_cents - COALESCE(
         (SELECT SUM(applied_amount_cents) FROM prepay_applications WHERE prepay_credit_id = pc.id),
         0
       )
 WHERE pc.balance_cents <> pc.original_amount_cents - COALESCE(
         (SELECT SUM(applied_amount_cents) FROM prepay_applications WHERE prepay_credit_id = pc.id),
         0
       );

-- ─── Verification ────────────────────────────────────────────────────────

DO $$
DECLARE
  v_fn_exists boolean;
  v_trigger_exists boolean;
  v_drift_count integer;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_proc
                 WHERE proname='_recompute_prepay_credit_balance'
                   AND pronamespace='public'::regnamespace)
    INTO v_fn_exists;
  IF NOT v_fn_exists THEN
    RAISE EXCEPTION 'audit-5 verification: _recompute_prepay_credit_balance function not created';
  END IF;

  SELECT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON t.tgrelid = c.oid
                 WHERE c.relname='prepay_applications'
                   AND t.tgname='trg_recompute_prepay_credit_balance'
                   AND NOT t.tgisinternal)
    INTO v_trigger_exists;
  IF NOT v_trigger_exists THEN
    RAISE EXCEPTION 'audit-5 verification: trigger trg_recompute_prepay_credit_balance not active';
  END IF;

  -- Baseline must be drift-free after the UPDATE above
  SELECT count(*) INTO v_drift_count
  FROM prepay_credits pc
  WHERE pc.balance_cents <> pc.original_amount_cents - COALESCE(
    (SELECT SUM(applied_amount_cents) FROM prepay_applications WHERE prepay_credit_id = pc.id), 0
  );
  IF v_drift_count > 0 THEN
    RAISE EXCEPTION 'audit-5 verification: % prepay_credits still drifted after baseline UPDATE', v_drift_count;
  END IF;

  RAISE NOTICE 'audit-5 verification passed: prepay_credits trigger-cache installed, 0 drift.';
END;
$$;
