import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migrationSql = readFileSync(
  join(
    repoRoot,
    'supabase',
    'migrations',
    '20260722080226_lock_received_po_cost_snapshot_across_product_reassignment.sql',
  ),
  'utf8',
);

describe('received PO cost snapshot Product-reassignment guard', () => {
  it('keeps the trigger private and evaluates both Product identities on update', () => {
    expect(migrationSql).toContain(
      'CREATE OR REPLACE FUNCTION public.capture_purchase_order_item_cost_snapshot()',
    );
    expect(migrationSql).toContain('SECURITY DEFINER');
    expect(migrationSql).toContain('SET search_path = public, pg_temp');
    expect(migrationSql).toContain(
      'public._supplier_cost_basis_enabled_for_product(NEW.product_id)',
    );
    expect(migrationSql).toContain(
      'public._supplier_cost_basis_enabled_for_product(OLD.product_id)',
    );
    expect(migrationSql).toMatch(
      /IF TG_OP = 'UPDATE' THEN[\s\S]+?v_phase2_enabled := v_phase2_enabled\s+OR public\._supplier_cost_basis_enabled_for_product\(OLD\.product_id\)/,
    );
    expect(migrationSql).toMatch(
      /REVOKE ALL ON FUNCTION public\.capture_purchase_order_item_cost_snapshot\(\)\s+FROM PUBLIC, anon, authenticated, service_role/,
    );
  });
});
