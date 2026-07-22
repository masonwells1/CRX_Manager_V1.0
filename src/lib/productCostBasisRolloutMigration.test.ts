import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migrationSql = readFileSync(
  join(repoRoot, 'supabase', 'migrations', '20260722064814_wells_cost_basis_rollout_gate.sql'),
  'utf8',
);

const wellsProductIds = [
  'ab708913-080e-4894-ba5c-8beb7586d356',
  '8db05fc1-c3c9-4049-b284-c02c0a7a3056',
  '6fd3adc1-909f-4b63-98fa-73028a780a7c',
  '7de7131e-b4cb-4048-be14-77eb3449b20f',
  '908f29d4-62d9-404b-93e0-50666f65ee99',
  '05b9f5d8-3305-4234-afaa-e7a63c3b46f9',
  '81f689f5-c78f-480a-b884-4e097986e212',
  '44b47fe1-9484-4ede-95d6-52988a840d75',
  'd1961efe-6133-4ab4-bf84-ac7bf7da903a',
  '03dbce7d-c142-4f24-8bfc-cc490fa47a0d',
];

describe('Wells supplier cost-basis rollout migration contract', () => {
  it('seeds exactly the reviewed ten Products and fails closed on live-shape drift', () => {
    expect(new Set(wellsProductIds).size).toBe(10);
    for (const productId of wellsProductIds) {
      expect(migrationSql.match(new RegExp(productId, 'g'))).toHaveLength(2);
    }
    for (const driftGuard of ['PRODUCT', 'VENDOR', 'LINK', 'OBSERVATION']) {
      expect(migrationSql).toContain(`WELLS_COST_BASIS_ROLLOUT_${driftGuard}_SHAPE_DRIFT`);
    }
    const rolloutPreflight = migrationSql.slice(
      0,
      migrationSql.indexOf('CREATE TABLE public.product_cost_basis_rollout'),
    );
    expect(rolloutPreflight).toContain('WELLS_COST_BASIS_ROLLOUT_GLOBAL_FLAG_DRIFT');
    expect(rolloutPreflight.match(/AND l\.is_reusable/g)).toHaveLength(4);
    const settingLock = rolloutPreflight.indexOf('PERFORM s.setting_key');
    const observationLock = rolloutPreflight.indexOf('PERFORM o.id', settingLock);
    const linkLock = rolloutPreflight.indexOf('PERFORM l.id', observationLock);
    const vendorLock = rolloutPreflight.indexOf('PERFORM v.id', linkLock);
    const productLock = rolloutPreflight.indexOf('PERFORM p.id', vendorLock);
    const finalAssertions = rolloutPreflight.indexOf(
      'WELLS_COST_BASIS_ROLLOUT_PRODUCT_SHAPE_DRIFT',
      productLock,
    );
    const vendorRevalidation = rolloutPreflight.indexOf(
      'WELLS_COST_BASIS_ROLLOUT_VENDOR_SHAPE_DRIFT',
      productLock,
    );
    const settingRevalidation = rolloutPreflight.lastIndexOf(
      'WELLS_COST_BASIS_ROLLOUT_GLOBAL_FLAG_DRIFT',
    );
    expect(settingLock).toBeGreaterThan(-1);
    expect(observationLock).toBeGreaterThan(-1);
    expect(linkLock).toBeGreaterThan(observationLock);
    expect(vendorLock).toBeGreaterThan(linkLock);
    expect(productLock).toBeGreaterThan(vendorLock);
    expect(settingRevalidation).toBeGreaterThan(productLock);
    expect(vendorRevalidation).toBeGreaterThan(productLock);
    expect(finalAssertions).toBeGreaterThan(productLock);
  });

  it('keeps the rollout table and fixed-path helper private', () => {
    expect(migrationSql).toContain('CREATE TABLE public.product_cost_basis_rollout');
    expect(migrationSql).toContain('ALTER TABLE public.product_cost_basis_rollout ENABLE ROW LEVEL SECURITY');
    expect(migrationSql).toMatch(/FOR ALL TO PUBLIC\s+USING \(false\)\s+WITH CHECK \(false\)/);
    expect(migrationSql).toMatch(/REVOKE ALL ON TABLE public\.product_cost_basis_rollout\s+FROM PUBLIC, anon, authenticated, service_role/);
    expect(migrationSql).toMatch(/_supplier_cost_basis_enabled_for_product[\s\S]+?SECURITY DEFINER[\s\S]+?SET search_path = public, pg_temp/);
    expect(migrationSql).toMatch(/REVOKE ALL ON FUNCTION public\._supplier_cost_basis_enabled_for_product\(uuid\)[\s\S]+?authenticated, service_role/);
    const captureStart = migrationSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.capture_purchase_order_item_cost_snapshot()',
    );
    const captureEnd = migrationSql.indexOf('$function$;', captureStart);
    const captureBody = migrationSql.slice(captureStart, captureEnd);
    expect(captureBody).toContain('SECURITY DEFINER');
    expect(captureBody).toContain('SET search_path = public, pg_temp');
    expect(migrationSql.slice(captureEnd)).toMatch(
      /REVOKE ALL ON FUNCTION public\.capture_purchase_order_item_cost_snapshot\(\)\s+FROM PUBLIC, anon, authenticated, service_role/,
    );
  });

  it('routes every deployed flag reader through the product-scoped helper', () => {
    for (const productExpression of ['NEW.product_id', 'OLD.id', 'v_product_id', 'p_product_id']) {
      expect(migrationSql).toContain(`public._supplier_cost_basis_enabled_for_product(${productExpression})`);
    }
    expect(migrationSql.match(/_supplier_cost_basis_enabled_for_product\(NEW\.id\)/g)).toHaveLength(2);
    const runtimeSql = migrationSql.slice(
      migrationSql.indexOf('CREATE TABLE public.product_cost_basis_rollout'),
    );
    expect(runtimeSql.match(/setting_key = 'supplier_cost_basis_enabled'/g)).toHaveLength(2);
    expect(migrationSql).toMatch(
      /capture_purchase_order_item_cost_snapshot\(\)[\s\S]+?SECURITY DEFINER[\s\S]+?_supplier_cost_basis_enabled_for_product\(NEW\.product_id\)/,
    );
  });

  it('preserves apply lock order and the final null-cost wrapper body', () => {
    const applyStart = migrationSql.indexOf('CREATE OR REPLACE FUNCTION public.apply_product_cost_basis_change_set');
    const settingLock = migrationSql.indexOf('PERFORM setting_key', applyStart);
    const rolloutLock = migrationSql.indexOf('PERFORM rollout.product_id', settingLock);
    const observationLock = migrationSql.indexOf('PERFORM o.id', rolloutLock);
    const itemLock = migrationSql.indexOf('PERFORM poi.id', observationLock);
    const parentLock = migrationSql.indexOf('PERFORM po.id', itemLock);
    const productLock = migrationSql.indexOf('PERFORM p.id', parentLock);
    expect(settingLock).toBeGreaterThan(applyStart);
    expect(rolloutLock).toBeGreaterThan(settingLock);
    expect(observationLock).toBeGreaterThan(rolloutLock);
    expect(itemLock).toBeGreaterThan(observationLock);
    expect(parentLock).toBeGreaterThan(itemLock);
    expect(productLock).toBeGreaterThan(parentLock);
    expect(migrationSql).toContain('public._product_cost_basis_row_required(');
  });

  it('does not enable the global flag or rewrite Product money', () => {
    expect(migrationSql).not.toMatch(/UPDATE\s+public\.app_settings/i);
    expect(migrationSql).not.toMatch(/UPDATE\s+public\.products/i);
    expect(migrationSql).not.toMatch(/DELETE\s+FROM/i);
  });
});
