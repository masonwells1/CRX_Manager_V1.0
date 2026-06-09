-- 20260529120000_revoke_anon_execute_on_report_dashboard_secdef.sql
--
-- BLOCKER fix (workflow review 2026-05-28 + Codex cross-review 2026-05-29, live-verified).
--
-- WHAT / WHY:
--   37 SECURITY DEFINER report/dashboard/geo/financial RPCs were EXECUTE-able by the
--   `anon` role. The anon key ships in the public frontend bundle, and SECURITY DEFINER
--   bypasses RLS, so ANY unauthenticated visitor could call these and read customer PII
--   and financials. Proven exploitable as `anon` (no login): global_search returned
--   customer rows; get_customer_year_end_summary returned farm name + contact + account #
--   + financial summary; dashboard_summary / get_dashboard_action_items / get_ap_dashboard_summary
--   leaked operational + AP financials; _check_credit_limit leaks farm name + AR inside its
--   exception message (enumerable by probing UUIDs).
--
--   This migration REVOKEs EXECUTE from anon + PUBLIC on all 37, and GRANTs EXECUTE to
--   authenticated + service_role so the logged-in app is unaffected. (Every function anon
--   could call, authenticated could too via the same PUBLIC grant; the explicit GRANT here
--   preserves that authenticated access after PUBLIC is stripped.)
--
--   The 3 mutating anon-callable SECDEF fns (adjust_inventory, admin_update_profile,
--   allocate_payment) are intentionally NOT touched: each hard-rejects anon via an
--   auth.uid() NULL / require_admin() guard before any write.
--
-- FOLLOW-UP (documented in docs/audits/2026-05-29-codex-disposition.md, NOT in this file):
--   defense-in-depth = add internal role/scope guards to these report RPCs so that even an
--   authenticated non-admin can't read data they shouldn't, and so a future DROP+CREATE
--   can't silently restore PUBLIC execute. This migration is the first, urgent remediation
--   (closes the public-internet path); the internal-guard hardening is a separate pass.
--
-- Signatures below were generated live via pg_get_function_identity_arguments — do not hand-edit.

REVOKE EXECUTE ON FUNCTION public._check_credit_limit(p_customer_id uuid, p_additional_cents bigint) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public._check_credit_limit(p_customer_id uuid, p_additional_cents bigint) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.check_customer_credit_limit(p_customer_id uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_customer_credit_limit(p_customer_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.check_duplicate_blend_ticket(p_ticket_number text, p_ticket_date date) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_duplicate_blend_ticket(p_ticket_number text, p_ticket_date date) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.check_duplicate_delivery(p_order_id uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_duplicate_delivery(p_order_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.compute_application_service_fee(p_service_id uuid, p_customer_id uuid, p_acres numeric, p_season integer) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.compute_application_service_fee(p_service_id uuid, p_customer_id uuid, p_acres numeric, p_season integer) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.dashboard_summary() FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.dashboard_summary() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.derive_customer_shares_from_fields(p_field_ids uuid[], p_applied_acres_map jsonb) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.derive_customer_shares_from_fields(p_field_ids uuid[], p_applied_acres_map jsonb) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_ap_aging(p_as_of_date date) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_ap_aging(p_as_of_date date) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_ap_dashboard_summary(p_idempotency_key text) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_ap_dashboard_summary(p_idempotency_key text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_batch_year_end_summaries(p_customer_ids uuid[], p_season integer) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_batch_year_end_summaries(p_customer_ids uuid[], p_season integer) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_customer_delivery_remainders(p_customer_id uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_customer_delivery_remainders(p_customer_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_customer_farm_group(p_customer_id uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_customer_farm_group(p_customer_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_customer_summary(p_customer_id uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_customer_summary(p_customer_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_customer_transaction_review(p_customer_id uuid, p_start_date date, p_end_date date) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_customer_transaction_review(p_customer_id uuid, p_start_date date, p_end_date date) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_customer_year_end_summary(p_customer_id uuid, p_season integer) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_customer_year_end_summary(p_customer_id uuid, p_season integer) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_dashboard_action_items(p_limit integer) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_dashboard_action_items(p_limit integer) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_detailed_statement_data(p_customer_id uuid, p_as_of_date date, p_mode text) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_detailed_statement_data(p_customer_id uuid, p_as_of_date date, p_mode text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_expiring_planned_holds(p_days_ahead integer, p_idempotency_key text) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_expiring_planned_holds(p_days_ahead integer, p_idempotency_key text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_field_billing_splits_for_blend_ticket(p_blend_ticket_id uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_field_billing_splits_for_blend_ticket(p_blend_ticket_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_field_billing_splits_for_order(p_order_id uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_field_billing_splits_for_order(p_order_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_field_dashboard(p_field_id uuid, p_season integer) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_field_dashboard(p_field_id uuid, p_season integer) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_field_geojson(p_field_id uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_field_geojson(p_field_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_field_polygons(p_field_id uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_field_polygons(p_field_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_fields_with_geojson(p_customer_id uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_fields_with_geojson(p_customer_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_inventory_forecast(p_months_ahead integer) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_inventory_forecast(p_months_ahead integer) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_inventory_position() FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_inventory_position() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_monthly_summary(p_period_start date, p_period_end date) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_monthly_summary(p_period_start date, p_period_end date) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_notes_for_entity(p_entity_type text, p_entity_id uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_notes_for_entity(p_entity_type text, p_entity_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_program_completion(p_season integer) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_program_completion(p_season integer) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_rup_sales_register(p_start_date date, p_end_date date, p_product_id uuid, p_customer_id uuid, p_compliance_status text) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_rup_sales_register(p_start_date date, p_end_date date, p_product_id uuid, p_customer_id uuid, p_compliance_status text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_season_comparison(p_season_a integer, p_season_b integer) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_season_comparison(p_season_a integer, p_season_b integer) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_team_board_deliveries() FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_team_board_deliveries() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_team_workload() FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_team_workload() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_yesterday_delivery_recap() FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_yesterday_delivery_recap() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.global_search(p_query text, p_limit integer) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.global_search(p_query text, p_limit integer) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.preview_field_app_invoice_split(p_locations jsonb, p_chemicals jsonb, p_application_service_id uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.preview_field_app_invoice_split(p_locations jsonb, p_chemicals jsonb, p_application_service_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.preview_finance_charges(p_as_of_date date) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.preview_finance_charges(p_as_of_date date) TO authenticated, service_role;

-- Verification: assert none of the 37 remain anon-EXECUTE-able.
DO $$
DECLARE
  v_leak integer;
BEGIN
  SELECT count(*) INTO v_leak
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname IN (
      '_check_credit_limit','check_customer_credit_limit','check_duplicate_blend_ticket',
      'check_duplicate_delivery','compute_application_service_fee','dashboard_summary',
      'derive_customer_shares_from_fields','get_ap_aging','get_ap_dashboard_summary',
      'get_batch_year_end_summaries','get_customer_delivery_remainders','get_customer_farm_group',
      'get_customer_summary','get_customer_transaction_review','get_customer_year_end_summary',
      'get_dashboard_action_items','get_detailed_statement_data','get_expiring_planned_holds',
      'get_field_billing_splits_for_blend_ticket','get_field_billing_splits_for_order',
      'get_field_dashboard','get_field_geojson','get_field_polygons','get_fields_with_geojson',
      'get_inventory_forecast','get_inventory_position','get_monthly_summary','get_notes_for_entity',
      'get_program_completion','get_rup_sales_register','get_season_comparison',
      'get_team_board_deliveries','get_team_workload','get_yesterday_delivery_recap',
      'global_search','preview_field_app_invoice_split','preview_finance_charges'
    )
    AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_leak > 0 THEN
    RAISE EXCEPTION 'REVOKE verification failed: % of the 37 report RPCs still anon-EXECUTE-able', v_leak;
  END IF;
  RAISE NOTICE 'OK: 0 of the 37 report RPCs are anon-EXECUTE-able.';
END $$;
