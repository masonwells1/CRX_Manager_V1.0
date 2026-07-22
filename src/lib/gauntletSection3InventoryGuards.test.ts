import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

function source(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n');
}

describe('live-foundation gauntlet section 3 inventory guards', () => {
  it('keeps InventoryPage inline edits away from stock-moving fields', () => {
    const inventoryPage = source('src/pages/InventoryPage.tsx');

    expect(inventoryPage).toContain("new Set(['reorder_point', 'min_stock_level'])");
    expect(inventoryPage).toContain('Inventory inline edit cannot update');

    const locationColumn = inventoryPage.match(/key: 'location',[\s\S]*?header: 'Location',[\s\S]*?},/);
    expect(locationColumn?.[0] ?? '').not.toContain('editable: isAdmin');
    expect(locationColumn?.[0] ?? '').not.toContain('editType:');
  });

  it('keeps order product pickers on get_inventory_position instead of raw PO math', () => {
    for (const path of [
      'src/pages/NewOrder.tsx',
      'src/pages/OrderDetail.tsx',
      'src/components/deliveries/QuickDeliveryModal.tsx',
    ]) {
      const file = source(path);
      expect(file).toContain("rpc('get_inventory_position')");
      expect(file).toContain('inventoryPositionByProduct');
      expect(file).not.toContain("from('purchase_order_items')");
      expect(file).not.toContain('quantity_ordered) - Number');
    }
  });

  it('keeps inventory-position parsing failures from escaping order screens', () => {
    for (const path of [
      'src/pages/NewOrder.tsx',
      'src/pages/OrderDetail.tsx',
    ]) {
      const file = source(path);
      expect(file).toContain("assertRpcResult<InventoryPositionRow[]>(positionData, 'get_inventory_position')");
      expect(file).toContain('validateInventoryPositionShape(positionRows)');
      expect(file).toContain('catch (err)');
      expect(file).toContain('setInventoryByProduct({})');
      expect(file).toContain('Inventory position data was malformed. Please refresh.');
    }
  });

  it('documents the live database guard and quick-receive grant fix in a migration', () => {
    const migration = source('supabase/migrations/20260722122651_guard_inventory_location_and_matcher_grants.sql');

    expect(migration).toContain('CREATE TRIGGER guard_inventory_location_change');
    expect(migration).toContain('INVENTORY_LOCATION_TRANSFER_REQUIRED');
    expect(migration).toContain('REVOKE EXECUTE ON FUNCTION public.match_quick_receive_items(jsonb, text) FROM anon');
    expect(migration).toContain("has_function_privilege('anon', 'public.match_quick_receive_items(jsonb, text)', 'EXECUTE')");
  });
});
