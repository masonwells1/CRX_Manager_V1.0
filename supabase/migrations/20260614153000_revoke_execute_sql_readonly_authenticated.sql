-- 20260614153000_revoke_execute_sql_readonly_authenticated.sql
--
-- SECURITY (HIGH): close the authenticated-role RLS-bypass on execute_sql_readonly.
--
-- public.execute_sql_readonly(text) is SECURITY DEFINER (owner = postgres) and runs an
-- ARBITRARY caller-supplied SELECT/WITH query as the table owner — i.e. it bypasses RLS on
-- every table. Its only input guard is "the query must start with SELECT or WITH", which
-- blocks writes but NOT reads. With the `authenticated` EXECUTE grant, ANY logged-in user
-- (driver / applicator / sales_rep — not just admins) could
--     POST /rest/v1/rpc/execute_sql_readonly  {"sql_query":"SELECT email, phone FROM profiles"}
-- and read every table regardless of RLS (PII + financial exfiltration). `anon` was already
-- revoked 2026-05-26 (B4, migration 20260526151856); this closes the equivalent
-- `authenticated` hole. `service_role` + `postgres` retained for server-side/CI tooling.
--
-- APPLIED LIVE 2026-06-14 via the Supabase dashboard SQL editor (this session's Supabase MCP
-- was read-only, so the apply was done by the owner; the three REVOKEs are idempotent and the
-- self-verify DO block re-asserts the end-state, so re-running this file via MCP/CLI is a safe
-- no-op that simply records it in schema_migrations). Live-verified post-apply:
-- authenticated=false, anon=false, PUBLIC=false, service_role=true.
--
-- caller-analysis: execute_sql_readonly :: ZERO production frontend/edge/cron callers
--   (.claude/caller-graph.json 0 rpc_callers; risk-annotated REVOKE candidate per
--   docs/audits/2026-06-10-error-prevention-execution-log.md §C5). The ONLY runtime caller
--   anywhere is the opt-in live-DB test src/lib/schemaIntegrityLive.test.ts:44, which calls it
--   through the ANON key (createClient(url, VITE_SUPABASE_ANON_KEY), no sign-in => the `anon`
--   role) — anon EXECUTE was already revoked in May, so that test does NOT depend on the
--   `authenticated` grant and is unaffected. (src/lib/rpcFixtureLiveDiff.test.ts:44 only LISTS
--   the name inside its LIVE_PG_PROC snapshot string; it does not call the function.) Revoking
--   `authenticated` therefore breaks no UI, edge, cron, or CI path.

REVOKE EXECUTE ON FUNCTION public.execute_sql_readonly(text) FROM authenticated;
-- defense-in-depth (idempotent): ensure PUBLIC/anon hold nothing either.
REVOKE EXECUTE ON FUNCTION public.execute_sql_readonly(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.execute_sql_readonly(text) FROM anon;

-- Self-verifying post-condition (aborts the apply if the grant state is wrong).
DO $$
BEGIN
  IF has_function_privilege('authenticated', 'public.execute_sql_readonly(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: authenticated still has EXECUTE on execute_sql_readonly';
  END IF;
  IF has_function_privilege('anon', 'public.execute_sql_readonly(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: anon still has EXECUTE on execute_sql_readonly';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.execute_sql_readonly(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: service_role LOST EXECUTE on execute_sql_readonly';
  END IF;
  RAISE NOTICE 'execute_sql_readonly: authenticated/anon/PUBLIC EXECUTE revoked; service_role retained.';
END $$;
