-- predicate (d): auth-bound-role-ungated   *** the create_direct_order W1 variant the round-2 predicate cannot catch ***
-- authenticated-executable SECDEF MUTATORS that DO reference auth.uid() (so predicate (b) clears them) but
-- never reference any role-check helper (require_admin / is_admin / is_sales_rep) and never read a role column.
-- This is exactly the create_direct_order hole fixed 2026-06-10 (W1): it bound auth.uid() — so every forgery
-- and ungated-mutator sweep skipped it — yet had NO role gate, letting any authenticated user (incl. driver)
-- create orders + prebooks + commissions via direct RPC. This remains a standing sweep class.
-- Contract: EXPECT ZERO unallowlisted rows. A hit is an auth-bound-but-role-ungated mutator — verify against
--   the live body + its UI route's allowedRoles. If the function has no UI/Edge caller, the fix is REVOKE
--   EXECUTE FROM authenticated (server-internal helper); if it has a privileged UI route, add the canonical
--   require_admin/role gate. Only allowlist if a live disposition proves it is intentionally callable by any
--   authenticated user (rare). Do NOT allowlist a real route-vs-RPC role mismatch.
-- Note: the `!~* 'role'` filter also excludes functions that read a role column directly (e.g.
--   "SELECT role FROM profiles WHERE ..."), which is the intended behavior — that IS a role check.

SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS violation_key,
       p.proname
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.prosecdef
  AND p.prokind = 'f'
  AND p.prorettype <> 'pg_catalog.trigger'::regtype
  AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
  AND p.prosrc ~* '(insert\s+into|update\s+\S+\s+set|delete\s+from)'
  AND p.prosrc ~* 'auth\.uid'
  AND p.prosrc !~* 'require_admin'
  AND p.prosrc !~* 'is_admin'
  AND p.prosrc !~* 'is_sales_rep'
  AND p.prosrc !~* 'role'
ORDER BY violation_key;
