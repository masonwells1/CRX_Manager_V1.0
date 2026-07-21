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
    '20260721193553_supplier_cost_basis_phase2.sql',
  ),
  'utf8',
);

describe('supplier cost-basis Phase 2 migration contract', () => {
  it('is additive, off by default, and does not rewrite Product money during migration', () => {
    expect(migrationSql).toContain("'supplier_cost_basis_enabled'");
    expect(migrationSql).toMatch(/'supplier_cost_basis_enabled',\s*'false'/);
    expect(migrationSql).toMatch(
      /ON CONFLICT \(setting_key\) DO UPDATE[\s\S]+?setting_value = EXCLUDED\.setting_value/,
    );
    expect(migrationSql).toContain('CREATE TABLE public.product_cost_basis');
    expect(migrationSql).toContain('CREATE TABLE public.product_cost_basis_change_rows');
    expect(migrationSql).not.toMatch(/CREATE TABLE IF NOT EXISTS public\.product_cost_basis/);
    expect(migrationSql).not.toMatch(/UPDATE\s+public\.products\s+SET\s+current_cost/i);
    expect(migrationSql).not.toMatch(/DELETE\s+FROM\s+public\.products/i);

    const baselineCopy = migrationSql.indexOf('INSERT INTO public.product_cost_basis(');
    const enforcementTrigger = migrationSql.indexOf(
      'CREATE TRIGGER trigger_zz_require_product_cost_basis',
    );
    expect(enforcementTrigger).toBeGreaterThan(-1);
    expect(enforcementTrigger).toBeLessThan(baselineCopy);
  });

  it('stores cents and enforces one immutable active basis per Product', () => {
    expect(migrationSql).toMatch(/product_cost_basis[\s\S]+cost_cents bigint NOT NULL/i);
    expect(migrationSql).toContain('CREATE UNIQUE INDEX uq_product_cost_basis_active');
    expect(migrationSql).toContain('preview_product_cost_basis_changes overload drift');
    expect(migrationSql).toContain('apply_product_cost_basis_change_set overload drift');
    expect(migrationSql).toContain('get_product_cost_basis_workspace overload drift');
    expect(migrationSql).toMatch(/IF v_phase2_enabled THEN\s+RAISE EXCEPTION 'RECEIVED_PO_COST_SNAPSHOT_IMMUTABLE'/);
    expect(migrationSql).toContain('NEW.inventory_units_per_supplier_unit_snapshot := NULL');
    expect(migrationSql).toMatch(/IF TG_OP = 'INSERT' THEN[\s\S]+?NEW\.inventory_units_per_supplier_unit_snapshot := 1/);
    expect(migrationSql).toMatch(/BEFORE INSERT OR UPDATE OF quantity_received/);
    expect(migrationSql).toContain('WHERE effective_to IS NULL');
    expect(migrationSql).toContain('expected_active_basis_id uuid');
    expect(migrationSql).toContain("RAISE EXCEPTION 'PRODUCT_COST_BASIS_DELETE_FORBIDDEN'");
    expect(migrationSql).toContain("RAISE EXCEPTION 'PRODUCT_COST_BASIS_IMMUTABLE'");
    expect(migrationSql).not.toMatch(/cost_cents\s+(real|double precision)/i);
  });

  it('normalizes supplier and received-purchase evidence before selection', () => {
    expect(migrationSql).toContain(
      'CREATE OR REPLACE FUNCTION public.capture_purchase_order_item_cost_snapshot()',
    );
    expect(migrationSql).toContain(
      'CREATE TRIGGER trigger_capture_purchase_order_item_cost_snapshot',
    );
    expect(migrationSql).toContain("RAISE EXCEPTION 'RECEIVED_PO_COST_SNAPSHOT_IMMUTABLE'");
    expect(migrationSql).toMatch(
      /BEFORE INSERT OR UPDATE OF quantity_received, purchase_order_id, product_id,\s*unit_cost, unit_size/,
    );
    expect(migrationSql).toMatch(
      /COALESCE\(OLD\.quantity_received, 0\) <= 0[\s\S]+?NEW\.inventory_units_per_supplier_unit_snapshot := NULL/,
    );
    expect(migrationSql).toMatch(
      /UPDATE public\.purchase_order_items poi[\s\S]+?inventory_units_per_supplier_unit_snapshot = 1[\s\S]+?poi\.quantity_received > 0[\s\S]+?lower\(btrim\(poi\.unit_size\)\) = lower\(btrim\(p\.unit_size\)\)/,
    );
    expect(migrationSql).toContain(
      "set_config('crx.cost_basis_backfill', 'phase2', true)",
    );
    expect(migrationSql).toMatch(
      /current_setting\('crx\.cost_basis_backfill', true\) = 'phase2'[\s\S]+?OLD\.inventory_units_per_supplier_unit_snapshot IS NULL/,
    );
    const itemLock = migrationSql.indexOf('PERFORM poi.id', migrationSql.indexOf('CREATE OR REPLACE FUNCTION public.apply_product_cost_basis_change_set'));
    const parentLock = migrationSql.indexOf('PERFORM po.id', itemLock);
    expect(itemLock).toBeGreaterThan(-1);
    expect(parentLock).toBeGreaterThan(itemLock);
    expect(migrationSql).toMatch(
      /o\.cost_cents::numeric\s*\/\s*o\.package_quantity\s*\/\s*l\.inventory_units_per_supplier_unit/,
    );
    expect(migrationSql).toMatch(
      /poi\.unit_cost_cents::numeric\s*\/\s*poi\.inventory_units_per_supplier_unit_snapshot/,
    );
    expect(migrationSql).toContain('poi.quantity_received > 0');
    expect(migrationSql).toContain("RAISE EXCEPTION 'COST_BASIS_AMOUNT_MISMATCH'");
    expect(migrationSql).toContain('correction.supersedes_observation_id = o.id');
    expect(migrationSql).toContain('v.deleted_at IS NULL');
    expect(migrationSql).toMatch(/FOR UPDATE OF l/);
    expect(migrationSql).toMatch(/FOR UPDATE OF v/);
    expect(migrationSql).toMatch(/FOR UPDATE OF o/);
    expect(migrationSql).toMatch(/FOR UPDATE OF po/);
    expect(migrationSql).toMatch(/FOR UPDATE OF poi/);
    expect(migrationSql).toMatch(
      /setting_key = 'supplier_cost_basis_enabled'[\s\S]+?FOR UPDATE/,
    );
  });

  it('preserves workbook expiry and one-use rules for basis-only applies', () => {
    expect(migrationSql).toContain("v_export.status <> 'active'");
    expect(migrationSql).toContain("RAISE EXCEPTION 'WORKBOOK_EXPORT_CONSUMED_OR_EXPIRED'");
    expect(migrationSql).toMatch(
      /v_change_set\.status = 'no_changes'[\s\S]+?UPDATE public\.pricing_workbook_exports[\s\S]+?SET status = 'consumed'/,
    );
  });

  it('reuses Phase 1a and keeps its flag-off compatibility path ledger-complete', () => {
    expect(migrationSql).toContain('public.preview_product_pricing_changes(');
    expect(migrationSql).toContain('public.apply_product_pricing_change_set(');
    expect(migrationSql).toContain('CREATE TRIGGER trigger_zz_require_product_cost_basis');
    expect(migrationSql).toContain('CREATE TRIGGER trigger_zz_sync_legacy_product_cost_basis');
    expect(migrationSql).toContain("set_config('crx.cost_basis_legacy_sync', 'phase1a', true)");
    expect(migrationSql).toContain("RAISE EXCEPTION 'LEGACY_COST_BASIS_CONTEXT_INVALID'");
    expect(migrationSql).toContain("RAISE EXCEPTION 'PRODUCT_COST_BASIS_CONTEXT_REQUIRED'");
    expect(migrationSql).not.toContain('CREATE OR REPLACE FUNCTION public._calculate_product_pricing');
  });

  it('keeps ledger tables RPC-only and public RPCs admin/actor/idempotency guarded', () => {
    expect(migrationSql).toContain('ALTER TABLE public.product_cost_basis ENABLE ROW LEVEL SECURITY');
    expect(migrationSql).toContain('ON public.product_cost_basis FOR ALL TO PUBLIC');
    expect(migrationSql).toContain('USING (false) WITH CHECK (false)');
    expect(migrationSql).toContain('FROM PUBLIC, anon, authenticated, service_role');

    for (const functionName of [
      'preview_product_cost_basis_changes',
      'apply_product_cost_basis_change_set',
    ]) {
      const body = migrationSql.match(new RegExp(
        `CREATE OR REPLACE FUNCTION public\\.${functionName}\\([\\s\\S]+?\\$function\\$;`,
        'i',
      ));
      expect(body, `${functionName} function body`).not.toBeNull();
      expect(body![0]).toContain('SET search_path = public, pg_temp');
      expect(body![0]).toContain('p_performed_by IS DISTINCT FROM v_actor');
      expect(body![0]).toContain('IF NOT public.is_admin()');
      expect(body![0]).toContain('IDEMPOTENCY_KEY_REQUIRED');
    }
  });
});
