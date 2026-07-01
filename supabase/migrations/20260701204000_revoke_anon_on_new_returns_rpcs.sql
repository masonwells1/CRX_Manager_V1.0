-- 20260701204000_revoke_anon_on_new_returns_rpcs.sql
-- reject_return + create_return (added in 20260701202000_returns_rpc_gating) were
-- created with the Postgres default PUBLIC EXECUTE grant, so anon can execute them --
-- UNLIKE their siblings (approve_return / receive_return / cancel_return /
-- issue_return_credit), which all have anon revoked. Both new RPCs self-gate on
-- auth.uid() (RAISE AUTH_REQUIRED) so anon is rejected at runtime, but this closes the
-- inconsistency + the db-invariant-sweep anon-exec-secdef finding and matches the CRX
-- "revoke anon EXECUTE on SECDEF DML" convention. Keep authenticated.

REVOKE EXECUTE ON FUNCTION public.reject_return(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.create_return(jsonb, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reject_return(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_return(jsonb, jsonb, text) TO authenticated;
