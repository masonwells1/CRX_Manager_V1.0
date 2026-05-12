-- ============================================================================
-- Codex review fix for PR #59 (P1, 2026-05-12) — Lock down
-- _insert_commissions_for_order helper from direct authenticated callers.
-- ============================================================================
-- Audit #6's canonical commission math migration (20260513020000_canonical_
-- commission_math.sql:108) granted EXECUTE on _insert_commissions_for_order
-- to the `authenticated` role. The helper is SECURITY DEFINER and contains
-- NO actor or role validation in its body — it just INSERTs into commissions.
--
-- With the grant in place, any authenticated user could call the helper
-- directly via PostgREST and insert pending commission rows for any
-- order/customer they know the IDs of. The SECURITY DEFINER context bypasses
-- the `comm_admin_insert` RLS policy on the commissions table that would
-- otherwise restrict this to admins only.
--
-- Fix: REVOKE the grant. The three wrapper RPCs that use this helper
-- (convert_quote_to_order, create_direct_order, create_quick_delivery) are
-- themselves SECURITY DEFINER owned by `postgres`, so they retain EXECUTE on
-- the helper as the function owner — the wrappers continue to work, but no
-- direct PostgREST callsite can reach the helper anymore.
--
-- This treats _insert_commissions_for_order as a private/internal helper,
-- which matches the underscore-prefix naming convention used elsewhere in
-- the codebase (e.g., _recompute_prepay_credit_balance, never granted).
-- ============================================================================

REVOKE EXECUTE ON FUNCTION public._insert_commissions_for_order(uuid, uuid, numeric, jsonb, date) FROM authenticated;

-- Defense in depth: also revoke from PUBLIC in case future grants slip in.
REVOKE EXECUTE ON FUNCTION public._insert_commissions_for_order(uuid, uuid, numeric, jsonb, date) FROM PUBLIC;

COMMENT ON FUNCTION public._insert_commissions_for_order IS
  'Internal helper for the 3 canonical commission-creating RPCs (convert_quote_to_order, create_direct_order, create_quick_delivery). NOT callable from PostgREST — direct invocation by authenticated users was revoked 2026-05-13 (codex P1 fix for PR #59) because the body has no actor/role gate.';

DO $$
DECLARE
  v_authenticated_has_grant boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.routine_privileges
    WHERE routine_schema = 'public'
      AND routine_name   = '_insert_commissions_for_order'
      AND grantee        = 'authenticated'
      AND privilege_type = 'EXECUTE'
  ) INTO v_authenticated_has_grant;

  IF v_authenticated_has_grant THEN
    RAISE EXCEPTION 'codex-fix verification: _insert_commissions_for_order still grants EXECUTE to authenticated';
  END IF;

  RAISE NOTICE 'codex-fix: _insert_commissions_for_order locked down — direct PostgREST callers blocked.';
END
$$;
