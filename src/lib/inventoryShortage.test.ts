/**
 * Unit cover for the per-product need aggregation. The tier-split behaviour
 * that motivated this helper is proven end-to-end against the real page in
 * src/pages/Orders.pickListShortage.test.tsx; these cases pin the input
 * guards, which that page test cannot reach.
 */
import { describe, expect, it } from 'vitest';
import { sumNeedByProduct } from './inventoryShortage';

describe('sumNeedByProduct', () => {
  it('adds every tier line of the same product into one need', () => {
    expect(
      sumNeedByProduct([
        { productId: 'p1', label: 'Concentrate', quantity: 6 },
        { productId: 'p1', label: 'Concentrate', quantity: 6 },
        { productId: 'p2', label: 'Surfactant', quantity: 2 },
      ])
    ).toEqual([
      { productId: 'p1', label: 'Concentrate', quantity: 12 },
      { productId: 'p2', label: 'Surfactant', quantity: 2 },
    ]);
  });

  it('keeps the order the operator sees the lines in', () => {
    const result = sumNeedByProduct([
      { productId: 'p2', label: 'Second', quantity: 1 },
      { productId: 'p1', label: 'First', quantity: 1 },
      { productId: 'p2', label: 'Second', quantity: 1 },
    ]);
    expect(result.map((need) => need.productId)).toEqual(['p2', 'p1']);
  });

  it('ignores lines that cannot represent real demand', () => {
    expect(
      sumNeedByProduct([
        { productId: '', label: 'No product', quantity: 5 },
        { productId: 'p1', label: 'Zero', quantity: 0 },
        { productId: 'p1', label: 'Negative', quantity: -3 },
        { productId: 'p1', label: 'Not a number', quantity: Number.NaN },
        { productId: 'p1', label: 'Infinite', quantity: Number.POSITIVE_INFINITY },
      ])
    ).toEqual([]);
  });

  it('does not let a skipped line strip the quantity off a real one', () => {
    expect(
      sumNeedByProduct([
        { productId: 'p1', label: 'Real', quantity: 4 },
        { productId: 'p1', label: 'Zero', quantity: 0 },
      ])
    ).toEqual([{ productId: 'p1', label: 'Real', quantity: 4 }]);
  });

  it('borrows a later label when the first line has none', () => {
    expect(
      sumNeedByProduct([
        { productId: 'p1', label: '', quantity: 1 },
        { productId: 'p1', label: 'Named later', quantity: 1 },
      ])
    ).toEqual([{ productId: 'p1', label: 'Named later', quantity: 2 }]);
  });

  it('returns nothing for no lines', () => {
    expect(sumNeedByProduct([])).toEqual([]);
  });
});
