-- idempotency-body-check: exempt
-- (Uses check_idempotency / save_idempotency helpers per CLAUDE.md
-- "Canonical Patterns for New RPCs".)
-- ============================================================================
-- Codex P1 fix (PR #59, 2026-05-16 review of commit e5de0f2) — lock down
-- increment_customer_prepay. It was a SECURITY DEFINER RPC callable by
-- anon AND authenticated with ZERO auth/role check, so any caller knowing
-- a customer UUID could inflate (or deflate) prepay_balance_cents via
-- direct PostgREST — a privilege-escalation path straight into AR.
--
-- Live audit (2026-05-16):
--   - has_function_privilege('anon', 'EXECUTE')           = true
--   - has_function_privilege('authenticated', 'EXECUTE')  = true
--   - body matches auth.uid()|is_admin|is_sales_rep regex = false
--   - No production frontend callers (grep src/ + tests/)
--
-- Belt+suspenders fix:
--   1. REVOKE EXECUTE from anon + authenticated (no public callers).
--   2. Add explicit auth.uid() + admin/sales_rep role gate inside the body
--      so even if some future internal caller loses owner-bypass, the
--      mutation still cannot proceed without authorization.
--
-- Applied to live via MCP before this commit. Live verification:
--   - has_auth_check                     = true (prosrc ~ 'AUTH_REQUIRED')
--   - has_function_privilege('anon', ...) = false
--   - has_function_privilege('authenticated', ...) = false
-- ============================================================================

CREATE OR REPLACE FUNCTION public.increment_customer_prepay(
  p_customer_id uuid,
  p_amount_cents bigint,
  p_idempotency_key text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing jsonb;
  v_actor    uuid;
BEGIN
  -- Codex P1 fix: gate on auth.uid() + admin/sales_rep role before mutating.
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'increment_customer_prepay');
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  UPDATE customers
  SET prepay_balance_cents = COALESCE(prepay_balance_cents, 0) + p_amount_cents
  WHERE id = p_customer_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer % not found', p_customer_id;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(
      p_idempotency_key,
      'increment_customer_prepay',
      jsonb_build_object('success', true, 'customer_id', p_customer_id, 'amount_cents', p_amount_cents)
    );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.increment_customer_prepay(uuid, bigint, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.increment_customer_prepay(uuid, bigint, text) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.increment_customer_prepay(uuid, bigint, text) FROM anon;

COMMENT ON FUNCTION public.increment_customer_prepay(uuid, bigint, text) IS
  'Internal helper for prepay flows. Not callable from PostgREST (REVOKEd from anon/authenticated). Other SECURITY DEFINER callers invoke via owner-bypass. Body still gates on auth.uid() + admin/sales_rep role for defense in depth. Codex P1 fix for PR #59 (2026-05-16).';

-- ─── Verification ─────────────────────────────────────────────

DO $$
DECLARE
  v_has_auth boolean;
  v_authn_can_exec boolean;
  v_anon_can_exec boolean;
BEGIN
  SELECT prosrc ~ 'AUTH_REQUIRED',
         has_function_privilege('authenticated', oid, 'EXECUTE'),
         has_function_privilege('anon', oid, 'EXECUTE')
    INTO v_has_auth, v_authn_can_exec, v_anon_can_exec
  FROM pg_proc
  WHERE proname = 'increment_customer_prepay' AND pronamespace = 'public'::regnamespace;

  IF NOT v_has_auth THEN
    RAISE EXCEPTION 'codex-fix verification: missing AUTH_REQUIRED guard';
  END IF;
  IF v_authn_can_exec THEN
    RAISE EXCEPTION 'codex-fix verification: authenticated still has EXECUTE';
  END IF;
  IF v_anon_can_exec THEN
    RAISE EXCEPTION 'codex-fix verification: anon still has EXECUTE';
  END IF;

  RAISE NOTICE 'codex-fix: increment_customer_prepay locked down (auth guard + REVOKE EXECUTE from anon+authenticated).';
END
$$;
