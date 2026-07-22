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
    '20260722091359_supplier_pricing_workbook_v2_product_info.sql',
  ),
  'utf8',
);

describe('supplier pricing workbook v2 migration contract', () => {
  it('retains six Product information fields in the export token and manifest rows', () => {
    for (const field of [
      'suggested_rate', 'rate_per_acre', 'rate_unit',
      'use_timing', 'internal_notes', 'quoting_notes',
    ]) {
      expect(migrationSql).toContain(`'${field}'`);
      expect(migrationSql).toContain(`${field}_snapshot`);
    }
    expect(migrationSql).toContain("'crx-product-pricing-phase2-v2'");
    expect(migrationSql).toMatch(/SET status = 'expired'[\s\S]+?format_version = 'crx-product-pricing-phase1a-v1'/);
  });

  it('keeps information change rows private and hardens the Phase 2 apply boundary', () => {
    expect(migrationSql).toContain('ALTER TABLE public.product_info_change_set_rows ENABLE ROW LEVEL SECURITY');
    expect(migrationSql).toMatch(/REVOKE ALL ON TABLE public\.product_info_change_set_rows[\s\S]+?service_role/);
    expect(migrationSql).toContain('PRODUCT_COST_BASIS_CONTEXT_REQUIRED');
    expect(migrationSql).toContain('pg_advisory_xact_lock');
    expect(migrationSql).toContain('_apply_product_cost_basis_change_set_serialized_inner');
  });

  it('applies pricing and information with one Product update and an atomic audit event', () => {
    const applyStart = migrationSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_product_pricing_change_set',
    );
    const applyEnd = migrationSql.indexOf('$function$;', applyStart);
    const applyBody = migrationSql.slice(applyStart, applyEnd);
    expect(applyBody.match(/UPDATE public\.products p/g)).toHaveLength(1);
    expect(applyBody).toContain("'product_info_updated'");
    expect(applyBody).toContain('CHANGE_SET_OUTPUT_DRIFT');
    expect(applyBody).toContain('manifest.identity_fingerprint');
    expect(applyBody).toContain("info_row.changes ? 'rate_per_acre'");
  });

  it('broadens database-managed versioning to every governed information field', () => {
    for (const field of [
      'suggested_rate', 'rate_per_acre', 'rate_unit',
      'use_timing', 'internal_notes', 'quoting_notes',
    ]) {
      expect(migrationSql).toContain(`OLD.${field} IS DISTINCT FROM NEW.${field}`);
    }
  });
});
