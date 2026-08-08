-- Restore the actor guard on batch_apply_prepayments.
--
-- Background (2026-08-08 foundation ultra review, §2):
-- 20260714220000_shared_idempotency_and_hold_hardening renamed the function to
-- _batch_apply_prepayments_impl and created a thin wrapper enforcing
-- AUTH_REQUIRED and ACTOR_MISMATCH. Ledger row
--   20260715134618 | 20260714185130_gate_batch_prepay_admin
-- then replayed an OLDER disk file AFTER that newer migration, re-creating
-- batch_apply_prepayments with its full pre-rename body and discarding the
-- actor guard. Nothing detected the revert.
--
-- Forward-only. Do NOT replay 20260714185130_gate_batch_prepay_admin.
--
-- caller-analysis: batch_apply_prepayments :: single live callsite
--   src/components/prepay/PrepayWorkspacePanel.tsx:196 passes
--   p_performed_by: profile?.id. profiles.id IS auth.uid() (it is the same
--   column is_admin() keys on), so the restored ACTOR_MISMATCH check cannot
--   fire for a legitimate admin using the UI. `authenticated` keeps EXECUTE
--   below, so the callsite is unaffected by the REVOKE — the REVOKE only
--   strips PUBLIC and anon, neither of which held a working grant in practice.
--
-- Verified live before writing this migration:
--   * _batch_apply_prepayments_impl exists with the identical signature
--     (p_allocations jsonb, p_performed_by uuid, p_idempotency_key text).
--   * Its body is the same as the current live function MINUS the is_admin()
--     block — it carries no authorization of its own and relies on its caller.
--     The wrapper below therefore KEEPS is_admin() rather than delegating it.
--     Delegating without it would have silently dropped the admin gate.
--   * Its ACL is postgres=X | service_role=X — no `authenticated` EXECUTE, so
--     it is not reachable from the browser.
--
-- Impact of the reverted guard was low and this was verified, not assumed:
-- p_performed_by is unused by the body (no attribution field for a forged
-- actor to reach) and is_admin() was never weakened. This restores
-- defense-in-depth, and matters the moment attribution logging is added here.

CREATE OR REPLACE FUNCTION public.batch_apply_prepayments(
  p_allocations jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED'
      USING ERRCODE = '42501';
  END IF;

  -- The caller may name itself, but may not name anyone else.
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH'
      USING ERRCODE = '42501';
  END IF;

  -- Retained here deliberately: _batch_apply_prepayments_impl has no
  -- authorization of its own.
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required'
      USING ERRCODE = '42501';
  END IF;

  RETURN public._batch_apply_prepayments_impl(
    p_allocations, p_performed_by, p_idempotency_key
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.batch_apply_prepayments(jsonb, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.batch_apply_prepayments(jsonb, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.batch_apply_prepayments(jsonb, uuid, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.batch_apply_prepayments(jsonb, uuid, text) IS
  'Admin-only prepay batch application. Enforces AUTH_REQUIRED, ACTOR_MISMATCH, '
  'and is_admin() before delegating to _batch_apply_prepayments_impl, which '
  'carries no authorization of its own. Guard restored 2026-08-08 after an '
  'out-of-order migration replay reverted it; see the 2026-08-08 foundation '
  'ultra review.';
