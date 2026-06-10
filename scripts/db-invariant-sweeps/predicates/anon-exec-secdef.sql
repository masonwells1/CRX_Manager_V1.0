-- predicate (a): anon-exec-secdef
-- Enumerates every SECURITY DEFINER function the `anon` role can EXECUTE.
-- Would have caught: 2026-05-26 B4 (execute_sql_readonly), B5 (unapply_credit_memo),
--   B9 (6 anon-EXECUTE-able SECDEF DML helpers); 2026-05-29 the 37 report/dashboard RPCs
--   leaking PII/financials to the unauthenticated anon key (migration 20260529214355).
-- Contract: returns ALL anon-executable SECDEF functions. Expected set after allowlist = the
--   documented RLS-helper / trigger / sequence-helper / self-gating-report set ONLY. Any NEW
--   anon-executable SECDEF that is not a known-safe helper is a real grant leak — disposition each
--   one against live pg_get_functiondef before allowlisting (the in-body auth.uid()/require_admin
--   gate is the real control; a function with NO such gate must be REVOKEd, not allowlisted).
-- Output columns: violation_key (identity), is_trigger, self_gates, has_dml — to drive disposition.

SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS violation_key,
       (p.prorettype = 'pg_catalog.trigger'::regtype)                      AS is_trigger,
       (p.prosrc ~* 'auth\.uid|require_admin|is_admin|is_sales_rep|jwt')   AS self_gates,
       (p.prosrc ~* '(insert\s+into|update\s+\S+\s+set|delete\s+from)')    AS has_dml
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.prosecdef
  AND has_function_privilege('anon', p.oid, 'EXECUTE')
ORDER BY is_trigger, self_gates, violation_key;
