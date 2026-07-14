-- predicate: commission-admin-active
-- The two required commission payment read policies, plus every other
-- permissive SELECT policy available to external callers on these tables, must
-- use the canonical is_admin() helper. Direct table writes must remain absent
-- so create/post/void RPCs are the only authenticated mutation path. The helper
-- requires profiles.is_active = true, preventing a deactivated admin from
-- retaining read access through an added bypass policy.
-- Historical catch: 2026-07-14 gauntlet finding HIGH-1.
-- Contract: EXPECT ZERO rows. Missing policies, direct role-only checks, and
-- added external permissive policies without is_admin() are violations.

WITH expected(tablename, policyname, cmd) AS (
  VALUES
    ('commission_payment_items', 'commission_payment_items_select_admin', 'SELECT'),
    ('commission_payments', 'commission_payments_select_admin', 'SELECT')
), admin_expr(pattern) AS (
  VALUES ('^\s*\(*\s*(SELECT\s+)?(public\.)?is_admin\s*\(\s*\)(\s+AS\s+is_admin)?\s*\)*\s*$')
), violations AS (
  SELECT e.tablename || ':' || e.policyname AS violation_key,
         CASE
           WHEN p.policyname IS NULL THEN 'policy missing'
           ELSE 'required policy does not use active-aware is_admin() helper'
         END AS reason
    FROM expected e
    CROSS JOIN admin_expr a
    LEFT JOIN pg_policies p
      ON p.schemaname = 'public'
     AND p.tablename = e.tablename
     AND p.policyname = e.policyname
     AND p.cmd = e.cmd
   WHERE p.policyname IS NULL
      OR p.permissive <> 'PERMISSIVE'
      OR p.roles <> ARRAY['authenticated'::name]
      OR NOT CASE p.cmd
               WHEN 'SELECT' THEN coalesce(p.qual, '') ~* a.pattern
               WHEN 'DELETE' THEN coalesce(p.qual, '') ~* a.pattern
               WHEN 'INSERT' THEN coalesce(p.with_check, '') ~* a.pattern
               WHEN 'UPDATE' THEN coalesce(p.qual, '') ~* a.pattern
                                  AND coalesce(p.with_check, '') ~* a.pattern
               WHEN 'ALL' THEN coalesce(p.qual, '') ~* a.pattern
                               AND coalesce(p.with_check, '') ~* a.pattern
               ELSE false
             END

  UNION ALL

  SELECT p.tablename || ':' || p.policyname AS violation_key,
         'direct external write policy exists; commission payment writes must stay RPC-only' AS reason
    FROM pg_policies p
   WHERE p.schemaname = 'public'
     AND p.tablename IN ('commission_payment_items', 'commission_payments')
     AND p.permissive = 'PERMISSIVE'
     AND p.roles && ARRAY['authenticated'::name, 'public'::name, 'anon'::name]
     AND p.cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')

  UNION ALL

  SELECT p.tablename || ':' || p.policyname AS violation_key,
         'external permissive read policy does not use active-aware is_admin() helper' AS reason
    FROM pg_policies p
    CROSS JOIN admin_expr a
   WHERE p.schemaname = 'public'
     AND p.tablename IN ('commission_payment_items', 'commission_payments')
     AND p.permissive = 'PERMISSIVE'
     AND p.roles && ARRAY['authenticated'::name, 'public'::name, 'anon'::name]
     AND p.cmd = 'SELECT'
     AND NOT CASE p.cmd
               WHEN 'SELECT' THEN coalesce(p.qual, '') ~* a.pattern
               ELSE false
             END
)
SELECT violation_key,
       string_agg(DISTINCT reason, '; ' ORDER BY reason) AS reason
  FROM violations
 GROUP BY violation_key
 ORDER BY violation_key;
