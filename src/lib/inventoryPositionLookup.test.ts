import { describe, expect, it } from 'vitest';
import { inventoryPositionByProduct } from './inventoryPositionLookup';
import type { InventoryPositionRow } from '../types';

function row(overrides: Partial<InventoryPositionRow>): InventoryPositionRow {
  return {
    inventory_id: null,
    product_id: 'product-a',
    product_name: 'Product A',
    inventory_unit: null,
    container_size: null,
    container_type: null,
    vendor: null,
    current_cost: null,
    location: 'Main Warehouse',
    unit_size: null,
    quantity_available: 0,
    quantity_prebooked: 0,
    quantity_on_order: 0,
    holds_qty: 0,
    job_holds_qty: 0,
    planned_qty: 0,
    delivered_ytd: 0,
    net_position: 0,
    reorder_point: 0,
    min_stock_level: 0,
    is_low_stock: false,
    ...overrides,
  };
}

describe('inventoryPositionByProduct', () => {
  it('uses canonical RPC quantities and sums every location by product', () => {
    const result = inventoryPositionByProduct([
      row({ product_id: 'product-a', quantity_available: 5, quantity_prebooked: 2, quantity_on_order: 3 }),
      row({ product_id: 'product-a', location: 'Shop', quantity_available: 4, quantity_prebooked: 1, quantity_on_order: 3 }),
      row({ product_id: 'product-b', quantity_available: 8, quantity_prebooked: 0, quantity_on_order: 7 }),
    ]);

    expect(result).toEqual({
      'product-a': { available: 9, prebooked: 3, onOrder: 3 },
      'product-b': { available: 8, prebooked: 0, onOrder: 7 },
    });
  });

  it('can scope quick-delivery stock to the warehouse enforced by the delivery RPC', () => {
    const result = inventoryPositionByProduct([
      row({ product_id: 'product-a', location: 'Main Warehouse', quantity_available: 5, quantity_on_order: 2 }),
      row({ product_id: 'product-a', location: 'Shop', quantity_available: 99, quantity_on_order: 2 }),
    ], { location: 'Main Warehouse' });

    expect(result).toEqual({
      'product-a': { available: 5, prebooked: 0, onOrder: 2 },
    });
  });

  it('keeps product-level on-order visible when a location has no stock row', () => {
    const result = inventoryPositionByProduct([
      row({
        product_id: 'product-a',
        location: null,
        quantity_available: 0,
        quantity_prebooked: 0,
        quantity_on_order: 12,
      }),
    ], { location: 'Main Warehouse' });

    expect(result).toEqual({
      'product-a': { available: 0, prebooked: 0, onOrder: 12 },
    });
  });
});
