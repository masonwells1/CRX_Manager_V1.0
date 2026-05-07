/**
 * Unit tests for the get_inventory_position runtime validator.
 *
 * These tests don't call Supabase. They verify the validator throws fast
 * with a debuggable message when the RPC return shape drifts.
 */
import { describe, it, expect } from 'vitest';
import { validateInventoryPositionShape } from './inventoryPositionValidator';

const goodRow = {
  inventory_id: '11111111-1111-1111-1111-111111111111',
  product_id: '22222222-2222-2222-2222-222222222222',
  product_name: 'Test Herbicide',
  inventory_unit: 'Gal',
  container_size: 2.5,
  container_type: 'Jug',
  vendor: 'Test Vendor',
  current_cost: 30,
  location: 'Main Warehouse',
  unit_size: 'Gal',
  quantity_available: 586,
  quantity_prebooked: 36,
  quantity_on_order: 0,
  holds_qty: 0,
  planned_qty: 0,
  delivered_ytd: 530,
  net_position: 550,
  reorder_point: 0,
  min_stock_level: 0,
  is_low_stock: false,
};

describe('validateInventoryPositionShape', () => {
  it('accepts a valid array of rows', () => {
    expect(() => validateInventoryPositionShape([goodRow])).not.toThrow();
  });

  it('accepts an empty array', () => {
    expect(() => validateInventoryPositionShape([])).not.toThrow();
  });

  it('accepts rows with null nullable fields (virtual rows)', () => {
    const virtualRow = {
      ...goodRow,
      inventory_id: null,
      location: null,
      unit_size: null,
      inventory_unit: null,
      container_size: null,
      container_type: null,
      vendor: null,
      current_cost: null,
    };
    expect(() => validateInventoryPositionShape([virtualRow])).not.toThrow();
  });

  it('throws when the response is not an array', () => {
    expect(() => validateInventoryPositionShape({} as unknown)).toThrow(
      /expected array/,
    );
    expect(() => validateInventoryPositionShape(null)).toThrow(
      /expected array/,
    );
    expect(() => validateInventoryPositionShape('hello' as unknown)).toThrow(
      /expected array/,
    );
  });

  it('throws when a row is null or not an object', () => {
    expect(() => validateInventoryPositionShape([null])).toThrow(
      /row 0 is not an object/,
    );
  });

  it('throws when a required string field is missing', () => {
    const bad = { ...goodRow, product_id: undefined };
    expect(() => validateInventoryPositionShape([bad])).toThrow(
      /field "product_id" expected string/,
    );
  });

  it('throws when a required string field is the wrong type', () => {
    const bad = { ...goodRow, product_name: 42 };
    expect(() => validateInventoryPositionShape([bad])).toThrow(
      /field "product_name" expected string/,
    );
  });

  it('throws when a required numeric field is a string (Postgres numeric drift)', () => {
    const bad = { ...goodRow, quantity_available: '586' };
    expect(() => validateInventoryPositionShape([bad])).toThrow(
      /field "quantity_available" expected finite number/,
    );
  });

  it('throws when a required numeric field is NaN', () => {
    const bad = { ...goodRow, net_position: NaN };
    expect(() => validateInventoryPositionShape([bad])).toThrow(
      /field "net_position" expected finite number/,
    );
  });

  it('throws when is_low_stock is not a boolean', () => {
    const bad = { ...goodRow, is_low_stock: 'true' };
    expect(() => validateInventoryPositionShape([bad])).toThrow(
      /field "is_low_stock" expected boolean/,
    );
  });

  it('error message names the offending row index', () => {
    const bad = { ...goodRow, product_id: 42 };
    expect(() => validateInventoryPositionShape([goodRow, goodRow, bad])).toThrow(
      /row 2 field "product_id"/,
    );
  });

  it('verifies net_position math invariant: available - prebooked + on_order', () => {
    // Sanity check on the test fixture: not validated by the validator itself,
    // but documenting the invariant the RPC is expected to maintain.
    expect(goodRow.net_position).toBe(
      goodRow.quantity_available - goodRow.quantity_prebooked + goodRow.quantity_on_order,
    );
  });
});
