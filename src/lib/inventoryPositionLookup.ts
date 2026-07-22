import type { InventoryPositionRow } from '../types';

export interface ProductInventoryPosition {
  available: number;
  prebooked: number;
  onOrder: number;
}

export function inventoryPositionByProduct(
  rows: InventoryPositionRow[],
  options?: { location?: string },
): Record<string, ProductInventoryPosition> {
  const map: Record<string, ProductInventoryPosition> = {};

  for (const row of rows) {
    const current = map[row.product_id] ?? { available: 0, prebooked: 0, onOrder: 0 };
    if (!options?.location || row.location === options.location) {
      current.available += Number(row.quantity_available);
      current.prebooked += Number(row.quantity_prebooked);
    }
    current.onOrder = Math.max(current.onOrder, Number(row.quantity_on_order));
    map[row.product_id] = current;
  }

  return map;
}
