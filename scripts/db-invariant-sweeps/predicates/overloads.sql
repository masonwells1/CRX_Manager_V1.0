-- predicate (f): overloads
-- Any public function name with more than one signature (overload). The codebase convention is
--   EXACTLY ONE overload per RPC name — a second overload is how CREATE OR REPLACE silently forks
--   into two live bodies (the March-2026 40-bug drift class) and how a hardened body coexists with a
--   stale, still-callable one.
-- Mirrors the CLAUDE.md post-migration verification query
--   (SELECT proname, count(*) ... GROUP BY proname HAVING count(*) > 1 — should return ZERO),
--   promoted from a manual post-write check to a standing live gate. Every "overload=1" smoke-test
--   line in the history is this invariant, checked by hand; this makes it automatic.
-- Contract: EXPECT ZERO rows. A hit means a stale overload survived a CREATE OR REPLACE / DROP — drop
--   the dead signature. No allowlist case (genuinely-intended overloads do not exist in this codebase).

SELECT p.proname AS violation_key,
       count(*)  AS overload_count,
       array_agg(pg_get_function_identity_arguments(p.oid) ORDER BY pg_get_function_identity_arguments(p.oid)) AS signatures
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
GROUP BY p.proname
HAVING count(*) > 1
ORDER BY p.proname;
