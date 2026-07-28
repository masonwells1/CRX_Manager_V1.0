-- predicate: pricing-secdef-role-gate
-- Invariant: every authenticated-executable, non-trigger SECURITY DEFINER function
-- that reads an office-only pricing table must enforce an active admin/sales-rep
-- gate in its own body. SECURITY DEFINER bypasses table RLS, so table policies
-- alone cannot protect these reads.
-- compute_application_service_fee is included explicitly after its authenticated
-- EXECUTE grant was removed, so restoring its pre-fix body is still detectable.
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

WITH candidates AS (
  SELECT p.oid,
         p.proname,
         regexp_replace(p.prosrc, '--[^\n]*(\n|$)', E'\n', 'g') AS body
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.prosecdef
    AND p.prokind = 'f'
    AND p.prorettype <> 'pg_catalog.trigger'::regtype
    AND (
      has_function_privilege('authenticated', p.oid, 'EXECUTE')
      OR p.proname = 'compute_application_service_fee'
    )
    AND p.prosrc ~* '(quote_items|quote_versions|customer_application_rates|rebate_programs)'
)
SELECT c.proname || '(' || pg_get_function_identity_arguments(c.oid) || ')' AS violation_key,
       c.proname
FROM candidates c
WHERE NOT (
    c.body ~* 'if[[:space:]]+not[[:space:]]*\([[:space:]]*is_admin[[:space:]]*\([[:space:]]*\)[[:space:]]+or[[:space:]]+is_sales_rep[[:space:]]*\([[:space:]]*\)[[:space:]]*\)[[:space:]]+then'
    OR c.body ~* 'if[[:space:]]+not[[:space:]]+is_admin[[:space:]]*\([[:space:]]*\)[[:space:]]+then'
    OR c.body ~* 'perform[[:space:]]+require_admin_or_sales_rep[[:space:]]*\([[:space:]]*\)'
    OR c.body ~* 'if[[:space:]]+not[[:space:]]+exists[[:space:]]*\([^;]*from[[:space:]]+profiles[^;]*where[^;]*role[[:space:]]+in[[:space:]]*\([[:space:]]*''admin''[[:space:]]*,[[:space:]]*''sales_rep''[[:space:]]*\)[^;]*is_active[[:space:]]*=[[:space:]]*true[^;]*\)[[:space:]]+then'
    OR c.body ~* 'if[[:space:]]+not[[:space:]]+exists[[:space:]]*\([^;]*from[[:space:]]+profiles[^;]*where[^;]*is_active[[:space:]]*=[[:space:]]*true[^;]*role[[:space:]]+in[[:space:]]*\([[:space:]]*''admin''[[:space:]]*,[[:space:]]*''sales_rep''[[:space:]]*\)[^;]*\)[[:space:]]+then'
    OR c.body ~* 'select[[:space:]]+role[[:space:]]+into[[:space:]]+([a-z_][a-z0-9_]*)[[:space:]]+from[[:space:]]+profiles[[:space:]]+where[^;]*is_active[[:space:]]*=[[:space:]]*true[^;]*;[[:space:]]*if[[:space:]]+\1[^;]*not[[:space:]]+in[[:space:]]*\([[:space:]]*''admin''[[:space:]]*,[[:space:]]*''sales_rep''[[:space:]]*\)[[:space:]]+then'
    OR c.body ~* 'select[[:space:]]+role[[:space:]]*,[[:space:]]*is_active[[:space:]]+into[[:space:]]+([a-z_][a-z0-9_]*)[[:space:]]*,[[:space:]]*([a-z_][a-z0-9_]*)[[:space:]]+from[[:space:]]+profiles[^;]*;[[:space:]]*if[[:space:]]+\1[^;]*not[[:space:]]+in[[:space:]]*\([[:space:]]*''admin''[[:space:]]*,[[:space:]]*''sales_rep''[[:space:]]*\)[^;]*\2[[:space:]]+is[[:space:]]+not[[:space:]]+true[^;]*then'
  )
ORDER BY violation_key;
