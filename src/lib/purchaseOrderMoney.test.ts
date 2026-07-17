import { describe, expect, it } from 'vitest';
import {
  purchaseOrderCentsToDollars,
  purchaseOrderLineTotalCents,
  purchaseOrderUnitCostCents,
} from './purchaseOrderMoney';

describe('purchase-order cents math', () => {
  it('converts a unit cost to integer cents', () => {
    expect(purchaseOrderUnitCostCents(1585.6)).toBe(158560);
    expect(purchaseOrderUnitCostCents(1.005)).toBe(101);
    expect(purchaseOrderUnitCostCents(1.004)).toBe(100);
  });

  it('rounds each fractional-quantity line to one whole cent', () => {
    expect(purchaseOrderLineTotalCents(10.125, 3.33)).toBe(3372);
    expect(purchaseOrderCentsToDollars(3372)).toBe(33.72);
  });

  it('matches PostgreSQL numeric half-cent rounding instead of binary floating point', () => {
    expect(purchaseOrderLineTotalCents(1.005, 1)).toBe(101);
    expect(purchaseOrderLineTotalCents(0.0005, 10)).toBe(1);
  });
});
