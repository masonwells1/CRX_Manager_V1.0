import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migration = (name: string) =>
  readFileSync(join(root, 'supabase', 'migrations', name), 'utf8').replace(/\r\n/g, '\n');

describe('gauntlet sections 2-6 CodeRabbit closeout', () => {
  it('claims and fingerprints revert_quote_status before any quote mutation', () => {
    const sql = migration('20260719023344_bind_revert_quote_status_idempotency.sql');
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
    const sql = migration('20260719024641_lock_backfill_split_allocation_rows.sql');
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
});
