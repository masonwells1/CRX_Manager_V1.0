-- idempotency-body-check: exempt
-- ============================================================================
-- Retire dead RPC: update_allocation_set (overnight bug-hunt DEFERRED-tier, LOW)
-- ----------------------------------------------------------------------------
-- update_allocation_set(p_entity_type text, p_entity_id uuid, p_splits jsonb,
--   p_reason_note text) is DEAD. Verified 2026-06-21 against the live catalog +
--   full repo:
--     * 0 frontend callers — no .rpc('update_allocation_set'); the only source
--       references are generated types (src/types/supabase.ts) + the
--       rpcFixtureLiveDiff inventory fixture.
--     * 0 DB callers — no other public function's body references it
--       (pg_proc.prosrc scan = none).
--     * 0 dependent objects (pg_depend = none); single overload.
--     * 0 rows ever written through it.
--   It inserted client-supplied (split->>'percentage')::numeric /
--   ('amount_cents')::bigint straight into order_line_allocations /
--   invoice_line_allocations with NO sum=100 / sum=line-total validation and NO
--   idempotency key — a latent non-conserving-split + double-submit-duplicate
--   risk IF it were ever wired up. Rather than harden a dead function, RETIRE it
--   (precedent: the dead create_invoice_from_delivery dropped 20260617210000).
--
-- It WAS admin-gated (require_admin) and DID write a financial_audit_log
--   'split_modified' row, so it was never an open security hole — this is purely
--   dead-code hygiene.
--
-- The allocation TABLES are NOT touched: invoice_line_allocations is still
--   written by the live allocate_payment (the real source of truth that
--   reconciliation.ts reads); order_line_allocations is left as-is. Only the dead
--   writer function is removed.
--
-- Single statement; single overload confirmed live. Mason approved the retire
-- 2026-06-21.
-- ============================================================================

DROP FUNCTION IF EXISTS public.update_allocation_set(text, uuid, jsonb, text);

-- ============================================================================
-- SELF-VERIFICATION — raises (rolling back this migration) if the drop didn't
-- take or a stray overload survives.
-- ============================================================================
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc
  WHERE proname = 'update_allocation_set' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'update_allocation_set still exists after DROP (count = %)', v_count;
  END IF;
END $$;
