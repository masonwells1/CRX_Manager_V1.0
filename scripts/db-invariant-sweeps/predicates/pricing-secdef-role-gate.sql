-- predicate: pricing-secdef-role-gate
-- Invariant: every authenticated-executable, non-trigger SECURITY DEFINER function
-- that reads an office-only pricing table must enforce an active admin/sales-rep
-- gate in its own body. SECURITY DEFINER bypasses table RLS, so table policies
-- alone cannot protect these reads.
--
-- Historical finding: the 2026-07-27 SECDEF pricing-bypass audit found
-- compute_application_service_fee and get_program_completion missing this gate.
-- Migration 20260728182141 closed both; this predicate prevents a later
-- CREATE OR REPLACE from silently restoring either pre-fix body.
--
-- Contract: EXPECT ZERO rows. Trigger functions are excluded because PostgREST
-- cannot invoke them as RPCs. The accepted gate shapes cover the live house
-- patterns: an admin-only helper, both role helpers, require_admin_or_sales_rep(),
-- an active-profile role IN check, or a loaded active role rejected with NOT IN.

SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS violation_key,
       p.proname
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.prosecdef
  AND p.prokind = 'f'
  AND p.prorettype <> 'pg_catalog.trigger'::regtype
  AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
  AND p.prosrc ~* '(quote_items|quote_versions|customer_application_rates|rebate_programs)'
  AND NOT (
    p.prosrc ~* 'is_admin[[:space:]]*\('
    OR p.prosrc ~* 'require_admin_or_sales_rep[[:space:]]*\('
    OR (
      p.prosrc ~* 'is_active'
      AND p.prosrc ~* 'role[[:space:]]+in[[:space:]]*\([[:space:]]*''admin''[[:space:]]*,[[:space:]]*''sales_rep''[[:space:]]*\)'
    )
    OR (
      p.prosrc ~* 'is_active'
      AND p.prosrc ~* '[a-z_]*role[[:space:]]+not[[:space:]]+in[[:space:]]*\([[:space:]]*''admin''[[:space:]]*,[[:space:]]*''sales_rep''[[:space:]]*\)'
    )
  )
ORDER BY violation_key;
