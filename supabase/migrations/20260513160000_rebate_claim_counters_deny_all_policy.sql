-- ============================================================================
-- Codex P1 fix (PR #59, 2026-05-13) — rebate_claim_counters explicit RLS policy.
-- ============================================================================
-- The 20260513000000_rebate_claim_atomic_rpcs migration enabled RLS on the
-- new rebate_claim_counters table but did not add an explicit policy.
-- PostgreSQL's implicit-deny was protecting the table (RLS enabled + no
-- policies + non-owner role = deny), but AGENTS.md ("every new table MUST
-- have RLS policies — no exceptions") requires an explicit policy in the
-- same migration for auditable intent.
--
-- The table is only mutated by SECURITY DEFINER RPCs owned by `postgres`
-- which bypass RLS as owner. authenticated/anon roles must NEVER be able
-- to read or write the counters directly — a direct write would collide
-- with the atomic claim-ID generation logic and could duplicate IDs.
--
-- This migration adds a single explicit deny-all policy that matches the
-- live implicit-deny behavior. SECURITY DEFINER functions continue to work
-- because they run as the function owner.
-- ============================================================================

CREATE POLICY rebate_claim_counters_deny_all
  ON public.rebate_claim_counters
  FOR ALL
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);

COMMENT ON POLICY rebate_claim_counters_deny_all ON public.rebate_claim_counters IS
  'Deny all direct access — table is accessed only via SECURITY DEFINER RPCs (owner-bypass). Codex P1 fix for PR #59 (2026-05-13).';

-- ─── Verification ─────────────────────────────────────────────

DO $$
DECLARE
  v_rls_enabled boolean;
  v_policy_count integer;
BEGIN
  SELECT relrowsecurity INTO v_rls_enabled
  FROM pg_class
  WHERE relname = 'rebate_claim_counters' AND relnamespace = 'public'::regnamespace;
  IF NOT COALESCE(v_rls_enabled, false) THEN
    RAISE EXCEPTION 'codex-fix verification: rebate_claim_counters does not have RLS enabled';
  END IF;

  SELECT count(*) INTO v_policy_count
  FROM pg_policies
  WHERE tablename = 'rebate_claim_counters' AND schemaname = 'public';
  IF v_policy_count = 0 THEN
    RAISE EXCEPTION 'codex-fix verification: rebate_claim_counters has no policies (expected at least 1)';
  END IF;

  RAISE NOTICE 'codex-fix: rebate_claim_counters now has explicit deny-all RLS policy (% total).', v_policy_count;
END
$$;
