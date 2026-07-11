/**
 * Wave B.3 — runtime validator for `get_inventory_position()` RPC responses.
 *
 * `assertRpcResult<T>` only checks for null/undefined and casts. It does NOT
 * validate that the runtime shape matches T. If the RPC ever drifts (column
 * dropped, type changed, function silently regressed by a CREATE OR REPLACE),
 * TypeScript can't catch it at compile time and the first symptom is a `NaN`
 * rendering somewhere downstream.
 *
 * This validator runs after `assertRpcResult` and throws fast if the response
 * doesn't look like an array of `InventoryPositionRow`. The error message
 * names the offending field and row index so a regression is debuggable
 * from the Sentry breadcrumb alone.
 *
 * Cost: O(rows) scan with one cheap field check per row. ~111 rows in
 * production today; runtime cost is microseconds.
 */
import type { InventoryPositionRow } from '../types';

const REQUIRED_NUMERIC_FIELDS: Array<keyof InventoryPositionRow> = [
  'quantity_available',
  'quantity_prebooked',
  'quantity_on_order',
  'holds_qty',
  'job_holds_qty',
  'planned_qty',
  'delivered_ytd',
  'net_position',
  'reorder_point',
  'min_stock_level',
];

const REQUIRED_STRING_FIELDS: Array<keyof InventoryPositionRow> = [
  'product_id',
  'product_name',
];

export function validateInventoryPositionShape(
  rows: unknown,
): asserts rows is InventoryPositionRow[] {
  if (!Array.isArray(rows)) {
    throw new Error(
      `get_inventory_position: expected array, got ${typeof rows}`,
    );
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as Record<string, unknown>;
    if (row === null || typeof row !== 'object') {
      throw new Error(
        `get_inventory_position: row ${i} is not an object`,
      );
    }

    for (const field of REQUIRED_STRING_FIELDS) {
      if (typeof row[field] !== 'string') {
        throw new Error(
          `get_inventory_position: row ${i} field "${field}" expected string, got ${typeof row[field]}`,
        );
      }
    }

    for (const field of REQUIRED_NUMERIC_FIELDS) {
      const value = row[field];
      if (typeof value !== 'number' || Number.isNaN(value)) {
        throw new Error(
          `get_inventory_position: row ${i} field "${field}" expected finite number, got ${typeof value} (${String(value)})`,
        );
      }
    }

    if (typeof row.is_low_stock !== 'boolean') {
      throw new Error(
        `get_inventory_position: row ${i} field "is_low_stock" expected boolean, got ${typeof row.is_low_stock}`,
      );
    }
  }
}
