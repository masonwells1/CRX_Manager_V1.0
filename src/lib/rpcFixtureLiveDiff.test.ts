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
// Checked-in live snapshot — generated 2026-06-10 (last edited 2026-06-25), 265 public functions
// (includes trigger/helper functions; supersets the 219 user-facing RPCs).
// Kept as the raw comma-joined DB output to make regeneration a single paste.
// -------------------------------------------------------------------------

const LIVE_PG_PROC_NAMES_CSV =
  '_check_credit_limit,_enforce_applicator_license,_enforce_delivery_items_parent_lock,_enforce_delivery_status_transition,_enforce_invoice_status_transition,_enforce_job_status_transition,_enforce_order_status_transition,_enforce_po_status_transition,_enforce_quote_status_transition,_enforce_return_status_transition,_fill_audit_actor,_guard_delivery_delete,_guard_inventory_transactions_immutable,_guard_invoice_delete,_guard_order_delete,_guard_po_delete,_guard_prepay_applications_immutable,_guard_profile_role_lock,_insert_commissions_for_order,_is_admin_override,_prebook_quick_delivery_inventory,_receiving_records_before_delete,_recompute_prepay_credit_balance,_require_auth,_snapshot_order_item_cost,adjust_inventory,admin_update_profile,allocate_payment,apply_prepay_to_invoice,apply_remaining_prepayments,apply_write_off,approve_return,assign_job_applicator,auto_expire_quotes,batch_apply_all_prepayments,batch_apply_prepayments,batch_approve_blend_tickets,batch_cancel_deliveries,batch_post_invoices,batch_reject_blend_tickets,batch_reschedule_deliveries,batch_void_invoices,bulk_import_order,calculate_billing_splits,calculate_prices_from_margin,cancel_cycle_count,cancel_delivery,cancel_order,cancel_purchase_order,cancel_return,check_customer_credit_limit,check_duplicate_blend_ticket,check_duplicate_delivery,check_idempotency,check_period_open,check_rate_limit,check_remainder_reminders,cleanup_rate_limits,close_accounting_period,complete_cycle_count,complete_delivery,complete_job,compute_application_service_fee,compute_commission_amount,compute_season,confirm_delivery,convert_quote_to_order,convert_to_gl_lb,create_application_record_from_blend_ticket,create_commission_payment,create_delivery_with_items,create_direct_order,create_followup_delivery,create_inventory_hold,create_invoice_for_unbilled_delivery,create_invoice_from_blend_ticket,create_invoice_from_order,create_job_from_quote_section,create_order_from_blend_ticket,create_planned_holds,create_prepay_check_splits,create_quick_delivery,create_quote_from_template,create_quote_version,create_rebate_claim,create_split_invoices_from_order,create_vendor_bill,current_season,dashboard_summary,delete_invoices,delete_prepay_credit,delete_purchase_order,delete_vendor,derive_customer_shares_from_fields,draw_down_quote,duplicate_quote,edit_delivery,edit_prepay_credit,enforce_invoice_draft_on_insert,enforce_quote_accepted_fully_drawn,execute_sql_readonly,financial_dashboard_summary,generate_batch_statements,generate_finance_charges,generate_order_number,generate_quote_number,generate_rup_sales_records,generate_ticket_number,get_ap_aging,get_ap_dashboard_summary,get_ar_aging,get_ar_reminder_candidates,get_batch_year_end_summaries,get_bottom_line_pnl,get_chemical_history,get_commission_balance_report,get_customer_balance_listing,get_customer_delivery_remainders,get_customer_farm_group,get_customer_statement,get_customer_summary,get_customer_transaction_review,get_customer_year_end_summary,get_dashboard_action_items,get_detailed_statement_data,get_expiring_planned_holds,get_field_billing_splits_for_blend_ticket,get_field_billing_splits_for_order,get_field_dashboard,get_field_geojson,get_field_polygons,get_fields_with_geojson,get_gross_sales_report,get_inventory_cost_report,get_inventory_forecast,get_inventory_position,get_jobs_billed_customers,get_logbook_by_applicator,get_logbook_by_customer,get_logbook_by_field,get_logbook_faa,get_monthly_summary,get_notes_for_entity,get_program_completion,get_receiving_log,get_receiving_summary,get_rup_sales_register,get_sales_detail_report,get_sales_summary_report,get_season_comparison,get_team_board_deliveries,get_team_workload,get_yesterday_delivery_recap,global_search,guard_audit_log_immutable,guard_completed_delivery_signature,handle_new_user,increment_customer_prepay,is_admin,is_applicator,is_driver,is_sales_rep,issue_return_credit,link_blend_ticket_to_order,link_fields_to_parent,load_recipe_into_job,log_comment_activity,log_failed_notification,log_note_activity,manual_inventory_add,mark_inventory_row_verified,mark_overdue_invoices,match_quick_receive_items,next_application_record_number,next_commission_payment_number,next_cycle_count_number,next_delivery_number,next_invoice_number,next_job_number,next_po_number,next_return_number,notify_damaged_receiving,notify_mentioned_users_in_comment,operational_dashboard_summary,post_commission_payment,post_invoice,post_invoice_group,prevent_order_shares_edit_after_post,preview_field_app_invoice_split,preview_finance_charges,reassign_delivery,receive_po_items,receive_return,reconcile_negative_inventory,reconcile_prepay_balances,record_invoice_payment,record_vendor_payment,release_expired_quote_holds,release_holds_on_quote_status_change,release_inventory_hold,reopen_accounting_period,require_admin,require_admin_or_sales_rep,restore_cancelled_delivery,restore_cancelled_order,restore_quote_version,retire_inventory_item,retry_failed_notifications,reverse_blend_ticket_approval,reverse_completed_cycle_count,reverse_receiving_record,reverse_write_off,revert_quote_status,rollover_quote_to_season,safe_cents_qty,save_blend_recipe,save_blend_ticket,save_blend_ticket_fields,save_customer,save_field,save_field_app_invoice,save_field_geometry,save_field_polygons,save_idempotency,save_invoice,save_job,save_purchase_order,save_quote,save_quote_template,save_vendor,season_end_date,season_start_date,snapshot_field_crop_history,start_job,sync_blend_ticket_payment_status,transfer_invoice_to_job,transfer_job_to_invoice,transition_rebate_claim,trg_delivery_status_change,trg_inventory_significant_change,trg_order_status_change,trg_po_status_change,trg_po_submitted_update_on_order,trg_recalc_order_totals,unapply_credit_memo,unlink_blend_ticket_from_order,unlink_field_from_parent,unpost_invoice_group,update_blend_ticket_billing_status,update_blend_ticket_updated_at,update_cycle_count_item,update_fields_updated_at,update_note_comment_timestamp,update_order_items,update_updated_at,update_vendor_bill,validate_commission_split_json,validate_product_units,vendor_bills_positive_subtotal_trigger,void_commission_payment,void_delivery,void_invoice,void_order,void_payment,void_vendor_bill,void_vendor_payment';

const LIVE_PG_PROC_COUNT = 266; // count(DISTINCT proname); 267→266 on 2026-07-03 (Structure Wave-2 P2-2, PARKED: drops create_prepay_credit); 265→267 on 2026-06-29 (Wave 2a remediation: added get_jobs_billed_customers (FIX 2, mig 20260629160000) + unpost_invoice_group (FIX 4, mig 20260629170000)); 264→265 on 2026-06-25 (added transfer_invoice_to_job, #27 reverse leg, mig 20260625120000); 265→264 on 2026-06-21 (dropped update_allocation_set); 266→265 on 2026-06-17 (dropped create_invoice_from_delivery)

const LIVE_FUNCTIONS = new Set(LIVE_PG_PROC_NAMES_CSV.split(','));

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
    const ghosts = fixture.filter((rpc) => !LIVE_FUNCTIONS.has(rpc));
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
