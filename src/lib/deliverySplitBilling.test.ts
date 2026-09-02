import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
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
  // Codex review on PR #549 (P2): pinning to the immutable July migration made
  // this test unfalsifiable. `create_invoice_for_unbilled_delivery` has been
  // re-emitted at least twice since (20260817120000, 20260827041200), and an
  // applied migration can never be edited — so a FORWARD migration could change
  // the real guard while a test reading the old file stayed green, letting the
  // client predicate drift and the dead-end button come back.
  //
  // Track the NEWEST emitter instead: any future re-emission automatically
  // becomes the file under test.
  const MIGRATIONS_DIR = join(process.cwd(), 'supabase/migrations');

  const emitters = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8').includes('ORDER_NEEDS_SPLIT_BILLING'))
    .sort(); // migration filenames are timestamp-prefixed, so last === newest

  it('at least one migration still emits the guard', () => {
    // A zero-length list would make every assertion below vacuously pass.
    expect(emitters.length).toBeGreaterThan(0);
  });

  it('the NEWEST emitter still ORs the orders flag with an allocation EXISTS', () => {
    // If this fails, the SERVER rule moved and orderRequiresSplitBilling is stale.
    const newest = emitters[emitters.length - 1];
    const sql = readFileSync(join(MIGRATIONS_DIR, newest), 'utf8');
    const guardIndex = sql.indexOf('ORDER_NEEDS_SPLIT_BILLING');
    const guardBlock = sql.slice(Math.max(0, guardIndex - 1200), guardIndex);

    expect(guardBlock, `newest emitter: ${newest}`).toMatch(/COALESCE\(needs_split_billing,\s*false\)/);
    expect(guardBlock, `newest emitter: ${newest}`).toMatch(/OR EXISTS/);
    expect(guardBlock, `newest emitter: ${newest}`).toMatch(/FROM order_item_field_allocations/);
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
