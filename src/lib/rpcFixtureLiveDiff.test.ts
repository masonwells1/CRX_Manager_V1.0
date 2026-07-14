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
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// -------------------------------------------------------------------------
// Checked-in live snapshot — fully regenerated 2026-07-11, 364 public functions
// (includes trigger/helper functions; supersets the 219 user-facing RPCs).
// Kept as the raw comma-joined DB output to make regeneration a single paste.
// -------------------------------------------------------------------------

const LIVE_PG_PROC_NAMES_CSV =
  '__plpgsql_show_dependency_tb,_check_credit_limit,_close_job_location_dispatch_on_job_terminal,_enforce_allocation_not_over_payment,_enforce_applicator_license,_enforce_billed_job_applied_record_immutability,_enforce_billed_job_immutability,_enforce_delivery_items_parent_lock,_enforce_delivery_status_transition,_enforce_invoice_status_transition,_enforce_job_status_transition,_enforce_order_status_transition,_enforce_po_status_transition,_enforce_quote_status_transition,_enforce_quote_terminal_not_drawn,_enforce_return_status_transition,_fill_audit_actor,_guard_credit_memo_application_immutable,_guard_delivery_delete,_guard_inventory_transactions_immutable,_guard_invoice_delete,_guard_order_delete,_guard_po_delete,_guard_prepay_applications_immutable,_guard_profile_role_lock,_insert_commissions_for_job,_insert_commissions_for_order,_is_admin_override,_is_dispatched_to_me,_prebook_quick_delivery_inventory,_preserve_job_location_dispatch_on_field_delete,_receiving_records_before_delete,_recompute_prepay_credit_balance,_require_auth,_reverse_credit_memo_application,_snapshot_order_item_cost,_sync_job_holds,_sync_job_location_dispatch_on_applicator_change,_sync_job_location_dispatch_on_field_insert,_sync_planned_holds,_sync_quote_job_reservations,_trg_release_job_holds_on_lifecycle,_trg_sync_job_holds,_validate_order_shares_total,adjust_inventory,admin_update_profile,allocate_payment,apply_credit_memo_to_invoice,apply_prepay_to_invoice,apply_remaining_prepayments,apply_write_off,approve_return,assign_job_applicator,auto_expire_quotes,batch_apply_all_prepayments,batch_apply_prepayments,batch_approve_blend_tickets,batch_cancel_deliveries,batch_post_invoices,batch_reject_blend_tickets,batch_reschedule_deliveries,batch_void_invoices,bulk_create_label_drafts,bulk_import_order,calculate_billing_splits,calculate_prices_from_margin,cancel_cycle_count,cancel_delivery,cancel_order,cancel_purchase_order,cancel_return,check_customer_credit_limit,check_duplicate_blend_ticket,check_duplicate_delivery,check_idempotency,check_period_open,check_rate_limit,check_remainder_reminders,check_unpriced_orders,cleanup_rate_limits,close_accounting_period,close_quote_as_applied,close_quote_as_short,commit_label_draft,complete_cycle_count,complete_delivery,complete_job,compute_application_service_fee,compute_commission_amount,compute_fuel_surcharge_cents,compute_season,confirm_delivery,confirm_job_notification_sent,consolidate_draft_invoices,convert_quote_to_order,convert_to_gl_lb,create_application_record_from_blend_ticket,create_commission_payment,create_delivery_with_items,create_direct_order,create_followup_delivery,create_inventory_hold,create_invoice_for_unbilled_delivery,create_invoice_from_blend_ticket,create_invoice_from_order,create_job_from_quote_section,create_label_draft,create_order_from_blend_ticket,create_planned_holds,create_prepay_check_splits,create_quick_delivery,create_quote_from_template,create_quote_version,create_rebate_claim,create_return,create_rush_order,create_split_invoices_from_order,create_vendor_bill,current_season,dashboard_summary,delete_invoices,delete_prepay_credit,delete_purchase_order,delete_vendor,derive_customer_shares_from_fields,dismiss_watchdog_flag,dispatch_job_locations,draw_down_quote,duplicate_quote,edit_delivery,edit_prepay_credit,enforce_blend_ticket_fields_billed_lock,enforce_blend_ticket_products_billed_lock,enforce_field_application_type_lock,enforce_invoice_draft_on_insert,enforce_quote_accepted_fully_drawn,execute_sql_readonly,field_app_priced_quantity,fields_acre_authority_guard,financial_dashboard_summary,find_overlapping_fields,generate_batch_statements,generate_finance_charges,generate_order_number,generate_quote_number,generate_rup_sales_records,generate_ticket_number,get_ap_aging,get_ap_dashboard_summary,get_ar_aging,get_ar_reminder_candidates,get_batch_year_end_summaries,get_booking_settlement,get_bottom_line_pnl,get_chemical_history,get_commission_balance_report,get_customer_balance_listing,get_customer_delivery_remainders,get_customer_farm_group,get_customer_statement,get_customer_summary,get_customer_transaction_review,get_customer_year_end_summary,get_dashboard_action_items,get_detailed_statement_data,get_dispatch_board_jobs,get_dispatch_stock_status,get_dispatched_list,get_expiring_planned_holds,get_field_billing_splits_for_blend_ticket,get_field_billing_splits_for_order,get_field_dashboard,get_field_geojson,get_field_polygons,get_fields_geojson_by_ids,get_fields_with_geojson,get_gross_sales_report,get_inventory_cost_report,get_inventory_forecast,get_inventory_position,get_job_billed_customers,get_job_fields_with_geojson,get_job_inventory_shortfalls,get_job_proof_data,get_jobs_billed_customers,get_label_coverage_report,get_logbook_by_applicator,get_logbook_by_customer,get_logbook_by_field,get_logbook_faa,get_lot_application_trace,get_monthly_summary,get_notes_for_entity,get_open_booking_rollover,get_program_completion,get_receiving_log,get_receiving_summary,get_recent_lots_for_product,get_rup_sales_register,get_sales_detail_report,get_sales_summary_report,get_season_comparison,get_team_board_deliveries,get_team_workload,get_watchdog_flags,get_yesterday_delivery_recap,global_search,guard_audit_log_immutable,guard_completed_delivery_signature,handle_new_user,increment_customer_prepay,is_admin,is_applicator,is_driver,is_sales_rep,issue_return_credit,jobs_snapshot_commission_split,link_blend_ticket_to_order,link_fields_to_parent,load_recipe_into_job,log_comment_activity,log_failed_notification,log_note_activity,manual_inventory_add,mark_inventory_row_verified,mark_overdue_invoices,match_quick_receive_items,next_application_record_number,next_commission_payment_number,next_cycle_count_number,next_delivery_number,next_invoice_number,next_job_number,next_po_number,next_return_number,normalize_product_category,normalize_rate_unit,notify_damaged_receiving,notify_mentioned_users_in_comment,operational_dashboard_summary,parse_payment_terms_days,plpgsql_check_function,plpgsql_check_function_tb,plpgsql_check_pragma,plpgsql_check_profiler,plpgsql_check_tracer,plpgsql_coverage_branches,plpgsql_coverage_statements,plpgsql_profiler_function_statements_tb,plpgsql_profiler_function_tb,plpgsql_profiler_functions_all,plpgsql_profiler_install_fake_queryid_hook,plpgsql_profiler_remove_fake_queryid_hook,plpgsql_profiler_reset,plpgsql_profiler_reset_all,plpgsql_show_dependency_tb,post_commission_payment,post_invoice,post_invoice_group,prevent_oifa_edit_after_post,prevent_order_shares_edit_after_post,preview_field_app_invoice_split,preview_finance_charges,price_order,product_price_per_acre,reassign_delivery,recalc_product_price_per_acre,receive_po_items,receive_return,recompute_job_applied_acres,reconcile_negative_inventory,reconcile_prepay_balances,record_invoice_payment,record_job_post_notifications,record_job_pre_notifications,record_vendor_payment,refresh_watchdog_flags,reject_return,release_expired_quote_holds,release_holds_on_quote_status_change,release_inventory_hold,reopen_accounting_period,require_admin,require_admin_or_sales_rep,reserve_job_inventory,restore_cancelled_delivery,restore_cancelled_order,restore_quote_version,retire_inventory_item,retry_failed_notifications,reverse_blend_ticket_approval,reverse_completed_cycle_count,reverse_credit_memo_application,reverse_receiving_record,reverse_write_off,revert_quote_status,rollover_quote_to_season,run_data_integrity_sweep,run_morning_notification_checks,safe_cents_qty,save_blend_recipe,save_blend_ticket,save_blend_ticket_fields,save_customer,save_field,save_field_app_invoice,save_field_crop_history,save_field_geometry,save_field_polygons,save_idempotency,save_invoice,save_job,save_job_applied_record,save_purchase_order,save_quote,save_quote_template,save_vendor,season_end_date,season_start_date,set_application_record_lots,set_field_boundary,set_field_override_acres,settle_applied_record_acres,snapshot_field_crop_history,start_job,sync_blend_ticket_payment_status,transfer_invoice_to_job,transfer_job_to_invoice,transition_rebate_claim,trg_delivery_status_change,trg_inventory_significant_change,trg_jarf_recompute,trg_job_applied_record_recompute,trg_order_status_change,trg_po_status_change,trg_po_submitted_update_on_order,trg_product_label_drafts_updated_at,trg_recalc_order_totals,unapply_credit_memo,undispatch_job_locations,unlink_blend_ticket_from_order,unlink_field_from_parent,unpost_invoice,unpost_invoice_group,update_blend_ticket_billing_status,update_blend_ticket_updated_at,update_cycle_count_item,update_field_app_applied_info,update_field_app_invoice_billing,update_fields_updated_at,update_note_comment_timestamp,update_order_items,update_updated_at,update_vendor_bill,validate_commission_split_json,validate_product_units,vendor_bills_positive_subtotal_trigger,void_commission_payment,void_delivery,void_invoice,void_order,void_payment,void_vendor_bill,void_vendor_payment';

const LIVE_PG_PROC_COUNT = 364; // count(DISTINCT proname); FULL REGEN 2026-07-11 via the documented MCP query (the 269-name partial snapshot was ~95 behind live; closes the tracked full-regen follow-up). Includes plpgsql_check extension functions now present in public.

const LIVE_FUNCTIONS = new Set(LIVE_PG_PROC_NAMES_CSV.split(','));

// Functions introduced by a checked-in migration that is intentionally queued
// but not yet applied to production. Keep this exception narrow and tied to the
// exact migration source; remove it when the live snapshot is regenerated after
// the migration is applied.
const QUEUED_MIGRATION_FUNCTIONS = {
  '20260714024811_offline_action_receipts.sql': [
    'process_offline_action',
    'stage_offline_action',
  ],
  '20260714122626_offline_action_review_resolution.sql': [
    'get_offline_action_review_queue',
    'resolve_offline_action',
  ],
} as const;

const QUEUED_FUNCTIONS = new Set<string>(Object.values(QUEUED_MIGRATION_FUNCTIONS).flat());

// -------------------------------------------------------------------------
// Fixture-array extraction from sibling test files (source text, not import)
// -------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));

function sourceOf(file: string): string {
  return readFileSync(join(HERE, file), 'utf8');
}

/** Extract the string entries of `const NAME ... = [ ... ];` from source. */
function extractArray(source: string, constName: string, file: string): string[] {
  const m = source.match(new RegExp(`const ${constName}[^=]*=\\s*\\[([\\s\\S]*?)\\];`));
  if (!m) throw new Error(`Could not find const ${constName} in ${file}`);
  return [...m[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((x) => x[1]);
}

/** Extract the keys of `const NAME ... = { key: 'value', ... };` from source. */
function extractObjectKeys(source: string, constName: string, file: string): string[] {
  const m = source.match(new RegExp(`const ${constName}[^=]*=\\s*\\{([\\s\\S]*?)\\};`));
  if (!m) throw new Error(`Could not find const ${constName} in ${file}`);
  return [...m[1].matchAll(/^\s*([A-Za-z0-9_]+)\s*:/gm)].map((x) => x[1]);
}

// -------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------

describe('Live pg_proc snapshot integrity', () => {
  it('snapshot has the expected count, no duplicates, sorted', () => {
    const names = LIVE_PG_PROC_NAMES_CSV.split(',');
    expect(names.length).toBe(LIVE_PG_PROC_COUNT);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([...names].sort());
  });

  it('queued-function exceptions exist in their exact migration source', () => {
    const migrationsDir = join(HERE, '..', '..', 'supabase', 'migrations');
    for (const [migration, functions] of Object.entries(QUEUED_MIGRATION_FUNCTIONS)) {
      const source = readFileSync(join(migrationsDir, migration), 'utf8');
      for (const rpc of functions) {
        expect(source).toMatch(new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${rpc}\\s*\\(`, 'i'));
      }
    }
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
    expect(fixture.length).toBeGreaterThanOrEqual(1); // vacuous-pass guard
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
