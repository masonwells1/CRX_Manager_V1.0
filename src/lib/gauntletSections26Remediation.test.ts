import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migration = (name: string) =>
  readFileSync(join(root, 'supabase', 'migrations', name), 'utf8').replace(/\r\n/g, '\n');
const source = (...parts: string[]) =>
  readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n');

describe('gauntlet sections 2-6 CodeRabbit closeout', () => {
  it('claims and fingerprints revert_quote_status before any quote mutation', () => {
    const sql = migration('20260719013000_bind_revert_quote_status_idempotency.sql');
    expect(sql).toContain("v_contract CONSTANT text := 'revert_quote_status_v1'");
    expect(sql).toContain(
      "hashtextextended('crx:idempotency:revert_quote_status:' || p_idempotency_key, 0)",
    );
    expect(sql).toContain("hashtextextended('crx:idempotency:' || p_idempotency_key, 0)");
    expect(sql).toContain("'quote_id', p_quote_id");
    expect(sql).toContain("'actor_id', v_actor");
    expect(sql).toContain("'reason', v_reason");
    expect(sql).toContain('IDEMPOTENCY_REQUEST_MISMATCH');
    expect(sql).toContain("RETURN v_existing->'response'");
    expect(sql.indexOf('INSERT INTO idempotency_keys')).toBeLessThan(
      sql.indexOf('SELECT * INTO v_quote'),
    );
    expect(sql.indexOf('SELECT * INTO v_quote')).toBeLessThan(
      sql.indexOf('UPDATE quotes SET'),
    );
    expect(sql).toContain("'response', v_result");
  });

  it('locks order items deterministically before checking durable split allocations', () => {
    const sql = migration('20260719040000_lock_backfill_split_allocation_rows.sql');
    const applyBarrier = sql.indexOf(
      'LOCK TABLE\n  public.orders,\n  public.order_items,\n  public.order_item_field_allocations,\n  public.invoices,\n  public.financial_audit_log\nIN SHARE ROW EXCLUSIVE MODE',
    );
    expect(applyBarrier).toBeGreaterThan(-1);
    expect(applyBarrier).toBeLessThan(
      sql.indexOf('CREATE OR REPLACE FUNCTION public.create_invoice_for_unbilled_delivery'),
    );
    expect(applyBarrier).toBeLessThan(sql.indexOf('DO $preflight$'));
    expect(applyBarrier).toBeLessThan(sql.indexOf('REVOKE INSERT, UPDATE, DELETE, TRUNCATE'));
    expect(applyBarrier).toBeLessThan(
      sql.indexOf('CREATE TRIGGER guard_mono_invoice_split_billing_post'),
    );
    const itemLock = sql.indexOf(
      'FROM order_items\n   WHERE order_id = v_delivery.order_id\n   ORDER BY id\n   FOR UPDATE',
    );
    const allocationCheck = sql.indexOf('SELECT 1 FROM order_item_field_allocations');
    expect(itemLock).toBeGreaterThan(-1);
    expect(allocationCheck).toBeGreaterThan(itemLock);
    expect(sql).toContain('ORDER_NEEDS_SPLIT_BILLING');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.prevent_oifa_edit_after_post()');
    const writerItemLock = sql.indexOf(
      'FROM order_items oi\n   WHERE oi.id = ANY (\n     array_remove(ARRAY[v_old_item_id, v_new_item_id]::uuid[], NULL)\n   )\n   ORDER BY oi.id\n   FOR KEY SHARE',
    );
    const writerInvoiceCheck = sql.indexOf('SELECT i.invoice_number');
    expect(writerItemLock).toBeGreaterThan(-1);
    expect(writerInvoiceCheck).toBeGreaterThan(writerItemLock);
    expect(sql).toContain("i.status NOT IN ('voided', 'cancelled')");
    expect(sql).toContain('ORDER_ALLOCATION_INVOICE_CONFLICT');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.guard_mono_invoice_split_billing_post()');
    const postGuard = sql.indexOf('CREATE OR REPLACE FUNCTION public.guard_mono_invoice_split_billing_post()');
    const postItemLock = sql.indexOf(
      'FROM order_items oi\n   WHERE oi.order_id = v_order_id\n   ORDER BY oi.id\n   FOR UPDATE',
      postGuard,
    );
    const postAllocationCheck = sql.indexOf('FROM order_item_field_allocations oifa', postGuard);
    expect(postItemLock).toBeGreaterThan(postGuard);
    expect(postAllocationCheck).toBeGreaterThan(postItemLock);
    expect(sql).toContain('NEW.order_id IS DISTINCT FROM OLD.order_id');
    expect(sql).toContain('NEW.invoice_group_id IS DISTINCT FROM OLD.invoice_group_id');
    expect(sql).toContain('INVOICE_ORDER_IMMUTABLE');
    expect(sql).toContain('MONO_INVOICE_SPLIT_BILLING_CONFLICT');
    expect(sql).toContain('SPLIT_INVOICE_GROUP_PROVENANCE_REQUIRED');
    expect(sql).toContain("fal.new_values->>'split_basis' = 'field_acre'");
    expect(sql).toContain("member_audit.new_values->>'group_id' = NEW.invoice_group_id::text");
    expect(sql).toContain('SPLIT_PROVENANCE_PREFLIGHT_FAILED');
    expect(sql).toContain(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE\n  ON TABLE public.financial_audit_log',
    );
    expect(sql).toContain("has_table_privilege(\n       role_name.name");
    expect(sql).toContain('CREATE TRIGGER guard_mono_invoice_split_billing_post');
  });

  it('binds canonical split invoices to private exact provenance under shared locks', () => {
    const sql = migration('20260719100000_trust_only_post_revoke_split_provenance.sql');
    const barrier = sql.indexOf(
      'LOCK TABLE\n  public.orders,\n  public.order_items,\n  public.order_item_field_allocations,\n  public.invoices,\n  public.invoice_items,\n  public.financial_audit_log\nIN SHARE ROW EXCLUSIVE MODE',
    );
    const historicalScan = sql.indexOf("fal.new_values->>'split_basis' = 'field_acre'");
    const privateTable = sql.indexOf('CREATE TABLE public.split_invoice_provenance (');
    const itemLock = sql.indexOf('ORDER BY oi.id\n   FOR UPDATE');
    const claimInsert = sql.indexOf('INSERT INTO public.split_invoice_creation_claims');
    const provenanceInsert = sql.indexOf('INSERT INTO public.split_invoice_provenance');
    const guard = sql.indexOf('CREATE OR REPLACE FUNCTION public.guard_mono_invoice_split_billing_post()');
    expect(barrier).toBeGreaterThan(-1);
    expect(historicalScan).toBeGreaterThan(barrier);
    expect(privateTable).toBeGreaterThan(historicalScan);
    expect(itemLock).toBeGreaterThan(privateTable);
    expect(claimInsert).toBeGreaterThan(itemLock);
    expect(provenanceInsert).toBeGreaterThan(claimInsert);
    expect(guard).toBeGreaterThan(provenanceInsert);
    expect(sql).toContain('SPLIT_PROVENANCE_RECONCILIATION_REQUIRED');
    expect(sql).toContain('ALTER TABLE public.split_invoice_provenance ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain(
      'public.split_invoice_creation_claims,\n  public.split_invoice_provenance,\n  public.split_invoice_mutation_claims\nFROM PUBLIC, anon, authenticated, service_role',
    );
    expect(sql).toContain('SPLIT_INVOICE_CREATION_CLAIM_REQUIRED');
    expect(sql).toContain('SPLIT_INVOICE_PROVENANCE_IMMUTABLE');
    expect(sql).toContain('p.content_claim = public._split_invoice_content_claim(NEW.id)');
    expect(sql).toContain('REVOKE INSERT, DELETE, TRUNCATE ON TABLE public.invoices');
    expect(sql).toContain('RENAME TO _save_invoice_split_provenance_impl_20260719');
    expect(sql).toContain('RENAME TO _delete_invoices_split_provenance_impl_20260719');
    expect(sql).not.toContain('cutover_at');
    expect(sql).not.toContain('fal.created_at >=');
  });

  it('makes quote/order lock contention retryable instead of deadlocking', () => {
    const sql = migration('20260719100500_revert_quote_status_deadlock_retry.sql');
    expect(sql).toContain('FOR UPDATE NOWAIT');
    expect(sql).toContain('EXCEPTION WHEN lock_not_available');
    expect(sql).toContain('QUOTE_REOPEN_CONCURRENT_ORDER_CHANGE_RETRY');
    expect(sql).toContain("USING ERRCODE = '40001'");
    expect(sql).toContain("v_contract CONSTANT text := 'revert_quote_status_v1'");
    expect(sql).toContain('request_fingerprint');
    expect(sql).toContain('QUOTE_REOPEN_HAS_ORDER_HISTORY');
  });

  it('keeps finance-charge preview aligned with calendar-month generation dedup', () => {
    const sql = migration('20260719101000_align_finance_charge_preview_month_dedup.sql');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.preview_finance_charges');
    expect(sql).toContain('FROM public.finance_charges fc');
    expect(sql).toContain('fc.customer_id = c.id');
    expect(sql).toContain(
      "date_trunc('month', fc.period_end) = date_trunc('month', p_as_of_date)",
    );
    expect(sql).toContain('PERFORM public.check_period_open(p_as_of_date)');
    expect(sql).toContain('SET search_path = public, pg_temp');
    expect(sql).toContain(
      'REVOKE EXECUTE ON FUNCTION public.preview_finance_charges(date) FROM PUBLIC, anon',
    );
  });

  it('keeps governed split lifecycle RPCs usable and binds every affected replay request', () => {
    const sql = migration('20260719102000_allow_governed_split_terminal_lifecycle.sql');
    const barrier = sql.indexOf('LOCK TABLE');
    expect(barrier).toBeGreaterThan(-1);
    expect(sql.indexOf('public.idempotency_keys')).toBeGreaterThan(barrier);
    expect(sql.indexOf('DO $preflight$')).toBeGreaterThan(sql.indexOf('public.idempotency_keys'));
    expect(sql).toContain('IDEMPOTENCY_RECONCILIATION_REQUIRED');
    expect(sql).toContain('CREATE FUNCTION public._claim_bound_lifecycle_idempotency');
    expect(sql).toContain('IDEMPOTENCY_REQUEST_MISMATCH');
    expect(sql).toContain("'create_split_invoices_from_order_v1'");
    expect(sql).toContain("'delete_invoices_v1'");
    expect(sql).toContain("'void_invoice_v1'");
    expect(sql).toContain("'cancel_order_v1'");
    expect(sql).toContain('SPLIT_INVOICE_IDEMPOTENCY_RESPONSE_MISMATCH');
    expect(sql).toContain("claim.operation = 'void_invoice'");
    expect(sql).toContain("claim.operation = 'cancel_order'");
    expect(sql).toContain("OLD.status IN ('posted', 'paid', 'overdue')");
    expect(sql).toContain("OLD.status IN ('draft', 'unposted')");
    expect(sql).toContain('SPLIT_INVOICE_TERMINAL_PROVENANCE_REFRESH_FAILED');
    expect(sql).toContain('RENAME TO _void_invoice_split_provenance_impl_20260719');
    expect(sql).toContain('RENAME TO _cancel_order_split_provenance_impl_20260719');
    expect(sql).toContain('FROM PUBLIC, anon, authenticated, service_role');
  });

  it('cuts quote commission validation over atomically and reconciles only the proven row', () => {
    const sql = migration('20260719064000_validate_quote_commission_splits.sql');
    const barrier = sql.indexOf('LOCK TABLE public.quotes IN SHARE ROW EXCLUSIVE MODE');
    const preflight = sql.indexOf('DO $preflight$');
    const repair = sql.indexOf('WITH repaired AS');
    const trigger = sql.indexOf('CREATE TRIGGER trg_validate_quote_commission_split');
    expect(barrier).toBeGreaterThan(-1);
    expect(preflight).toBeGreaterThan(barrier);
    expect(repair).toBeGreaterThan(preflight);
    expect(trigger).toBeGreaterThan(repair);
    expect(sql).toContain("'bcdca194-568a-454b-80da-de726820b27b'::uuid");
    expect(sql).toContain("'{\"splits\":[]}'::jsonb");
    expect(sql).toContain('QUOTE_COMMISSION_RECONCILIATION_REQUIRED');
    expect(sql).toContain('PERFORM public.validate_commission_split_json(NEW.commission_split)');
    expect(sql).toContain('FROM PUBLIC, anon, authenticated, service_role');
  });

  it('routes all invoice updates through governed owner-context RPCs', () => {
    const sql = migration('20260719093000_route_invoice_updates_through_governed_rpcs.sql');
    const barrier = sql.indexOf('LOCK TABLE public.invoices IN SHARE ROW EXCLUSIVE MODE');
    const revoke = sql.indexOf('REVOKE UPDATE ON TABLE public.invoices');
    expect(barrier).toBeGreaterThan(-1);
    expect(revoke).toBeGreaterThan(barrier);
    expect(sql).toContain('FROM PUBLIC, anon, authenticated, service_role');
    expect(sql).toContain("has_table_privilege(role_name, 'public.invoices', 'UPDATE')");
    expect(sql).toContain("'public.save_invoice(jsonb,jsonb,text)'");
    expect(sql).toContain("ARRAY['search_path=public, pg_temp']");
  });

  it('rejects missing and null commission percentages explicitly', () => {
    const sql = migration('20260719093500_reject_null_commission_percentages.sql');
    const barrier = sql.indexOf('LOCK TABLE public.quotes IN SHARE ROW EXCLUSIVE MODE');
    const preflight = sql.indexOf('DO $preflight$');
    const replacement = sql.indexOf(
      'CREATE OR REPLACE FUNCTION public.validate_commission_split_json',
    );
    expect(barrier).toBeGreaterThan(-1);
    expect(preflight).toBeGreaterThan(barrier);
    expect(replacement).toBeGreaterThan(preflight);
    expect(sql).toContain('COMMISSION_PERCENTAGE_RECONCILIATION_REQUIRED');
    expect(sql).toContain(
      'IF v_percentage IS NULL OR v_percentage <= 0 OR v_percentage > 100 THEN',
    );
    expect(sql).toContain('COMMISSION_NULL_PERCENTAGE_POSTFLIGHT_FAILED');
  });

  it('keeps governed split edits immutable and grouped voids atomic', () => {
    const sql = migration('20260720175946_protect_governed_split_edit_and_void_group.sql');
    expect(sql).toContain('SPLIT_INVOICE_EDIT_REQUIRES_REISSUE');
    expect(sql).toContain('SPLIT_INVOICE_GROUP_VOID_REQUIRED');
    expect(sql).toContain('CREATE FUNCTION public.void_invoice_group');
    expect(sql).toContain("v_contract CONSTANT text := 'void_invoice_group_v1'");
    expect(sql).toContain('INVOICE_GROUP_PROVENANCE_REQUIRED');
  });

  it('scopes delivery signatures to canonical delivery paths and permitted actors', () => {
    const sql = migration('20260720200329_scope_delivery_signature_storage_access.sql');
    expect(sql).toContain('CREATE POLICY "delivery_signatures_scoped_select"');
    expect(sql).toContain('CREATE POLICY "delivery_signatures_scoped_insert"');
    expect(sql).toContain('CREATE POLICY "delivery_signatures_scoped_update"');
    expect(sql).toContain("d.assigned_driver = (SELECT auth.uid())");
    expect(sql).toContain("bucket_id = 'delivery-signatures'");

    const completionSql = migration('20260716191000_aggregate_delivery_stock_preflight.sql');
    expect(completionSql).toContain("v_actor_role IN ('admin', 'sales_rep')");
    expect(completionSql).toContain(
      "v_actor_role = 'driver' AND v_actor = v_delivery.assigned_driver",
    );

    const deleteSql = migration('20260720211454_scope_delivery_signature_delete.sql');
    expect(deleteSql).toContain('DROP POLICY IF EXISTS "delivery_signatures_delete"');
    expect(deleteSql).toContain('CREATE POLICY "delivery_signatures_scoped_delete"');
    expect(deleteSql).toContain("name = 'signatures/' || d.id::text || '.png'");
    expect(deleteSql).toContain('public.is_admin()');
    expect(deleteSql).toContain('public.is_sales_rep()');
  });

  it('keeps payment-rejection E2E assertions on the thrown RPC error path', () => {
    for (const path of [
      ['tests', 'e2e', 'concurrent-operations.spec.ts'],
      ['tests', 'e2e', 'period-close-accounting.spec.ts'],
    ]) {
      const spec = source(...path);
      expect(spec).toContain("rejection = error instanceof Error ? error.message : String(error)");
      expect(spec).toContain("expect(rejection.toLowerCase()).toContain('eligible')");
    }
  });
});
