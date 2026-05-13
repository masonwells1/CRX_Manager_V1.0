-- 20260513060000 — REVOKE anon EXECUTE on 2026-05-13 sprint functions
--
-- Defense-in-depth follow-up to audit #28. Supabase grants EXECUTE on new
-- public-schema functions to BOTH `anon` and `authenticated` by default. Our
-- migrations did `REVOKE ALL ... FROM PUBLIC` which strips the PUBLIC group's
-- grant but does NOT strip the role-specific grant to `anon` — `anon` could
-- still call these RPCs without a session.
--
-- Functional defense already in place: every SECURITY DEFINER body checks
-- `auth.uid() IS NULL → RAISE 'AUTH_REQUIRED'`, so an anon caller fails at
-- the first statement. But the advisor `0028_anon_security_definer_function_executable`
-- still flags it (correctly — defense-in-depth means revoking the grant, not
-- relying on the body to refuse).
--
-- This migration cleans up the 9 functions added in the 2026-05-13 sprint.
-- Project-wide cleanup of the other ~214 pre-existing SECURITY DEFINER
-- functions in `public` is a separate sweep, tracked as a follow-up.
--
-- Special case for `_snapshot_order_item_cost()`: migration 20260513050000
-- created it without `REVOKE ALL ... FROM PUBLIC`, so PUBLIC also got EXECUTE.
-- This migration revokes from PUBLIC too — otherwise anon inherits via PUBLIC
-- even after we strip its direct grant.
--
-- For the 2 internal helpers (`_insert_commissions_for_order`,
-- `_snapshot_order_item_cost`), we revoke from authenticated as well — they're
-- only called from within other SECURITY DEFINER bodies (which inherit the
-- function-owner's permissions, so the inner call's grants don't matter).

BEGIN;

-- User-facing RPCs: revoke anon, KEEP authenticated.
REVOKE EXECUTE ON FUNCTION public.create_rebate_claim(uuid, numeric, bigint, uuid, uuid, uuid, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.transition_rebate_claim(uuid, text, bigint, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.create_delivery_with_items(uuid, uuid, date, jsonb, uuid, uuid, text, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.bulk_import_order(text, uuid, text, numeric, numeric, numeric, numeric, date, jsonb, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.save_blend_recipe(uuid, text, text, jsonb, text, text, text, text) FROM anon;

-- IMMUTABLE pure helpers: cheap to call but no reason to expose to anon.
REVOKE EXECUTE ON FUNCTION public.compute_commission_amount(numeric, numeric) FROM anon;
REVOKE EXECUTE ON FUNCTION public.safe_cents_qty(bigint, numeric) FROM anon;

-- Internal SECURITY DEFINER helpers: only called from within other SECURITY
-- DEFINER bodies. Revoke from PUBLIC + anon + authenticated. The PUBLIC
-- revoke is required for `_snapshot_order_item_cost()` because its creator
-- migration didn't include it (anon inherits via PUBLIC otherwise).
REVOKE EXECUTE ON FUNCTION public._insert_commissions_for_order(uuid, uuid, numeric, jsonb, date) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._snapshot_order_item_cost() FROM PUBLIC, anon, authenticated;

COMMIT;

-- Verification: confirm anon can no longer execute the 9 functions, AND
-- authenticated retains EXECUTE on the 7 user-facing/helper RPCs that the
-- frontend calls (the 2 internal helpers should NOT be authenticated-callable).
DO $$
DECLARE
  v_anon_can_exec int;
  v_auth_lost_user_facing int;
  v_auth_kept_internal int;
BEGIN
  SELECT count(*) INTO v_anon_can_exec
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN (
       'create_rebate_claim','transition_rebate_claim',
       'create_delivery_with_items','bulk_import_order','save_blend_recipe',
       'compute_commission_amount','safe_cents_qty',
       '_insert_commissions_for_order','_snapshot_order_item_cost'
     )
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_anon_can_exec > 0 THEN
    RAISE EXCEPTION 'verify failed: anon still has EXECUTE on % of the 9 target functions', v_anon_can_exec;
  END IF;

  SELECT count(*) INTO v_auth_lost_user_facing
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN (
       'create_rebate_claim','transition_rebate_claim',
       'create_delivery_with_items','bulk_import_order','save_blend_recipe',
       'compute_commission_amount','safe_cents_qty'
     )
     AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth_lost_user_facing > 0 THEN
    RAISE EXCEPTION 'verify failed: authenticated lost EXECUTE on % user-facing RPC(s)', v_auth_lost_user_facing;
  END IF;

  SELECT count(*) INTO v_auth_kept_internal
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('_insert_commissions_for_order','_snapshot_order_item_cost')
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth_kept_internal > 0 THEN
    RAISE EXCEPTION 'verify failed: authenticated still has EXECUTE on % internal helper(s) — revoke incomplete', v_auth_kept_internal;
  END IF;
END$$;
