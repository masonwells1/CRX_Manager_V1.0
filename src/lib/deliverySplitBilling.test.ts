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
  //
  // Codex round 2 (PR #550, P2): selecting on the GUARD TOKEN was still blind in
  // the one direction that matters most. A forward migration that re-emits the
  // function while REMOVING or renaming `ORDER_NEEDS_SPLIT_BILLING` would be
  // filtered out entirely, leaving an older file as the "newest emitter" and
  // passing every assertion against stale SQL — a silent green for exactly the
  // regression this is here to catch.
  //
  // Select on the FUNCTION instead, then assert the guard is present in it. The
  // substring match covers the public wrapper AND the versioned impl
  // (`_create_invoice_for_unbilled_delivery_impl_20260718`, which is where the
  // guard actually lives per live `pg_proc`), so renaming the impl in a future
  // migration cannot slip past the selector either.
  //
  // Deliberately biased toward FAILING: a migration that re-emits only the
  // wrapper would trip this even though the guard is untouched. That is the
  // right direction for a guard mirror — a loud false alarm gets a human to
  // look, whereas a silent pass ships the dead-end button back to admins.
  const MIGRATIONS_DIR = join(process.cwd(), 'supabase/migrations');

  // Codex round 3 (PR #550, P2): requiring `OR REPLACE` missed an ESTABLISHED
  // repo pattern — 20260721014858_20260721010000_govern_invoice_order_money_lifecycle.sql
  // and 20260721145936_require_money_lifecycle_idempotency_keys.sql both DROP and
  // recreate this function with a plain `CREATE FUNCTION`. A future migration doing
  // the same would be skipped, and the selector would validate stale SQL again.
  //
  // `OR REPLACE` is optional, the schema qualifier is optional, and the identifier
  // is anchored directly after FUNCTION (not `[^;]*`, which could stray across an
  // unrelated definition) with prefix/suffix wildcards so both the public wrapper
  // and any versioned impl — today `_create_invoice_for_unbilled_delivery_impl_20260718`,
  // tomorrow a renamed one — are matched. The trailing `(` keeps this to real
  // definitions rather than GRANT/COMMENT/DROP lines naming the same function.
  const FUNCTION_EMITTER =
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?[a-z0-9_]*create_invoice_for_unbilled_delivery[a-z0-9_]*\s*\(/i;

  const emitters = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => FUNCTION_EMITTER.test(readFileSync(join(MIGRATIONS_DIR, f), 'utf8')))
    .sort(); // migration filenames are timestamp-prefixed, so last === newest

  it('at least one migration still emits create_invoice_for_unbilled_delivery', () => {
    // A zero-length list would make every assertion below vacuously pass.
    expect(emitters.length).toBeGreaterThan(0);
  });

  it('picks up BOTH declaration forms, not just CREATE OR REPLACE', () => {
    // Regression guard for Codex round 3: these two migrations DROP and recreate
    // the function with a plain `CREATE FUNCTION`. If someone re-tightens the
    // selector to require `OR REPLACE`, these drop out of the emitter list and a
    // future plain re-creation could once again go unnoticed.
    expect(emitters).toContain('20260721014858_20260721010000_govern_invoice_order_money_lifecycle.sql');
    expect(emitters).toContain('20260721145936_require_money_lifecycle_idempotency_keys.sql');
  });

  /**
   * Split a migration into one segment per CREATE FUNCTION definition.
   *
   * Codex round 4 (PR #550, P2): asserting against the WHOLE file accepted guard
   * text from a definition nobody calls. Codex reproduced the shape — a guarded
   * legacy implementation followed by an unguarded replacement that the wrapper
   * actually invokes — and all 17 tests still passed. Scoping to the matching
   * definitions closes that.
   */
  function functionDefinitions(sql: string): { name: string; body: string }[] {
    const DEF = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-z0-9_]+)\s*\(/gi;
    const heads = [...sql.matchAll(DEF)];
    return heads.map((m, i) => ({
      name: m[1],
      body: sql.slice(m.index ?? 0, i + 1 < heads.length ? heads[i + 1].index ?? sql.length : sql.length),
    }));
  }

  it('the NEWEST function emitter still ORs the orders flag with an allocation EXISTS', () => {
    // If this fails, the SERVER rule moved and orderRequiresSplitBilling is stale.
    const newest = emitters[emitters.length - 1];
    const sql = readFileSync(join(MIGRATIONS_DIR, newest), 'utf8');

    // Only the definitions of THIS function family. A migration may legitimately
    // redefine unrelated functions alongside it — 20260827041200 also re-emits
    // _complete_delivery_authorized_impl — so requiring the guard in every
    // definition in the file would false-alarm.
    const targets = functionDefinitions(sql)
      .filter((d) => /create_invoice_for_unbilled_delivery/i.test(d.name));

    expect(targets.length, `newest function emitter: ${newest}`).toBeGreaterThan(0);

    // EVERY matching definition must carry the guard, not merely one of them.
    // Deliberately strict: a re-emission that adds a thin unguarded delegate
    // trips this. Loud beats silent for a rule whose absence mis-attributes AR.
    for (const def of targets) {
      const where = `${newest} → ${def.name}`;

      // Assert presence FIRST: with the guard dropped, indexOf returns -1 and a
      // slice would silently produce a window over unrelated SQL.
      expect(def.body, where).toContain('ORDER_NEEDS_SPLIT_BILLING');

      const guardIndex = def.body.indexOf('ORDER_NEEDS_SPLIT_BILLING');
      const guardBlock = def.body.slice(Math.max(0, guardIndex - 1200), guardIndex);

      expect(guardBlock, where).toMatch(/COALESCE\(needs_split_billing,\s*false\)/);
      expect(guardBlock, where).toMatch(/OR EXISTS/);
      expect(guardBlock, where).toMatch(/FROM order_item_field_allocations/);
    }
  });

  it('LEGACY whole-file assertion is gone (scoped to matching definitions)', () => {
    // Pins the round-4 fix: the guard check must run per-definition. If someone
    // reverts to scanning the whole file, an unguarded replacement sitting beside
    // a guarded legacy definition passes again.
    const newest = emitters[emitters.length - 1];
    const sql = readFileSync(join(MIGRATIONS_DIR, newest), 'utf8');
    const defs = functionDefinitions(sql);

    // The newest emitter genuinely contains unrelated definitions; if this ever
    // becomes 1, the scoping above stops being exercised by real data.
    expect(defs.length, `definitions in ${newest}`).toBeGreaterThan(1);
    expect(defs.some((d) => !/create_invoice_for_unbilled_delivery/i.test(d.name))).toBe(true);
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
