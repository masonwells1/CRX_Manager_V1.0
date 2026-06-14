-- ============================================================================
-- inventory_cost_report_column_fix
-- (DRAFT — staged under scripts/.staging-migrations/; the APPLY role stamps
--  this file with the MCP version and moves it to supabase/migrations/
--  post-review. NEVER auto-apply from this staging directory.)
-- ----------------------------------------------------------------------------
-- BUG (plpgsql_check batch 2026-06-10 — docs/audits/
-- 2026-06-10-error-prevention-execution-log.md §4 item 1, "30 errors / 11
-- functions"):
--   public.get_inventory_cost_report() filters `WHERE pr.deleted_at IS NULL`,
--   but public.products has NO deleted_at column -> SQLSTATE 42703 the first
--   time the RETURN QUERY statement executes. The in-body role gate runs
--   BEFORE that statement, so every AUTHORIZED caller (admin / sales_rep)
--   gets the 42703 and the Inventory Cost report (src/pages/Reports.tsx:306
--   -> supabase.rpc('get_inventory_cost_report')) has never returned a row
--   live; unauthorized callers correctly get 'Access denied'. plpgsql compiles
--   statements lazily, which is why this latent break shipped at all.
--
-- EVIDENCE (all read from live rhyzpcqhnizqbxphqdkr, 2026-06-10, this draft
-- session — read-only):
--   * information_schema.columns for public.products: 39 columns, NO
--     deleted_at. The soft-delete flag is `is_active boolean NOT NULL
--     DEFAULT true`.
--   * Soft-delete mechanism proof (repo): src/pages/Products.tsx:279 "deletes"
--     a product via .update({ is_active: false, updated_at: ... }) — products
--     are deactivated, never timestamp-soft-deleted. Every product picker /
--     report filters .eq('is_active', true): NewOrder.tsx:139,
--     JobDetail.tsx:191, OrderDetail.tsx:222, QuoteBuilder.tsx:306,
--     Reports.tsx:148, SalesReports.tsx:108/115, Returns.tsx:155,
--     Rebates.tsx:126, QuickDeliveryModal.tsx:82.
--   * DECISION: products ARE soft-deleted (via is_active), so the filter is
--     FIXED to the real mechanism — `pr.is_active = true` — not dropped.
--     Dropping it would leak deactivated products into the cost report that
--     no other UI surface shows. (The live body was written against the
--     timestamp soft-delete convention other tables use, e.g.
--     quotes.deleted_at — wrong table's convention.)
--
-- BASELINE (verbatim-from-live):
--   get_inventory_cost_report()  md5(prosrc) = 646f8e91a5a09fc167487a7e21e99f0a
--   prosecdef = true; proconfig = {search_path=public, pg_temp}; STABLE;
--   single overload (pronargs = 0); RETURNS TABLE(product_id uuid,
--   product_name text, sku text, category text, vendor text,
--   quantity_available numeric, quantity_prebooked numeric, net_available
--   numeric, unit_cost numeric, total_cost_value numeric, reorder_point
--   numeric, below_reorder boolean).
--
-- EXHAUSTIVE DELTA LIST (everything not listed below is byte-faithful to the
-- live body):
--   DELTA-1 (the ONLY delta): the single live line
--       WHERE pr.deleted_at IS NULL ORDER BY pr.product_name;
--     is replaced by the sentinel-delimited block
--       WHERE pr.is_active = true
--     with `ORDER BY pr.product_name;` preserved unchanged on the following
--     line. The in-body sentinel comments deliberately avoid the literal old
--     column name so the self-verification block can assert it is fully gone
--     from prosrc.
--   No signature, volatility, SECDEF, search_path, gate, column-list, JOIN,
--   COALESCE/ROUND arithmetic, or return-shape change. No idempotency helpers
--   used (read-only report fn — no p_idempotency_key in the live signature).
--
-- GRANTS (live ACL, posture UNCHANGED by this migration — CREATE OR REPLACE
-- preserves the existing ACL):
--   {=X/postgres,postgres=X/postgres,anon=X/postgres,
--    authenticated=X/postgres,service_role=X/postgres}
--   authenticated + service_role are restated and asserted below. anon/PUBLIC
--   EXECUTE is the accepted inert grant-debt class (CLAUDE.md Schema Gotchas:
--   the in-body admin/sales_rep gate is the control); any REVOKE must go
--   through the grant-change-guard with caller-analysis, NOT ride along here.
--
-- SMOKE (post-apply, rolled back):
--   scripts/smoke/smoke-inventory_cost_report_column_fix.sql
--   -> must end RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Pre-flight drift guard: refuse to apply over a body we did not transcribe.
-- Passes when live matches the recorded baseline md5, or when this fix is
-- already present (idempotent re-run).
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_count int;
  v_md5 text;
  v_src text;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc
  WHERE proname = 'get_inventory_cost_report'
    AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'pre-flight: get_inventory_cost_report overload count = %, expected exactly 1', v_count;
  END IF;

  SELECT md5(prosrc), prosrc INTO v_md5, v_src
  FROM pg_proc
  WHERE proname = 'get_inventory_cost_report'
    AND pronamespace = 'public'::regnamespace;

  IF v_md5 <> '646f8e91a5a09fc167487a7e21e99f0a'
     AND v_src NOT LIKE '%BEGIN DELTA inventory_cost_report_column_fix%' THEN
    RAISE EXCEPTION 'pre-flight: live get_inventory_cost_report md5 = % — neither the recorded baseline 646f8e91a5a09fc167487a7e21e99f0a nor already patched. Live drifted since draft: STOP and re-read the live body.', v_md5;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- Body: verbatim from live (baseline md5 above) except DELTA-1.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_inventory_cost_report()
 RETURNS TABLE(product_id uuid, product_name text, sku text, category text, vendor text, quantity_available numeric, quantity_prebooked numeric, net_available numeric, unit_cost numeric, total_cost_value numeric, reorder_point numeric, below_reorder boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'Access denied: admin or sales_rep role required';
  END IF;
  RETURN QUERY
  SELECT pr.id, pr.product_name, pr.sku, pr.category, pr.vendor,
    COALESCE(inv.quantity_available, 0), COALESCE(inv.quantity_prebooked, 0),
    COALESCE(inv.quantity_available, 0) - COALESCE(inv.quantity_prebooked, 0),
    COALESCE(pr.current_cost, 0),
    ROUND((COALESCE(inv.quantity_available, 0) * COALESCE(pr.current_cost, 0))::numeric, 2),
    COALESCE(inv.reorder_point, 0),
    COALESCE(inv.quantity_available, 0) < COALESCE(inv.reorder_point, 0)
  FROM products pr LEFT JOIN inventory inv ON inv.product_id = pr.id
  -- BEGIN DELTA inventory_cost_report_column_fix (2026-06-10): the live filter
  -- referenced a soft-delete timestamp column that does not exist on products
  -- (42703). The real products soft-delete mechanism is the is_active flag
  -- (Products.tsx deactivates; every picker filters is_active = true).
  WHERE pr.is_active = true
  -- END DELTA inventory_cost_report_column_fix
  ORDER BY pr.product_name;
END;
$function$;

-- ----------------------------------------------------------------------------
-- Grants: restate the live effective posture for the roles that matter
-- (no-ops against the live ACL; anon/PUBLIC posture intentionally untouched).
-- ----------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.get_inventory_cost_report() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_inventory_cost_report() TO service_role;

-- ----------------------------------------------------------------------------
-- Self-verification
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_count int;
  v_src text;
BEGIN
  -- Overload count
  SELECT count(*) INTO v_count
  FROM pg_proc
  WHERE proname = 'get_inventory_cost_report'
    AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'get_inventory_cost_report overload count = %, expected 1', v_count;
  END IF;

  SELECT prosrc INTO v_src
  FROM pg_proc
  WHERE proname = 'get_inventory_cost_report'
    AND pronamespace = 'public'::regnamespace;

  -- Delta sentinel markers present in prosrc
  IF v_src NOT LIKE '%BEGIN DELTA inventory_cost_report_column_fix%'
     OR v_src NOT LIKE '%END DELTA inventory_cost_report_column_fix%' THEN
    RAISE EXCEPTION 'get_inventory_cost_report: delta sentinel markers missing from prosrc';
  END IF;
  -- Corrected filter present
  IF v_src NOT LIKE '%WHERE pr.is_active = true%' THEN
    RAISE EXCEPTION 'get_inventory_cost_report: corrected is_active filter missing from prosrc';
  END IF;
  -- The broken column reference must be fully gone (the in-body comments
  -- deliberately never spell it, so this is a clean assertion)
  IF v_src LIKE '%deleted_at%' THEN
    RAISE EXCEPTION 'get_inventory_cost_report: stale reference to the non-existent soft-delete timestamp column survived in prosrc';
  END IF;
  -- Verbatim-body spot checks: role gate + ORDER BY preserved
  IF v_src NOT LIKE '%Access denied: admin or sales_rep role required%' THEN
    RAISE EXCEPTION 'get_inventory_cost_report: role gate missing — body is not verbatim-from-live';
  END IF;
  IF v_src NOT LIKE '%ORDER BY pr.product_name%' THEN
    RAISE EXCEPTION 'get_inventory_cost_report: ORDER BY clause lost — body is not verbatim-from-live';
  END IF;

  -- SECDEF + search_path + STABLE preserved
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'get_inventory_cost_report'
      AND pronamespace = 'public'::regnamespace
      AND prosecdef
      AND provolatile = 's'
      AND array_to_string(proconfig, ',') LIKE '%search_path%'
  ) THEN
    RAISE EXCEPTION 'get_inventory_cost_report must stay SECURITY DEFINER + STABLE with SET search_path';
  END IF;

  -- Grant assertions (live posture: authenticated + service_role EXECUTE)
  IF NOT has_function_privilege('authenticated', 'public.get_inventory_cost_report()', 'EXECUTE') THEN
    RAISE EXCEPTION 'get_inventory_cost_report: authenticated lost EXECUTE';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.get_inventory_cost_report()', 'EXECUTE') THEN
    RAISE EXCEPTION 'get_inventory_cost_report: service_role lost EXECUTE';
  END IF;
END $$;
