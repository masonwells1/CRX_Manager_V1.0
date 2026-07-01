-- 20260701212000_revoke_anon_on_new_secdef_fns.sql
-- Codex bug-hunt F4 (2026-07-01), defense-in-depth. The security advisor's
-- anon_security_definer_function_executable set grew 53 -> 59; most new SECDEF fns from
-- the recent work already had anon revoked, but THREE slipped through and are still
-- anon-executable (verified live 2026-07-01 via has_function_privilege('anon', oid,
-- 'EXECUTE')):
--   * next_return_number()                     -- sequence helper (real, if minor, surface:
--                                                 anon could burn return numbers)
--   * trg_jarf_recompute()                     -- TRIGGER fn (inert on a direct call)
--   * trg_job_applied_record_recompute()       -- TRIGGER fn (inert on a direct call)
-- These self-gate / are inert, so this is grant-debt hygiene (the project rule "revoke
-- anon on a new SECDEF fn"), not an open hole. anon inherits PUBLIC's default EXECUTE
-- grant, so REVOKE must target PUBLIC (not just anon) to actually remove it. Trigger
-- functions fire regardless of EXECUTE grants, so no re-GRANT is needed for them;
-- next_return_number keeps authenticated/service_role EXECUTE (its SECDEF callers run
-- as owner anyway). Idempotent; no schema change.
--
-- caller-analysis: next_return_number :: Returns.tsx:226 now calls create_return (returns_rpc_gating PARKED-004, which "replaces the prior next_return_number + two direct inserts"); next_return_number is only invoked INSIDE create_return, a SECDEF fn that runs as its owner and is unaffected by grants. The flagged Returns.tsx:222 is the stale (2026-06-13) caller-graph pointing at the now-removed direct callsite. authenticated/service_role EXECUTE is retained regardless, so any invoker-context caller keeps working; only anon loses access.
-- caller-analysis: trg_jarf_recompute :: trigger function — fires as a trigger regardless of EXECUTE grants; no direct/RPC callers. Revoke is pure hygiene.
-- caller-analysis: trg_job_applied_record_recompute :: trigger function — fires as a trigger regardless of EXECUTE grants; no direct/RPC callers. Revoke is pure hygiene.

REVOKE EXECUTE ON FUNCTION public.next_return_number() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.next_return_number() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.trg_jarf_recompute() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.trg_job_applied_record_recompute() FROM PUBLIC, anon;

-- Verification: anon must no longer hold EXECUTE on any of the three.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('next_return_number','trg_jarf_recompute','trg_job_applied_record_recompute')
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
  LOOP
    RAISE EXCEPTION 'anon still has EXECUTE on %', r.proname;
  END LOOP;
END $$;
