/**
 * Fixture-vs-LIVE RPC name diff (C6 control).
 *
 * docs/audits/2026-06-10-error-prevention-review.md §4 C6:
 * "fixture RPC name arrays diffed against live pg_proc".
 *
 * WHY: the test suite carries checked-in RPC name arrays
 * (rpcContracts.test.ts MUTATING_RPCS_WITH_IDEMPOTENCY /
 * MUTATING_RPCS_MISSING_IDEMPOTENCY, rpcIdempotencyScope.test.ts snapshot
 * buckets). When an RPC is dropped or renamed in the database, those fixture
 * entries linger and the suite keeps green-lighting coverage of a function
 * that no longer exists — the `record_payment` class (a dropped RPC sat in
 * the fixtures until the 2026-06-08 Codex NIT removed it).
 *
 * This test diffs every fixture name array against a checked-in snapshot of
 * live pg_proc. The arrays are read from the sibling test files' SOURCE TEXT
 * (not imported) so their describe blocks are not double-registered and the
 * fixtures keep a single source of truth.
 *
 * ── LIVE LIST REGENERATION (read-only; no script needed) ─────────────────
 * Run via Supabase MCP `execute_sql` (project rhyzpcqhnizqbxphqdkr) and
 * paste the `names` value into LIVE_PG_PROC_NAMES_CSV below (update the
 * count + date too):
 *
 *   SELECT string_agg(DISTINCT proname, ',' ORDER BY proname) AS names,
 *          count(DISTINCT proname) AS n
 *   FROM pg_proc
 *   WHERE pronamespace = 'public'::regnamespace AND prokind = 'f';
 *
 * Regenerate after any migration that creates, drops, or renames a function.
 * A frontend call introduced in the same branch as an unapplied migration may
 * use the narrow QUEUED_MIGRATION_FUNCTIONS exception below only while that
 * function is absent from live pg_proc, created by an exact checked-in migration
 * file, and this snapshot has not yet been regenerated.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as ts from 'typescript';

// -------------------------------------------------------------------------
// Checked-in live snapshot — verified 2026-09-03, 626 public functions
// (see LIVE_PG_PROC_COUNT below, which is authoritative; includes trigger/helper
// functions and supersets the user-facing RPCs).
// Kept as the raw comma-joined DB output to make regeneration a single paste.
// -------------------------------------------------------------------------

const LIVE_PG_PROC_NAMES_CSV =
 '__plpgsql_show_dependency_tb,_allocated_cumulative_cents,_allocated_delivery_cents,_apply_product_cost_basis_change_set_serialized_inner,_approve_return_intent_impl_20260812,_batch_apply_prepayments_impl,_begin_below_cost_money_write,_below_cost_reason_from_json,_below_cost_reason_from_text,_bind_completed_lifecycle_idempotency,_bulk_import_order_below_cost_impl_20260810,_calculate_product_pricing,_cancel_order_idem_impl_20260721,_cancel_order_impl_20260714,_cancel_order_provenance_wrapper_20260719,_cancel_order_split_provenance_impl_20260719,_cancel_return_intent_impl_20260812,_check_credit_limit,_claim_bound_lifecycle_idempotency,_close_job_location_dispatch_on_job_terminal,_close_undelivered_order_remainder_20260718,_complete_cycle_count_impl,_complete_cycle_count_pre_revision_20260831,_complete_delivery_aggregate_impl,_complete_delivery_authorized_impl,_complete_delivery_period_preflight_impl,_convert_quote_to_order_below_cost_impl_20260810,_convert_quote_to_order_owner_impl,_create_commission_payment_intent_impl_20260809,_create_direct_order_below_cost_impl_20260810,_create_invoice_for_unbilled_delivery_idem_impl_20260721,_create_invoice_for_unbilled_delivery_impl_20260718,_create_invoice_from_order_idem_impl_20260721,_create_invoice_from_order_impl_20260718,_create_quick_delivery_intent_impl_20260802,_create_quote_version_owner_impl,_create_return_intent_impl_20260812,_create_rush_order_below_cost_impl_20260810,_create_split_invoices_from_order_provenance_impl_20260719,_delete_invoices_split_provenance_impl_20260719,_draw_down_quote_below_cost_impl_20260810,_draw_down_quote_intent_impl_20260819,_duplicate_quote_below_cost_impl_20260810,_enforce_allocation_not_over_payment,_enforce_applicator_license,_enforce_below_cost_line,_enforce_billed_job_applied_record_immutability,_enforce_billed_job_immutability,_enforce_delivery_items_parent_lock,_enforce_delivery_status_transition,_enforce_field_billing_defaults_sum_100,_enforce_invoice_status_transition,_enforce_job_status_transition,_enforce_order_status_transition,_enforce_po_status_transition,_enforce_quote_status_transition,_enforce_quote_terminal_not_drawn,_enforce_return_status_transition,_fill_audit_actor,_format_pricing_dollars,_format_pricing_margin_percent,_generate_finance_charges_idem_impl_20260721,_get_customer_statement_scoped_impl,_guard_below_cost_approval_immutable,_guard_credit_memo_application_immutable,_guard_delivery_delete,_guard_idempotency_key_insert,_guard_inventory_location_change,_guard_inventory_transactions_immutable,_guard_invoice_delete,_guard_last_active_admin,_guard_offline_action_receipt_insert,_guard_order_customer_source_lineage,_guard_order_delete,_guard_order_item_delivery_lineage,_guard_po_delete,_guard_prepay_applications_immutable,_guard_profile_role_lock,_guard_quote_item_cost_snapshot,_guard_recipient_name_reuse,_insert_commissions_for_job,_insert_commissions_for_order,_invalidate_deleted_purchase_order_retry_state,_is_admin_override,_is_dispatched_to_me,_issue_return_credit_header_only_impl_20260825,_issue_return_credit_impl,_issue_return_credit_intent_impl_20260812,_lock_accounting_months,_lr_allocate_int,_mark_delivery_aggregate_short_stock,_parse_pricing_dollars,_parse_pricing_margin_percent,_post_commission_payment_intent_impl_20260809,_post_deleted_delivery_recovery_invoice_20260719,_post_invoice_customer_scope_impl,_post_invoice_group_customer_scope_impl,_post_invoice_idem_impl_20260721,_post_invoice_impl_20260714,_post_invoice_public_impl_20260718,_prebook_quick_delivery_inventory,_preserve_job_location_dispatch_on_field_delete,_price_order_below_cost_impl_20260810,_product_cost_basis_row_required,_purchase_order_item_unit_cost_cents,_receive_return_impl_20260714,_receive_return_impl_before_inventory_seed_20260825,_receive_return_intent_impl_20260812,_receiving_records_before_delete,_recompute_po_on_order_for_products,_recompute_prepay_credit_balance,_reject_return_intent_impl_20260812,_require_auth,_require_bulk_po_content_fingerprint,_resnapshot_order_item_cost_on_product_change,_resolve_product_cost_basis_row,_restore_quote_version_below_cost_impl_20260810,_restore_quote_version_owner_impl,_reverse_completed_cycle_count_impl,_reverse_credit_memo_application,_reverse_credit_memo_application_status_impl_20260812,_round_money_to_whole_cents,_save_field_app_invoice_impl_20260714,_save_field_app_split_invoice_impl,_save_invoice_below_cost_impl_20260810,_save_invoice_governed_split_guard_impl_20260720,_save_invoice_intent_impl_20260802,_save_invoice_lineage_unaware_impl_20260827,_save_invoice_scoped_impl,_save_invoice_split_provenance_impl_20260719,_save_purchase_order_ascii_identity_impl,_save_purchase_order_atomic_number_impl,_save_purchase_order_cost_input_impl,_save_quote_below_cost_impl_20260810,_section9_bind_idempotency_receipt_20260826,_section9_cancel_purchase_order_serialized,_section9_create_vendor_bill_cumulative_impl,_section9_create_vendor_bill_intent_impl_20260826,_section9_delete_purchase_order_serialized,_section9_receive_po_items_intent_impl_20260826,_section9_receive_po_items_intent_impl_20260831,_section9_receive_po_items_serialized,_section9_record_vendor_payment_intent_impl_20260826,_section9_record_vendor_payment_intent_impl_20260831,_section9_reverse_receiving_record_serialized,_section9_save_purchase_order_serialized,_section9_submit_purchase_order_serialized,_section9_update_vendor_bill_intent_impl_20260826,_section9_update_vendor_bill_intent_impl_20260831,_section9_void_vendor_bill_intent_impl_20260826,_section9_void_vendor_bill_intent_impl_20260831,_section9_void_vendor_payment_intent_impl_20260826,_snapshot_order_item_cost,_snapshot_quote_item_cost,_split_invoice_content_claim,_supplier_cost_basis_enabled_for_product,_sync_auth_access_on_profile_active,_sync_job_holds,_sync_job_location_dispatch_on_applicator_change,_sync_job_location_dispatch_on_field_insert,_sync_planned_holds,_sync_quote_job_reservations,_trg_release_job_holds_on_lifecycle,_trg_sync_job_holds,_unapply_return_credit_guard_impl_20260826,_update_order_items_below_cost_impl_20260810,_update_order_items_impl,_validate_order_shares_total,_void_commission_payment_intent_impl_20260809,_void_invoice_group_guard_impl_20260720,_void_invoice_return_credit_guard_impl_20260826,_void_invoice_split_provenance_impl_20260719,_void_order_impl_20260714,adjust_inventory,admin_get_application_service_costs,admin_save_application_service,admin_set_application_service_cost,admin_update_profile,allocate_payment,apply_credit_memo_to_invoice,apply_prepay_to_invoice,apply_product_cost_basis_change_set,apply_product_pricing_change_set,apply_remaining_prepayments,apply_write_off,approve_return,approve_supplier_price_import,assert_customer_balance_reconstructable_as_of,assert_phase3_product_metadata_change_safe,assert_phase3_return_policy,assign_customers_sales_rep,assign_job_applicator,auto_expire_quotes,batch_apply_all_prepayments,batch_apply_prepayments,batch_approve_blend_tickets,batch_cancel_deliveries,batch_post_invoices,batch_reject_blend_tickets,batch_reschedule_deliveries,batch_void_invoices,bulk_create_label_drafts,bulk_import_order,bump_cycle_count_item_revision,bump_record_row_version,calculate_billing_splits,calculate_prices_from_margin,cancel_cycle_count,cancel_delivery,cancel_order,cancel_purchase_order,cancel_return,capture_purchase_order_item_cost_snapshot,check_customer_credit_limit,check_duplicate_blend_ticket,check_duplicate_delivery,check_idempotency,check_idempotency_intent,check_period_open,check_rate_limit,check_remainder_reminders,check_unpriced_orders,cleanup_rate_limits,close_accounting_period,close_quote_as_applied,close_quote_as_short,commission_recipient_name_for_id,commission_recipient_resolves,commission_split_with_recipient_ids,commit_blend_ticket_ocr_result,commit_label_draft,complete_cycle_count,complete_delivery,complete_job,complete_team_note,compute_application_service_fee,compute_commission_amount,compute_even_split_vector,compute_fuel_surcharge_cents,compute_line_split_allocation,compute_season,confirm_delivery,confirm_job_notification_sent,consolidate_draft_invoices,convert_quote_to_order,convert_to_gl_lb,correct_supplier_price_observation,create_application_record_from_blend_ticket,create_blend_ticket,create_commission_payment,create_delivery_with_items,create_direct_order,create_followup_delivery,create_inventory_hold,create_invoice_for_unbilled_delivery,create_invoice_from_blend_ticket,create_invoice_from_order,create_job_from_quote_section,create_label_draft,create_order_from_blend_ticket,create_planned_holds,create_prepay_check_splits,create_pricing_workbook_export,create_quick_delivery,create_quote_from_template,create_quote_version,create_rebate_claim,create_return,create_rush_order,create_split_invoices_from_order,create_vendor_bill,current_season,dashboard_summary,defer_phase3_return_item_product_fk,delete_invoices,delete_prepay_credit,delete_purchase_order,delete_vendor,derive_customer_shares_from_fields,dismiss_watchdog_flag,dispatch_job_locations,draw_down_quote,duplicate_quote,edit_delivery,edit_prepay_credit,enforce_blend_ticket_fields_billed_lock,enforce_blend_ticket_fields_downstream_lock,enforce_blend_ticket_products_billed_lock,enforce_commission_recipient_resolved,enforce_delivery_accounting_period,enforce_field_application_type_lock,enforce_invoice_draft_on_insert,enforce_linked_blend_ticket_header_lock,enforce_linked_blend_ticket_product_lock,enforce_quote_accepted_fully_drawn,enforce_return_lifecycle_rpc_owned,enforce_return_source_immutable,execute_sql_readonly,field_app_priced_quantity,fields_acre_authority_guard,financial_dashboard_summary,find_overlapping_fields,generate_batch_statements,generate_finance_charges,generate_order_number,generate_quote_number,generate_rup_sales_records,generate_ticket_number,get_ap_aging,get_ap_dashboard_summary,get_ar_aging,get_ar_reminder_candidates,get_batch_year_end_summaries,get_booking_settlement,get_bottom_line_pnl,get_call_list_lapsed_products,get_call_list_no_recent_contact,get_call_list_prepay_prospects,get_call_list_stale_quotes,get_call_list_unassigned_accounts,get_chemical_history,get_commission_balance_report,get_commission_history_report,get_commission_payment_detail_report,get_customer_balance_listing,get_customer_delivery_remainders,get_customer_farm_group,get_customer_lapsed_products,get_customer_prep_card,get_customer_purchase_summary,get_customer_statement,get_customer_summary,get_customer_transaction_review,get_customer_year_end_summary,get_dashboard_action_items,get_detailed_statement_data,get_dispatch_board_jobs,get_dispatch_stock_status,get_dispatched_list,get_expiring_planned_holds,get_field_billing_splits_for_blend_ticket,get_field_billing_splits_for_order,get_field_dashboard,get_field_geojson,get_field_polygons,get_field_profitability,get_fields_geojson_by_ids,get_fields_with_geojson,get_gross_sales_report,get_inventory_cost_report,get_inventory_forecast,get_inventory_position,get_job_billed_customers,get_job_fields_with_geojson,get_job_inventory_shortfalls,get_job_proof_data,get_jobs_billed_customers,get_label_coverage_report,get_logbook_by_applicator,get_logbook_by_customer,get_logbook_by_field,get_logbook_faa,get_lot_application_trace,get_monthly_summary,get_notes_for_entity,get_offline_action_review_queue,get_offline_action_status,get_open_booking_rollover,get_product_cost_basis_workspace,get_product_price_history,get_profitability_report,get_program_completion,get_receiving_log,get_receiving_summary,get_recent_lots_for_product,get_rep_customer_purchase_flags,get_rup_sales_register,get_sales_detail_report,get_sales_summary_report,get_season_comparison,get_supplier_market_evidence,get_supplier_price_import,get_supplier_pricing_workspace,get_supplier_quote_sheet,get_team_board_deliveries,get_team_workload,get_watchdog_flags,get_yesterday_delivery_recap,global_search,guard_and_version_product_pricing,guard_audit_log_immutable,guard_completed_delivery_signature,guard_customer_document_update,guard_customer_fact_provenance,guard_interaction_attribution,guard_invoice_terminal_order,guard_mono_invoice_split_billing_post,guard_order_delivered_activity_cancel,guard_phase3_product_metadata,guard_product_cost_basis_unit_change,guard_quote_commission_split_valid,guard_recognized_return_credit_delete,guard_return_credit_lineage,guard_return_credit_source_recognition,guard_split_invoice_items,guard_split_invoice_provenance_identity,guard_split_invoice_provenance_items,guard_supplier_price_observation_immutable,guard_terminal_order_invoice_items,handle_new_user,increment_customer_prepay,is_active_profile,is_admin,is_applicator,is_driver,is_sales_rep,issue_return_credit,jobs_snapshot_commission_split,link_blend_ticket_to_order,link_fields_to_parent,list_commission_recipients,load_recipe_into_job,lock_and_assert_phase3_return_item_insert_policy,lock_and_assert_phase3_return_item_update_policy,lock_phase3_product_policy_products,lock_phase3_return_status_products,log_comment_activity,log_customer_fact,log_customer_interaction,log_failed_notification,log_note_activity,manual_inventory_add,mark_inventory_row_verified,mark_overdue_invoices,match_quick_receive_items,next_application_record_number,next_commission_payment_number,next_cycle_count_number,next_delivery_number,next_invoice_number,next_job_number,next_po_number,next_return_number,normalize_phone_e164,normalize_product_category,normalize_rate_unit,normalize_vendor_alias,notify_damaged_receiving,notify_mentioned_users_in_comment,notify_team_note_assignment,operational_dashboard_summary,parse_payment_terms_days,plpgsql_check_function,plpgsql_check_function_tb,plpgsql_check_pragma,plpgsql_check_profiler,plpgsql_check_tracer,plpgsql_coverage_branches,plpgsql_coverage_statements,plpgsql_profiler_function_statements_tb,plpgsql_profiler_function_tb,plpgsql_profiler_functions_all,plpgsql_profiler_install_fake_queryid_hook,plpgsql_profiler_remove_fake_queryid_hook,plpgsql_profiler_reset,plpgsql_profiler_reset_all,plpgsql_show_dependency_tb,post_commission_payment,post_invoice,post_invoice_group,prevent_commission_history_ledger_mutation,prevent_commission_history_ledger_truncate,prevent_invoice_line_shares_edit_after_post,prevent_oifa_edit_after_post,prevent_order_shares_edit_after_post,preview_field_app_invoice_split,preview_finance_charges,preview_product_cost_basis_changes,preview_product_pricing_changes,price_order,process_offline_action,product_price_per_acre,protect_product_cost_basis_history,reactivate_vendor,reassign_delivery,recalc_product_price_per_acre,receive_po_items,receive_return,recompute_job_applied_acres,reconcile_negative_inventory,reconcile_prepay_balances,record_commission_earned_state,record_commission_settlement_event,record_invoice_payment,record_job_post_notifications,record_job_pre_notifications,record_vendor_payment,refresh_watchdog_flags,reject_return,reject_supplier_price_import,release_expired_quote_holds,release_holds_on_quote_status_change,release_inventory_hold,reopen_accounting_period,require_admin,require_admin_or_sales_rep,require_governed_product_pricing,require_product_cost_basis_context,require_split_invoice_creation_claim,reserve_job_inventory,resolve_commission_recipient_id,resolve_commission_split_recipient,resolve_field_app_chemical_price,resolve_line_split_vector,resolve_offline_action,restore_cancelled_delivery,restore_cancelled_order,restore_quote_version,retire_inventory_item,retry_failed_notifications,reverse_application_record,reverse_blend_ticket_approval,reverse_completed_cycle_count,reverse_credit_memo_application,reverse_receiving_record,reverse_write_off,revert_quote_status,review_customer_fact,review_vendor_alias,rollover_quote_to_season,run_data_integrity_sweep,run_morning_notification_checks,run_weekly_db_backup,safe_cents_qty,save_blend_recipe,save_blend_ticket,save_blend_ticket_fields,save_customer,save_field,save_field_app_invoice,save_field_app_split_invoice,save_field_crop_history,save_field_geometry,save_field_polygons,save_idempotency,save_invoice,save_job,save_job_applied_record,save_purchase_order,save_quote,save_quote_template,save_vendor,season_end_date,season_start_date,set_application_record_lots,set_field_boundary,set_field_override_acres,set_primary_customer_contact,set_product_phase3_metadata,set_supplier_evidence_updated_at,settle_applied_record_acres,snapshot_field_crop_history,snapshot_invoice_line_shares_on_post,stage_offline_action,stage_supplier_price_import,stage_vendor_alias,stamp_commission_cancellation_history,stamp_commission_split_recipient_ids,stamp_job_printed,start_job,statement_customer_has_later_balance_activity,statement_invoice_was_posted_as_of,submit_purchase_order,supersede_customer_fact,sync_blend_ticket_payment_status,sync_customer_to_primary_contact,sync_legacy_product_cost_basis,sync_primary_contact_to_customer,sync_profile_public_directory,touch_blend_ticket_product_parent_version,transfer_invoice_to_job,transfer_job_to_invoice,transition_rebate_claim,trg_delivery_status_change,trg_inventory_significant_change,trg_jarf_recompute,trg_job_applied_record_recompute,trg_order_status_change,trg_po_items_recompute_on_order,trg_po_status_change,trg_po_status_recompute_on_order,trg_po_submitted_update_on_order,trg_product_label_drafts_updated_at,trg_recalc_order_totals,unapply_credit_memo,undispatch_job_locations,unlink_blend_ticket_from_order,unlink_field_from_parent,unpost_invoice,unpost_invoice_group,update_blend_ticket_billing_status,update_blend_ticket_updated_at,update_cycle_count_item,update_field_app_applied_info,update_field_app_invoice_billing,update_fields_updated_at,update_note_comment_timestamp,update_order_items,update_updated_at,update_vendor_bill,upsert_product_supplier_link,validate_commission_payment_item_history,validate_commission_split_json,validate_phase3_return_item_policy,validate_product_units,validate_supplier_price_observation_insert,vendor_bills_positive_subtotal_trigger,void_commission_payment,void_delivery,void_invoice,void_invoice_group,void_order,void_payment,void_vendor_bill,void_vendor_payment,write_product_pricing_history';

const LIVE_PG_PROC_COUNT = 626; // count(DISTINCT proname); verified from live after commission report snapshot apply.
const LIVE_FUNCTIONS = new Set(LIVE_PG_PROC_NAMES_CSV.split(','));

// Temporary bridge for a branch that adds both a new RPC migration and its
// frontend caller. Map each function to the exact checked-in migration that
// creates it. The test below verifies the function is not live, the migration
// source is still pending, and the entry must be removed after the migration is
// live and the pg_proc snapshot has been regenerated.
const QUEUED_MIGRATION_FUNCTIONS: Record<string, string> = {};
const QUEUED_FUNCTIONS = new Set(Object.keys(QUEUED_MIGRATION_FUNCTIONS));

// -------------------------------------------------------------------------
// Fixture-array extraction from sibling test files (source text, not import)
// -------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));

function sourceOf(file: string): string {
  return readFileSync(join(HERE, file), 'utf8');
}

/** Find every literal `.rpc('name')` call in production source files. */
function productionRpcCalls(): string[] {
  const names = new Set<string>();
  const srcRoot = join(HERE, '..');

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(?:ts|tsx|js|jsx)$/.test(entry) || /\.(?:test|spec)\./.test(entry) || entry.endsWith('.d.ts')) {
        continue;
      }
      const source = readFileSync(full, 'utf8');
      const scriptKind = entry.endsWith('.tsx')
        ? ts.ScriptKind.TSX
        : entry.endsWith('.jsx')
          ? ts.ScriptKind.JSX
          : entry.endsWith('.js')
            ? ts.ScriptKind.JS
            : ts.ScriptKind.TS;
      const ast = ts.createSourceFile(full, source, ts.ScriptTarget.Latest, false, scriptKind);
      function visit(node: ts.Node): void {
        if (
          ts.isCallExpression(node)
          && ts.isPropertyAccessExpression(node.expression)
          && node.expression.name.text === 'rpc'
          && node.arguments.length > 0
          && (ts.isStringLiteral(node.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))
        ) {
          names.add(node.arguments[0].text);
        }
        ts.forEachChild(node, visit);
      }
      visit(ast);
    }
  }

  walk(srcRoot);
  return [...names].sort();
}

/**
 * Remove `//` line comments and block comments from a literal body, leaving
 * string literals (and their contents) untouched.
 *
 * WHY: the extractors below regex the RAW body text, so any quoted word in an
 * explanatory comment INSIDE one of the fixture arrays became a phantom entry
 * and failed the ghost check with a confusing message (observed 2026-08-16: a
 * comment reading `the 'delegated' note in IDEMPOTENCY_BODY_EXEMPT below`
 * produced the ghost entry "delegated"). Rewording the comment worked around
 * it; stripping comments here fixes it for good.
 *
 * Newlines inside a stripped comment are preserved so line-anchored extraction
 * (extractObjectKeys) cannot silently merge two lines into one.
 *
 * Scope note: this is only ever applied to an already-captured object/array
 * literal body, where a `/` can only begin a comment — never a regex literal.
 */
/** Index just past the string literal that starts at `i` (handles escapes). */
function skipStringLiteral(text: string, i: number): number {
  const quote = text[i];
  let j = i + 1;
  while (j < text.length) {
    if (text[j] === '\\') {
      j += 2;
      continue;
    }
    if (text[j] === quote) return j + 1;
    j += 1;
  }
  return j; // unterminated — treat the rest as string rather than re-lexing it
}

function stripComments(body: string): string {
  let out = '';
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = skipStringLiteral(body, i);
      out += body.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && body[i + 1] === '/') {
      while (i < body.length && body[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && body[i + 1] === '*') {
      const end = body.indexOf('*/', i + 2);
      const stop = end === -1 ? body.length : end + 2;
      out += body.slice(i, stop).replace(/[^\n]/g, '');
      i = stop;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Body of `const NAME ... = [ … ];` / `= { … };`, found by a quote- and
 * comment-aware scan for the BALANCED closing bracket.
 *
 * WHY not a regex: a lazy `[\s\S]*?\];` ends at the first `];` in the text, so
 * a `];` written inside a comment inside the literal would cut the body short
 * and silently drop every entry after it — an under-reported fixture is exactly
 * the failure the ghost check exists to catch.
 */
function literalBody(source: string, constName: string, open: '[' | '{', file: string): string {
  const decl = new RegExp(`const ${constName}\\b[^=]*=\\s*\\${open}`).exec(source);
  if (!decl) throw new Error(`Could not find const ${constName} in ${file}`);
  const close = open === '[' ? ']' : '}';
  const start = decl.index + decl[0].length;
  let depth = 1;
  let i = start;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipStringLiteral(source, i);
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === '[' || ch === '{' || ch === '(') depth += 1;
    else if (ch === ']' || ch === '}' || ch === ')') {
      depth -= 1;
      if (depth === 0) {
        if (ch !== close) {
          throw new Error(`const ${constName} in ${file} closed with '${ch}', expected '${close}'`);
        }
        return source.slice(start, i);
      }
    }
    i += 1;
  }
  throw new Error(`Unterminated const ${constName} literal in ${file}`);
}

/** Extract the string entries of `const NAME ... = [ ... ];` from source. */
function extractArray(source: string, constName: string, file: string): string[] {
  const body = stripComments(literalBody(source, constName, '[', file));
  return [...body.matchAll(/'([A-Za-z0-9_]+)'/g)].map((x) => x[1]);
}

/** Extract the keys of `const NAME ... = { key: 'value', ... };` from source. */
function extractObjectKeys(source: string, constName: string, file: string): string[] {
  const body = stripComments(literalBody(source, constName, '{', file));
  return [...body.matchAll(/^\s*([A-Za-z0-9_]+)\s*:/gm)].map((x) => x[1]);
}

// -------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------

describe('Fixture-array extraction ignores comments', () => {
  // Regression guard for the phantom-entry bug: a quoted word inside a comment
  // in one of the extracted arrays used to become a fixture entry and fail the
  // ghost check below. Rewording the comment was the old workaround; these
  // cases prove the extractor now ignores comment text entirely.
  const ARRAY_WITH_COMMENTS = [
    "const SAMPLE_FIXTURE: string[] = [",
    "  // the 'delegated' note in IDEMPOTENCY_BODY_EXEMPT below",
    "  'real_first', // trailing 'ghost_trailing' note",
    "  /* block 'ghost_block' note",
    "     spanning 'ghost_second_line' lines */",
    "  'real_second',",
    "];",
  ].join('\n');

  it('does not turn a quoted word in a comment into a fixture entry', () => {
    expect(extractArray(ARRAY_WITH_COMMENTS, 'SAMPLE_FIXTURE', 'synthetic')).toEqual([
      'real_first',
      'real_second',
    ]);
  });

  it('still throws when the const is absent (no silent empty fixture)', () => {
    expect(() => extractArray(ARRAY_WITH_COMMENTS, 'MISSING_FIXTURE', 'synthetic')).toThrow(
      /Could not find const MISSING_FIXTURE/
    );
  });

  it('ignores comment text in object-key extraction without merging lines', () => {
    const objectWithComments = [
      "const SAMPLE_ALIAS: Record<string, string> = {",
      "  // ghost_key: 'not a real entry'",
      "  real_key: 'value', /* note",
      "     continued */ second_key: 'value',",
      "};",
    ].join('\n');
    expect(extractObjectKeys(objectWithComments, 'SAMPLE_ALIAS', 'synthetic')).toEqual([
      'real_key',
      'second_key',
    ]);
  });

  it('does not end the array at a `];` written inside a comment', () => {
    // The lazy-regex extractor ended the body here and dropped every entry
    // after the comment — a silently UNDER-reported fixture, which is the
    // failure the ghost check exists to catch.
    const source = [
      "const SAMPLE_FIXTURE: string[] = [",
      "  'before_comment',",
      "  // the array used to end at this `];` sequence",
      "  'after_line_comment',",
      "  /* and at this one too: `];`",
      "     still inside the block comment */",
      "  'after_block_comment',",
      "];",
      "const LATER_CONST: string[] = ['unrelated'];",
    ].join('\n');
    expect(extractArray(source, 'SAMPLE_FIXTURE', 'synthetic')).toEqual([
      'before_comment',
      'after_line_comment',
      'after_block_comment',
    ]);
  });

  it('does not end the object at a `};` written inside a comment', () => {
    const source = [
      "const SAMPLE_ALIAS: Record<string, string> = {",
      "  first_key: 'a',",
      "  // the object used to end at this `};` sequence",
      "  second_key: 'b',",
      "  /* and at this one: `};` */",
      "  third_key: 'c',",
      "};",
    ].join('\n');
    expect(extractObjectKeys(source, 'SAMPLE_ALIAS', 'synthetic')).toEqual([
      'first_key',
      'second_key',
      'third_key',
    ]);
  });

  it('does not end the literal at a bracket inside a string entry', () => {
    const source = [
      "const SAMPLE_FIXTURE: string[] = [",
      "  'first_rpc',",
      "  'not_an_identifier ]; still a string',",
      "  'second_rpc',",
      "];",
    ].join('\n');
    expect(extractArray(source, 'SAMPLE_FIXTURE', 'synthetic')).toEqual(['first_rpc', 'second_rpc']);
  });

  it('matches the whole const name, not a prefix of a longer one', () => {
    const source = [
      "const SAMPLE_FIXTURE_EXTENDED: string[] = ['wrong_const'];",
      "const SAMPLE_FIXTURE: string[] = ['right_const'];",
    ].join('\n');
    expect(extractArray(source, 'SAMPLE_FIXTURE', 'synthetic')).toEqual(['right_const']);
  });

  it('leaves comment-like text inside a string literal alone', () => {
    const trickySource = [
      "const TRICKY_FIXTURE: string[] = [",
      "  'a_real_rpc', // note about // slashes",
      "  'another_rpc',",
      "];",
    ].join('\n');
    expect(extractArray(trickySource, 'TRICKY_FIXTURE', 'synthetic')).toEqual([
      'a_real_rpc',
      'another_rpc',
    ]);
  });
});

describe('Live pg_proc snapshot integrity', () => {
  it('snapshot has the expected count, no duplicates, sorted', () => {
    const names = LIVE_PG_PROC_NAMES_CSV.split(',');
    expect(names.length).toBe(LIVE_PG_PROC_COUNT);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([...names].sort());
  });

  it('queued-function exceptions are absent live and sourced by a pending migration', () => {
    const migrationsDir = join(HERE, '..', '..', 'supabase', 'migrations');
    for (const [rpc, migration] of Object.entries(QUEUED_MIGRATION_FUNCTIONS)) {
      expect(rpc, `${rpc} must be an unquoted SQL identifier`).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
      expect(LIVE_FUNCTIONS.has(rpc), `${rpc} is already live; remove its queued exception`).toBe(false);
      const filenameMatch = /^\d{14}_.+\.sql$/.exec(migration);
      expect(filenameMatch, `${rpc} queued migration must be a checked-in migration filename`).not.toBeNull();
      const createPattern = new RegExp(
        `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+(?:public\\.)?${rpc}\\s*\\(`,
        'i'
      );
      expect(
        createPattern.test(readFileSync(join(migrationsDir, migration), 'utf8')),
        `${rpc} is not created by its declared migration source`
      ).toBe(true);
    }
  });

  it('every literal production RPC call exists live or in a verified queued migration', () => {
    const calls = productionRpcCalls();
    expect(calls.length).toBeGreaterThanOrEqual(200); // vacuous-pass guard
    expect(calls.filter((rpc) => !LIVE_FUNCTIONS.has(rpc) && !QUEUED_FUNCTIONS.has(rpc))).toEqual([]);
  }, 20_000);

  it('does not commit queued RPC exceptions', () => {
    // A non-empty map is only safe as a short-lived local bridge while testing
    // a branch that adds a new RPC and caller together. Do not merge with one:
    // the frontend can deploy before the migration applies and call a missing
    // production RPC.
    expect(Object.keys(QUEUED_MIGRATION_FUNCTIONS)).toEqual([]);
  });
});

describe('rpcContracts.test.ts fixture arrays vs live pg_proc', () => {
  const contractsSource = sourceOf('rpcContracts.test.ts');

  it('every MUTATING_RPCS_WITH_IDEMPOTENCY entry exists in live pg_proc', () => {
    const fixture = extractArray(
      contractsSource,
      'MUTATING_RPCS_WITH_IDEMPOTENCY',
      'rpcContracts.test.ts'
    );
    expect(fixture.length).toBeGreaterThanOrEqual(78); // vacuous-pass guard
    const ghosts = fixture.filter((rpc) => !LIVE_FUNCTIONS.has(rpc) && !QUEUED_FUNCTIONS.has(rpc));
    // If this fails, an RPC was dropped/renamed in the DB but its fixture
    // entry lingers (the record_payment class). Remove it from the fixture
    // (and from IDEMPOTENCY_BODY_EXEMPT if present) — or, if the RPC should
    // exist, the live snapshot above needs regenerating (see header).
    expect(ghosts).toEqual([]);
  });

  it('every MUTATING_RPCS_MISSING_IDEMPOTENCY entry exists in live pg_proc', () => {
    const fixture = extractArray(
      contractsSource,
      'MUTATING_RPCS_MISSING_IDEMPOTENCY',
      'rpcContracts.test.ts'
    );
    // Zero is the intended end state. extractArray throws if the fixture is
    // removed or renamed, while the populated WITH_IDEMPOTENCY inventory above
    // remains the non-vacuous mutator guard.
    const ghosts = fixture.filter((rpc) => !LIVE_FUNCTIONS.has(rpc));
    expect(ghosts).toEqual([]);
  });
});
describe('rpcIdempotencyScope.test.ts snapshot buckets vs live pg_proc', () => {
  const scopeSource = sourceOf('rpcIdempotencyScope.test.ts');

  it.each([
    ['HELPER_SCOPED', 70],
    ['INLINE_SCOPED', 10],
    // UNSCOPED_LOOKUP_GAP minimum is 0 since 20260611080937
    // (idempotency_lookup_operation_scope_sweep) closed the entire gap list —
    // an empty bucket is the intended permanent end state. Vacuous extraction
    // is still caught: extractArray throws if the const itself is missing.
    ['UNSCOPED_LOOKUP_GAP', 0],
  ] as const)('every %s entry exists in live pg_proc', (constName, minLen) => {
    const fixture = extractArray(scopeSource, constName, 'rpcIdempotencyScope.test.ts');
    expect(fixture.length).toBeGreaterThanOrEqual(minLen); // vacuous-pass guard
    const ghosts = fixture.filter((rpc) => !LIVE_FUNCTIONS.has(rpc));
    expect(ghosts).toEqual([]);
  });

  it('every ALIAS_SCOPED function exists in live pg_proc', () => {
    const keys = extractObjectKeys(scopeSource, 'ALIAS_SCOPED', 'rpcIdempotencyScope.test.ts');
    expect(keys.length).toBeGreaterThanOrEqual(1);
    const ghosts = keys.filter((rpc) => !LIVE_FUNCTIONS.has(rpc));
    expect(ghosts).toEqual([]);
  });
});
