-- ============================================================================
-- get_gross_sales_report: fix 42703 in the salesman branch (o.sales_rep_id)
-- ----------------------------------------------------------------------------
-- DRAFT (staged 2026-06-10) — staged under scripts/.staging-migrations/ per the
-- race-guard rule; the APPLY role stamps + moves this file post-review.
--
-- APPLY-ROLE CHECKLIST (reviewer CHECK 7 — do these in the same change that
-- moves this draft out of scripts/.staging-migrations/):
--   1. Rename to the final MCP-stamped filename (B7 rule) when moving under
--      supabase/migrations/.
--   2. Add the row for this migration to docs/reference/migration-history.md
--      using that final MCP-stamped filename (the doc currently has NO row
--      for this migration).
--
-- NOTE ON IN-BODY DELTA COMMENTS: the sentinel comments INSIDE the
-- $function$ body are stored in prosrc, and the self-verification block
-- asserts the removed bug column name ('sales_rep_id') appears NOWHERE in
-- prosrc. The in-body comments therefore deliberately avoid that literal;
-- the exact replaced live line is documented ONLY here in the header (see
-- BUG + EXHAUSTIVE DELTA LIST below, both outside the dollar-quote). Do not
-- "improve" the in-body comments by naming the old column — that re-breaks
-- the apply.
--
-- BUG (plpgsql_check, one of the 11 latent-break functions from the 2026-06-10
-- error-prevention batch — docs/audits/2026-06-10-error-prevention-execution-log.md):
--   error:42703:42:RETURN QUERY:column o.sales_rep_id does not exist
--   (the ELSE / "salesman" branch: LEFT JOIN public.profiles p ON p.id = o.sales_rep_id)
-- plpgsql_check run live 2026-06-10 reports this as the ONLY error in the
-- function; the 'product' and 'customer' branches are clean.
--
-- EVIDENCE (all read from the LIVE catalog 2026-06-10):
--   * public.orders has NO sales_rep_id column. It HAS salesman_id uuid NULL,
--     FK orders_salesman_id_fkey -> profiles(id)  (information_schema.columns
--     + pg_constraint, verified live).
--   * Sibling precedent — get_sales_summary_report (live body) attributes reps
--     via "LEFT JOIN profiles rep ON rep.id = o.salesman_id" and labels the
--     no-rep group "COALESCE(rep.full_name, 'Unassigned')".
--   * Consumer — src/pages/Reports.tsx (Financial > Gross Sales):
--     grossSalesGroupBy in {'product','customer','salesman'}; 'salesman' falls
--     into this function's ELSE branch, which therefore 42703-crashed on every
--     "Group By: Salesman" selection since the function was created
--     (20260216200000_reporting_rpcs.sql comments the branch as "salesman").
--     The branch has NEVER returned data, so there is no live output behavior
--     to preserve — only the obvious intent: rep attribution by profile name.
--   * Attribution IS derivable exactly as the body intends (orders.salesman_id
--     -> profiles.full_name); the NULL-attribution fallback contemplated by the
--     task brief is NOT needed.
--   * src/lib/rpcFixtureLiveDiff.test.ts only lists the function NAME — no
--     fixture change needed.
--
-- BASELINE (live, pre-fix):
--   md5(prosrc) = 0260f8e34bf7a77ac2dfdb8189c39231   (pg_proc oid 29223)
--   1 overload: get_gross_sales_report(p_start_date date, p_end_date date,
--                                      p_group_by text DEFAULT 'product')
--   LANGUAGE plpgsql, STABLE, **NOT** SECURITY DEFINER (invoker rights — RLS
--   of the caller applies; that is the function's real data gate and is
--   deliberately preserved), SET search_path TO 'public'.
--   ACL: {=X/postgres, postgres=X/postgres, anon=X/postgres,
--         authenticated=X/postgres, service_role=X/postgres}
--   (anon EXECUTE is part of the accepted/inert grant-debt set; harmless here
--   because invoker-rights + RLS — NOT changed by this migration.)
--
-- EXHAUSTIVE DELTA LIST (everything else is byte-verbatim from
-- pg_get_functiondef(29223), read live 2026-06-10):
--   GSR-FIX-DELTA-1  ELSE branch join column: o.sales_rep_id -> o.salesman_id
--                    (the 42703 fix; orders_salesman_id_fkey -> profiles.id).
--   GSR-FIX-DELTA-2  ELSE branch first output column: p.full_name ->
--                    COALESCE(p.full_name, 'Unassigned'). Orders with NULL
--                    salesman_id otherwise surface as a NULL group_name row
--                    (blank label in Reports.tsx table + CSV export). Matches
--                    the get_sales_summary_report precedent. GROUP BY
--                    p.full_name is UNCHANGED — profiles.full_name is NOT NULL,
--                    so the only NULL group is the unmatched LEFT JOIN, and the
--                    COALESCE is functionally dependent on the grouped column.
--                    (Reviewers: this delta is severable — stripping it leaves
--                    a NULL-labelled row but still fixes the 42703.)
--
-- GRANTS: restated verbatim-from-live below (CREATE OR REPLACE preserves the
-- ACL; the restatement is belt-and-suspenders) and asserted in the
-- self-verification block. No grant is added or revoked.
--
-- SMOKE (run rolled-back post-apply):
--   scripts/smoke/smoke-gross_sales_report_column_fix.sql -> SMOKE_PASS_ROLLBACK
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_gross_sales_report(p_start_date date, p_end_date date, p_group_by text DEFAULT 'product'::text)
 RETURNS TABLE(group_name text, total_revenue numeric, total_cost numeric, gross_profit numeric, margin_pct numeric, units_sold numeric, order_count bigint)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_group_by = 'product' THEN
    RETURN QUERY
      SELECT
        oi.product_name,
        ROUND(SUM(oi.total_price)::numeric, 2),
        ROUND(SUM(oi.cost_per_unit * oi.total_units_needed)::numeric, 2),
        ROUND(SUM(oi.profit)::numeric, 2),
        CASE WHEN SUM(oi.total_price) > 0
          THEN ROUND((SUM(oi.profit) / SUM(oi.total_price) * 100)::numeric, 1)
          ELSE 0 END,
        ROUND(SUM(oi.total_units_needed)::numeric, 2),
        COUNT(DISTINCT oi.order_id)
      FROM public.order_items oi
      INNER JOIN public.orders o ON o.id = oi.order_id
      WHERE o.order_date >= p_start_date
        AND o.order_date <= p_end_date
        AND o.deleted_at IS NULL
      GROUP BY oi.product_name
      ORDER BY SUM(oi.total_price) DESC;
  ELSIF p_group_by = 'customer' THEN
    RETURN QUERY
      SELECT
        c.farm_name,
        ROUND(SUM(o.total_price)::numeric, 2),
        ROUND(SUM(o.total_price - o.total_profit)::numeric, 2),
        ROUND(SUM(o.total_profit)::numeric, 2),
        CASE WHEN SUM(o.total_price) > 0
          THEN ROUND((SUM(o.total_profit) / SUM(o.total_price) * 100)::numeric, 1)
          ELSE 0 END,
        0::numeric,
        COUNT(o.id)
      FROM public.orders o
      LEFT JOIN public.customers c ON c.id = o.customer_id
      WHERE o.order_date >= p_start_date
        AND o.order_date <= p_end_date
        AND o.deleted_at IS NULL
      GROUP BY c.farm_name
      ORDER BY SUM(o.total_price) DESC;
  ELSE
    RETURN QUERY
      SELECT
        -- >>> GSR-FIX-DELTA-2 (2026-06-10) BEGIN: label the NULL-rep group
        -- 'Unassigned' (get_sales_summary_report precedent). Live line was:
        --   p.full_name,
        COALESCE(p.full_name, 'Unassigned'),
        -- <<< GSR-FIX-DELTA-2 END
        ROUND(SUM(o.total_price)::numeric, 2),
        ROUND(SUM(o.total_price - o.total_profit)::numeric, 2),
        ROUND(SUM(o.total_profit)::numeric, 2),
        CASE WHEN SUM(o.total_price) > 0
          THEN ROUND((SUM(o.total_profit) / SUM(o.total_price) * 100)::numeric, 1)
          ELSE 0 END,
        0::numeric,
        COUNT(o.id)
      FROM public.orders o
      -- >>> GSR-FIX-DELTA-1 (2026-06-10) BEGIN: 42703 fix — the live body
      -- joined profiles on a column that does not exist on public.orders;
      -- rep attribution lives on orders.salesman_id (FK
      -- orders_salesman_id_fkey -> profiles.id). The exact replaced live
      -- line is recorded in the migration file header (outside this body —
      -- deliberately NOT repeated here so the post-apply prosrc assertion
      -- on the removed column name stays clean).
      LEFT JOIN public.profiles p ON p.id = o.salesman_id
      -- <<< GSR-FIX-DELTA-1 END
      WHERE o.order_date >= p_start_date
        AND o.order_date <= p_end_date
        AND o.deleted_at IS NULL
      GROUP BY p.full_name
      ORDER BY SUM(o.total_price) DESC;
  END IF;
END;
$function$;

-- Grants: restated verbatim from the live ACL (no change — see header).
GRANT EXECUTE ON FUNCTION public.get_gross_sales_report(date, date, text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_gross_sales_report(date, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_gross_sales_report(date, date, text) TO service_role;

-- ----------------------------------------------------------------------------
-- Self-verification
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_count int;
  v_src text;
  v_errs int;
BEGIN
  -- Overload count must stay exactly 1.
  SELECT count(*) INTO v_count
  FROM pg_proc WHERE proname = 'get_gross_sales_report' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'get_gross_sales_report overload count = %, expected 1', v_count;
  END IF;

  SELECT prosrc INTO v_src
  FROM pg_proc WHERE proname = 'get_gross_sales_report' AND pronamespace = 'public'::regnamespace;

  -- Both delta sentinels must be present in the deployed body.
  IF v_src NOT LIKE '%GSR-FIX-DELTA-1%' OR v_src NOT LIKE '%GSR-FIX-DELTA-2%' THEN
    RAISE EXCEPTION 'get_gross_sales_report: delta sentinel markers missing from prosrc';
  END IF;
  -- The bug column must be gone and the correct column present.
  IF v_src LIKE '%sales_rep_id%' THEN
    RAISE EXCEPTION 'get_gross_sales_report: o.sales_rep_id still referenced (42703 not fixed)';
  END IF;
  IF v_src NOT LIKE '%p.id = o.salesman_id%' THEN
    RAISE EXCEPTION 'get_gross_sales_report: corrected join on o.salesman_id missing';
  END IF;
  IF v_src NOT LIKE '%COALESCE(p.full_name, ''Unassigned'')%' THEN
    RAISE EXCEPTION 'get_gross_sales_report: Unassigned label (DELTA-2) missing';
  END IF;

  -- Volatility/security/search_path must match the live baseline:
  -- invoker rights (NOT SECDEF — RLS is the data gate) + search_path pinned.
  IF EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'get_gross_sales_report' AND pronamespace = 'public'::regnamespace
      AND prosecdef
  ) THEN
    RAISE EXCEPTION 'get_gross_sales_report: became SECURITY DEFINER — baseline is invoker-rights; revert';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'get_gross_sales_report' AND pronamespace = 'public'::regnamespace
      AND array_to_string(proconfig, ',') LIKE '%search_path%'
  ) THEN
    RAISE EXCEPTION 'get_gross_sales_report: SET search_path lost';
  END IF;

  -- Grants must match the live baseline (anon/authenticated/service_role EXECUTE).
  IF NOT has_function_privilege('authenticated', 'public.get_gross_sales_report(date,date,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'get_gross_sales_report: authenticated lost EXECUTE';
  END IF;
  IF NOT has_function_privilege('anon', 'public.get_gross_sales_report(date,date,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'get_gross_sales_report: anon lost EXECUTE (baseline grant-debt set — do not change here)';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.get_gross_sales_report(date,date,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'get_gross_sales_report: service_role lost EXECUTE';
  END IF;

  -- plpgsql_check (installed live 20260610192229): the function must now be
  -- error-free. Guarded so the migration stays portable to envs without it.
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'plpgsql_check_function') THEN
    SELECT count(*) INTO v_errs
    FROM public.plpgsql_check_function('public.get_gross_sales_report(date,date,text)') AS cf
    WHERE cf LIKE 'error:%';
    IF v_errs > 0 THEN
      RAISE EXCEPTION 'get_gross_sales_report: plpgsql_check still reports % error line(s)', v_errs;
    END IF;
  END IF;
END $$;
