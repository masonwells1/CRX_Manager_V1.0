import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { orderRequiresSplitBilling, SPLIT_BILLING_BLOCK_REASON } from './deliverySplitBilling';

/**
 * H5. Two admin surfaces used to offer a "Create invoice" button on deliveries
 * whose order the server refuses to single-invoice. These tests pin the shared
 * client predicate to the SHAPE of the server guard, and pin that both surfaces
 * consume the shared module rather than re-deriving the rule locally (which is
 * exactly how the two conditions drifted apart in the first place).
 */

describe('orderRequiresSplitBilling — mirrors ORDER_NEEDS_SPLIT_BILLING', () => {
  it('refuses when the order carries the needs_split_billing flag', () => {
    expect(orderRequiresSplitBilling({ needs_split_billing: true, has_field_allocations: false })).toBe(true);
  });

  it('refuses when the order has field/acre allocations, even with the flag cleared', () => {
    // The flag is a clearable queue marker; the allocation rows are what make a
    // mono-bill mis-attribute AR. The server ORs both, so this must not be false.
    expect(orderRequiresSplitBilling({ needs_split_billing: false, has_field_allocations: true })).toBe(true);
    expect(orderRequiresSplitBilling({ needs_split_billing: null, has_field_allocations: true })).toBe(true);
  });

  it('allows a plain order with neither signal', () => {
    expect(orderRequiresSplitBilling({ needs_split_billing: false, has_field_allocations: false })).toBe(false);
    expect(orderRequiresSplitBilling({})).toBe(false);
  });

  it('treats a NULL flag as false, matching COALESCE(needs_split_billing, false)', () => {
    expect(orderRequiresSplitBilling({ needs_split_billing: null })).toBe(false);
    expect(orderRequiresSplitBilling({ needs_split_billing: undefined })).toBe(false);
  });

  it('fails open on a missing signal rather than hiding a legitimate button', () => {
    expect(orderRequiresSplitBilling(null)).toBe(false);
    expect(orderRequiresSplitBilling(undefined)).toBe(false);
  });
});

describe('the client predicate still matches the shipped server guard', () => {
  const migration = readFileSync(
    join(
      process.cwd(),
      'supabase/migrations/20260719024641_lock_backfill_split_allocation_rows.sql',
    ),
    'utf8',
  );

  it('the guard is an OR of the orders flag and an allocation EXISTS', () => {
    // If this fails, the SERVER rule moved and the client mirror above is stale.
    const guardIndex = migration.indexOf('ORDER_NEEDS_SPLIT_BILLING');
    expect(guardIndex).toBeGreaterThan(-1);
    const guardBlock = migration.slice(Math.max(0, guardIndex - 1200), guardIndex);
    expect(guardBlock).toMatch(/COALESCE\(needs_split_billing,\s*false\)/);
    expect(guardBlock).toMatch(/OR EXISTS/);
    expect(guardBlock).toMatch(/FROM order_item_field_allocations/);
  });
});

describe('both surfaces consume the ONE shared predicate', () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

  const SURFACES = [
    'src/components/integrity/IntegrityCleanupPanel.tsx',
    'src/pages/DeliveryDetail.tsx',
  ];

  it.each(SURFACES)('%s imports the shared split-billing module', (file) => {
    expect(read(file)).toMatch(/from '(\.\.\/)+lib\/deliverySplitBilling'/);
  });

  it.each(SURFACES)('%s does not re-derive the rule from raw columns', (file) => {
    const src = read(file);
    // A surface that reads needs_split_billing or the allocations table directly
    // is building a second condition that can drift from the server guard.
    expect(src).not.toMatch(/\bneeds_split_billing\b/);
    expect(src).not.toMatch(/from\('order_item_field_allocations'\)/);
  });

  it.each(SURFACES)('%s explains the refusal with the shared sentence', (file) => {
    expect(read(file)).toContain('SPLIT_BILLING_BLOCK_REASON');
  });

  it('the shared sentence points the operator at the split-billing flow', () => {
    expect(SPLIT_BILLING_BLOCK_REASON).toMatch(/split invoices/i);
  });
});

describe('the integrity panel no longer discards server error text', () => {
  const panel = readFileSync(
    join(process.cwd(), 'src/components/integrity/IntegrityCleanupPanel.tsx'),
    'utf8',
  );

  it('has no `err instanceof Error ? err.message :` toast fallback left', () => {
    // A non-throwing supabase.rpc() resolves its error as a PLAIN OBJECT, so
    // `err instanceof Error` is false and the server sentence was replaced by a
    // literal like 'Backfill failed'. Every toast here must go through
    // sanitizeError(), which handles object-shaped Postgrest errors.
    expect(panel).not.toMatch(/toast\(\s*'error',\s*err instanceof Error/);
  });

  it('routes every catch toast through sanitizeError', () => {
    const catchToasts = panel.match(/toast\('error', sanitizeError\(err\)\)/g) || [];
    expect(catchToasts.length).toBeGreaterThanOrEqual(4);
  });
});
