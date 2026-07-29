-- Remove logged-out (anon) EXECUTE on 40 public functions that no logged-out
-- visitor has any legitimate reason to call.
--
-- This is PART 1 OF 2. It deliberately covers only functions that are NOT
-- referenced by any row-level-security policy, so it cannot change what any
-- table query returns. The three permission helpers that ARE used inside
-- policies (is_admin, is_applicator, is_driver) are handled separately in
-- 20260728193100 because they carry a different, larger risk.
--
-- WHY BOTH "PUBLIC" AND "anon" MUST BE NAMED
-- This database has ALTER DEFAULT PRIVILEGES granting anon EXECUTE on every new
-- public function, so every function below carries an explicit anon=X grant AND
-- inherits the PUBLIC grant. Revoking only one leaves the other in place and the
-- function stays reachable. Confirmed against live: is_sales_rep(), the one
-- helper already locked down, has acl {postgres=X,authenticated=X,service_role=X}
-- -- neither a PUBLIC entry nor an anon entry. Both had to go.
--
-- DELIBERATELY NOT INCLUDED: handle_new_user()
-- It is the trigger on auth.users that creates a staff profile for a new
-- account. Live check: supabase_auth_admin -- the role Supabase Auth runs as --
-- has no grant of its own on it, is not a superuser, and is a member of no role.
-- Its only route is the PUBLIC grant this file would strip. Revoking it risks
-- breaking account creation for a security gain of approximately zero (a trigger
-- function returning `trigger` cannot be invoked through the API anyway).
--
-- VERIFICATION uses has_function_privilege(), never a proacl scan. A proacl scan
-- reports the explicit grants only and will report success while the PUBLIC
-- grant is still letting anon through.
--
-- CALLER ANALYSIS
-- Caller graph regenerated 2026-07-28 (node scripts/generate-caller-graph.mjs)
-- before writing this file; the previous graph was 17 days stale and named two
-- next_po_number callsites that no longer exist. Every live caller of every
-- function below is a browser `.rpc()` call from a signed-in page, which runs as
-- `authenticated`. This migration revokes from PUBLIC and anon only; the
-- `authenticated` grant is untouched, and the proof block at the bottom asserts
-- that positively for all 40. Zero cron callers, zero edge-function callers.
--
-- caller-analysis: next_cycle_count_number :: src/pages/CycleCounts.tsx:155 -- signed-in cycle-count page, runs as authenticated; authenticated grant retained and asserted below
-- caller-analysis: next_job_number :: src/pages/JobDetail.tsx:1690 -- signed-in job detail page, runs as authenticated; authenticated grant retained and asserted below
-- caller-analysis: next_po_number :: no live callsite. The only remaining reference is src/components/purchase-orders/BulkPOImport.test.tsx:182, a test asserting the RPC is NOT called (numbering moved server-side). Nothing to break.
-- caller-analysis: admin_update_profile :: src/pages/SettingsPage.tsx:553 -- admin-only settings page, runs as authenticated; function also gates internally on require_admin(); authenticated grant retained and asserted below
-- caller-analysis: financial_dashboard_summary :: src/components/dashboard/DailyBrief.tsx:48, src/components/dashboard/FinanceSnapshotCard.tsx:38, src/pages/FinancialDashboard.tsx:185 -- all inside ProtectedRoute, run as authenticated; authenticated grant retained and asserted below
-- caller-analysis: get_commission_balance_report :: src/pages/Reports.tsx:283 -- signed-in reports page, runs as authenticated; authenticated grant retained and asserted below
-- caller-analysis: get_inventory_cost_report :: src/pages/Reports.tsx:311 -- signed-in reports page, runs as authenticated; authenticated grant retained and asserted below
-- caller-analysis: get_receiving_log :: src/components/receiving/ReceivingLogPanel.tsx:102 -- signed-in receiving panel, runs as authenticated; authenticated grant retained and asserted below
-- caller-analysis: get_receiving_summary :: src/components/receiving/ReceivingLogPanel.tsx:82 -- signed-in receiving panel, runs as authenticated; authenticated grant retained and asserted below
-- caller-analysis: get_sales_detail_report :: src/pages/SalesReports.tsx:168 -- signed-in sales reports page, runs as authenticated; authenticated grant retained and asserted below
-- caller-analysis: get_sales_summary_report :: src/pages/SalesReports.tsx:176 -- signed-in sales reports page, runs as authenticated; authenticated grant retained and asserted below
-- caller-analysis: operational_dashboard_summary :: src/pages/Dashboard.tsx:264, src/pages/OfficeCockpit.tsx:598 -- both inside ProtectedRoute, run as authenticated; authenticated grant retained and asserted below

-- ---------------------------------------------------------------------------
-- GROUP 1 -- trigger-only functions (20)
-- Each returns `trigger` and takes no arguments. PostgREST will not expose a
-- function with that shape, so no HTTP caller -- signed in or not -- can invoke
-- one. They run only when their table's trigger fires. Zero behaviour change.
-- Note: _prebook_quick_delivery_inventory() and trg_po_submitted_update_on_order()
-- currently have NO trigger attached to any table (pg_trigger has no row for
-- them). They are dormant. Revoking is safe and, if anything, overdue.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public._guard_inventory_transactions_immutable()   FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public._guard_prepay_applications_immutable()      FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public._prebook_quick_delivery_inventory()         FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public._receiving_records_before_delete()          FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public._recompute_prepay_credit_balance()          FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.enforce_blend_ticket_products_billed_lock() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.enforce_quote_accepted_fully_drawn()        FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.log_comment_activity()                      FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.log_note_activity()                         FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.notify_mentioned_users_in_comment()         FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prevent_order_shares_edit_after_post()      FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.snapshot_field_crop_history()               FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.sync_blend_ticket_payment_status()          FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.trg_delivery_status_change()                FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.trg_inventory_significant_change()          FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.trg_order_status_change()                   FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.trg_po_status_change()                      FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.trg_po_submitted_update_on_order()          FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.trg_recalc_order_totals()                   FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.vendor_bills_positive_subtotal_trigger()    FROM PUBLIC, anon;

-- ---------------------------------------------------------------------------
-- GROUP 2 -- SECURITY DEFINER, directly callable, NO internal authorization
-- check (8). THIS IS THE ACTUAL LIVE EXPOSURE THIS MIGRATION CLOSES.
-- Each runs with the definer's rights and does not check who is calling, and
-- has_function_privilege('anon', ..., 'EXECUTE') is true for all eight today.
-- A logged-out caller can invoke them over the public API right now.
-- The six next_*_number() counters allocate document numbers, so an
-- unauthenticated caller can burn job / PO / delivery / cycle-count /
-- commission-payment / application-record numbers at will.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.calculate_billing_splits(bigint, numeric[]) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.check_period_open(date)                     FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.next_application_record_number()            FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.next_commission_payment_number()            FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.next_cycle_count_number()                   FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.next_delivery_number()                      FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.next_job_number()                           FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.next_po_number()                            FROM PUBLIC, anon;

-- ---------------------------------------------------------------------------
-- GROUP 3 -- SECURITY DEFINER, directly callable, WITH an internal
-- authorization check (12). These already refuse a logged-out caller on their
-- own, so this is defence in depth: an unauthenticated request should not reach
-- the function body at all. Each is called by the signed-in app only; the
-- authenticated grant is untouched.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public._require_auth()                             FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_update_profile(uuid, text, text, text, boolean, text[], text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.financial_dashboard_summary()               FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_commission_balance_report(date)         FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_inventory_cost_report()                 FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_receiving_log(integer, integer, text, text, uuid, date, date) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_receiving_summary()                     FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_sales_detail_report(date, date, uuid, uuid[], uuid, text, integer) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_sales_summary_report(text, date, date, uuid, uuid[], uuid, text, integer) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.operational_dashboard_summary()             FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.require_admin()                             FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.require_admin_or_sales_rep()                FROM PUBLIC, anon;

-- ---------------------------------------------------------------------------
-- PROOF
-- Assertion 1: anon can no longer execute any of the 40.
-- Assertion 2: authenticated can STILL execute all 40. This is the regression
-- guard that matters -- it proves the revoke did not reach the signed-in app.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_targets text[] := ARRAY[
    'public._guard_inventory_transactions_immutable()',
    'public._guard_prepay_applications_immutable()',
    'public._prebook_quick_delivery_inventory()',
    'public._receiving_records_before_delete()',
    'public._recompute_prepay_credit_balance()',
    'public.enforce_blend_ticket_products_billed_lock()',
    'public.enforce_quote_accepted_fully_drawn()',
    'public.log_comment_activity()',
    'public.log_note_activity()',
    'public.notify_mentioned_users_in_comment()',
    'public.prevent_order_shares_edit_after_post()',
    'public.snapshot_field_crop_history()',
    'public.sync_blend_ticket_payment_status()',
    'public.trg_delivery_status_change()',
    'public.trg_inventory_significant_change()',
    'public.trg_order_status_change()',
    'public.trg_po_status_change()',
    'public.trg_po_submitted_update_on_order()',
    'public.trg_recalc_order_totals()',
    'public.vendor_bills_positive_subtotal_trigger()',
    'public.calculate_billing_splits(bigint,numeric[])',
    'public.check_period_open(date)',
    'public.next_application_record_number()',
    'public.next_commission_payment_number()',
    'public.next_cycle_count_number()',
    'public.next_delivery_number()',
    'public.next_job_number()',
    'public.next_po_number()',
    'public._require_auth()',
    'public.admin_update_profile(uuid,text,text,text,boolean,text[],text)',
    'public.financial_dashboard_summary()',
    'public.get_commission_balance_report(date)',
    'public.get_inventory_cost_report()',
    'public.get_receiving_log(integer,integer,text,text,uuid,date,date)',
    'public.get_receiving_summary()',
    'public.get_sales_detail_report(date,date,uuid,uuid[],uuid,text,integer)',
    'public.get_sales_summary_report(text,date,date,uuid,uuid[],uuid,text,integer)',
    'public.operational_dashboard_summary()',
    'public.require_admin()',
    'public.require_admin_or_sales_rep()'
  ];
  v_sig text;
  v_oid oid;
  v_anon_leftover text := '';
  v_authed_lost   text := '';
  v_count int := 0;
BEGIN
  FOREACH v_sig IN ARRAY v_targets LOOP
    v_oid := v_sig::regprocedure::oid;
    v_count := v_count + 1;
    IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
      v_anon_leftover := v_anon_leftover || v_sig || ', ';
    END IF;
    IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      v_authed_lost := v_authed_lost || v_sig || ', ';
    END IF;
  END LOOP;

  IF v_count <> 40 THEN
    RAISE EXCEPTION 'REVOKE_LIST_SIZE_UNEXPECTED: expected 40 functions, checked %', v_count;
  END IF;
  IF v_anon_leftover <> '' THEN
    RAISE EXCEPTION 'ANON_EXECUTE_REMAINS: %', v_anon_leftover;
  END IF;
  IF v_authed_lost <> '' THEN
    RAISE EXCEPTION 'AUTHENTICATED_EXECUTE_LOST (signed-in app would break): %', v_authed_lost;
  END IF;
END;
$$;
