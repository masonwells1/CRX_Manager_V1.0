import { describe, it, expect } from 'vitest';
import {
  getTierPrice,
  getConversionFactor,
  recalcItem,
  computeQuoteTotals,
  validateCommissionSplits,
  convertToGlLb,
  type CalcItem,
} from './quoteCalc';
import type { Product, UnitConversion } from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeProduct(overrides?: Partial<Product>): Product {
  return {
    id: 'prod-1',
    product_name: 'Test Product',
    sku: null,
    category: null,
    vendor: null,
    manufacturer: null,
    container_size: null,
    unit_size: null,
    epa_registration: null,
    product_form: 'liquid',
    inventory_unit: 'Gallon',
    container_unit: null,
    container_type: null,
    current_cost: 10,
    cost_updated_date: null,
    tier1_price: 20,
    tier1_margin: null,
    tier1_gross_margin: null,
    tier2_price: 18,
    tier2_margin: null,
    tier2_gross_margin: null,
    tier3_price: 15,
    tier3_margin: null,
    tier3_gross_margin: null,
    tier1_price_per_acre: null,
    tier2_price_per_acre: null,
    tier3_price_per_acre: null,
    suggested_rate: null,
    rate_per_acre: null,
    rate_unit: null,
    notes: null,
    is_active: true,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

function makeItem(overrides?: Partial<CalcItem>): CalcItem {
  return {
    product_id: 'prod-1',
    actual_rate: 32,
    rate_unit: 'fl oz',
    acres: 100,
    price_per_unit: 0,
    current_cost: 0,
    oz_per_acre: null,
    price_per_acre: null,
    total_units_needed: null,
    total_price: 0,
    profit: 0,
    net_margin: 0,
    suggested_rate: null,
    unit_size: null,
    notes: null,
    sort_order: 1,
    ...overrides,
  };
}

const conversions: UnitConversion[] = [
  { id: '1', unit: 'fl oz', factor_oz: 1, unit_type: 'liquid', notes: null },
  { id: '2', unit: 'Pint', factor_oz: 16, unit_type: 'liquid', notes: null },
  { id: '3', unit: 'Quart', factor_oz: 32, unit_type: 'liquid', notes: null },
  { id: '4', unit: 'Gallon', factor_oz: 128, unit_type: 'liquid', notes: null },
  { id: '5', unit: 'Lb', factor_oz: 16, unit_type: 'dry', notes: null },
  { id: '6', unit: 'Oz', factor_oz: 1, unit_type: 'dry', notes: null },
];

// ---------------------------------------------------------------------------
// getTierPrice
// ---------------------------------------------------------------------------

describe('getTierPrice', () => {
  const product = makeProduct({
    tier1_price: 20,
    tier2_price: 18,
    tier3_price: 15,
  });

  it('returns tier 1 price', () => {
    expect(getTierPrice(product, 1)).toBe(20);
  });

  it('returns tier 2 price', () => {
    expect(getTierPrice(product, 2)).toBe(18);
  });

  it('returns tier 3 price for tier 3', () => {
    expect(getTierPrice(product, 3)).toBe(15);
  });

  it('falls back to tier 3 for unknown tier numbers', () => {
    expect(getTierPrice(product, 99)).toBe(15);
  });

  it('returns 0 when tier price is null', () => {
    const p = makeProduct({ tier1_price: null });
    expect(getTierPrice(p, 1)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getConversionFactor
// ---------------------------------------------------------------------------

describe('getConversionFactor', () => {
  it('returns correct factor for fl oz', () => {
    expect(getConversionFactor('fl oz', conversions)).toBe(1);
  });

  it('returns correct factor for Gallon', () => {
    expect(getConversionFactor('Gallon', conversions)).toBe(128);
  });

  it('is case-insensitive', () => {
    expect(getConversionFactor('gallon', conversions)).toBe(128);
    expect(getConversionFactor('GALLON', conversions)).toBe(128);
  });

  it('returns 1 for null unit', () => {
    expect(getConversionFactor(null, conversions)).toBe(1);
  });

  it('returns 1 for unknown unit', () => {
    expect(getConversionFactor('Bushel', conversions)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// recalcItem — core pricing logic
// ---------------------------------------------------------------------------

describe('recalcItem', () => {
  it('calculates correctly for liquid product: 32 fl oz/acre on 100 acres at $20/gal', () => {
    const product = makeProduct({
      tier1_price: 20,
      current_cost: 10,
      inventory_unit: 'Gallon',
    });
    const item = makeItem({
      actual_rate: 32,
      rate_unit: 'fl oz',
      acres: 100,
    });

    const result = recalcItem(item, product, 1, conversions);

    // 32 fl oz × 1 = 32 oz/acre
    expect(result.oz_per_acre).toBe(32);
    // 100 acres × 32 oz / 128 oz per gallon = 25 gallons
    expect(result.total_units_needed).toBe(25);
    // 25 gal × $20/gal = $500
    expect(result.total_price).toBe(500);
    // (20 - 10) × 25 = $250
    expect(result.profit).toBe(250);
    // 250/500 = 50%
    expect(result.net_margin).toBe(50);
  });

  it('calculates correctly for 1 quart/acre on 200 acres at $18/gal (tier 2)', () => {
    const product = makeProduct({
      tier2_price: 18,
      current_cost: 8,
      inventory_unit: 'Gallon',
    });
    const item = makeItem({
      actual_rate: 1,
      rate_unit: 'Quart',
      acres: 200,
    });

    const result = recalcItem(item, product, 2, conversions);

    // 1 Qt × 32 oz/Qt = 32 oz/acre
    expect(result.oz_per_acre).toBe(32);
    // 200 × 32 / 128 = 50 gal
    expect(result.total_units_needed).toBe(50);
    // 50 × 18 = 900
    expect(result.total_price).toBe(900);
    // (18 - 8) × 50 = 500
    expect(result.profit).toBe(500);
    // 500/900 = 55.56%
    expect(result.net_margin).toBeCloseTo(55.56, 1);
  });

  it('calculates correctly for dry product: 2 Lb/acre on 500 acres at $15/Lb', () => {
    const product = makeProduct({
      tier3_price: 15,
      current_cost: 6,
      inventory_unit: 'Lb',
      product_form: 'dry',
    });
    const item = makeItem({
      actual_rate: 2,
      rate_unit: 'Lb',
      acres: 500,
    });

    const result = recalcItem(item, product, 3, conversions);

    // 2 Lb × 16 oz = 32 oz/acre
    expect(result.oz_per_acre).toBe(32);
    // 500 × 32 / 16 oz-per-lb = 1000 Lb
    expect(result.total_units_needed).toBe(1000);
    // 1000 × 15 = 15000
    expect(result.total_price).toBe(15000);
    // (15 - 6) × 1000 = 9000
    expect(result.profit).toBe(9000);
    // 9000/15000 = 60%
    expect(result.net_margin).toBe(60);
  });

  it('returns 0s when actual_rate is 0', () => {
    const product = makeProduct();
    const item = makeItem({ actual_rate: 0 });
    const result = recalcItem(item, product, 1, conversions);

    expect(result.oz_per_acre).toBe(0);
    expect(result.total_units_needed).toBe(0);
    expect(result.total_price).toBe(0);
    expect(result.profit).toBe(0);
    expect(result.net_margin).toBe(0);
  });

  it('returns 0s when acres is 0', () => {
    const product = makeProduct();
    const item = makeItem({ acres: 0 });
    const result = recalcItem(item, product, 1, conversions);

    expect(result.total_units_needed).toBe(0);
    expect(result.total_price).toBe(0);
    expect(result.profit).toBe(0);
    expect(result.net_margin).toBe(0);
  });

  it('returns 0s when acres is null', () => {
    const product = makeProduct();
    const item = makeItem({ acres: null });
    const result = recalcItem(item, product, 1, conversions);

    expect(result.total_units_needed).toBe(0);
    expect(result.total_price).toBe(0);
  });

  it('handles null rate_unit (defaults factor to 1)', () => {
    const product = makeProduct({ inventory_unit: 'Gallon' });
    const item = makeItem({
      actual_rate: 128,
      rate_unit: null,
      acres: 10,
    });
    const result = recalcItem(item, product, 1, conversions);

    // 128 × 1 (null→1) = 128 oz/acre
    // 10 × 128 / 128 = 10 gal
    expect(result.total_units_needed).toBe(10);
  });

  it('handles product with zero cost (100% margin)', () => {
    const product = makeProduct({ current_cost: 0, tier1_price: 20, inventory_unit: 'Gallon' });
    const item = makeItem({ actual_rate: 128, rate_unit: 'fl oz', acres: 10 });
    const result = recalcItem(item, product, 1, conversions);

    // 10 gal × $20 = $200
    expect(result.total_price).toBe(200);
    // (20 - 0) × 10 = $200 profit
    expect(result.profit).toBe(200);
    // 200/200 = 100%
    expect(result.net_margin).toBe(100);
  });

  it('handles negative margin (cost > price)', () => {
    const product = makeProduct({ current_cost: 25, tier1_price: 20, inventory_unit: 'Gallon' });
    const item = makeItem({ actual_rate: 128, rate_unit: 'fl oz', acres: 10 });
    const result = recalcItem(item, product, 1, conversions);

    // 10 gal × $20 = $200 revenue
    expect(result.total_price).toBe(200);
    // (20 - 25) × 10 = -$50 (loss)
    expect(result.profit).toBe(-50);
    // -50/200 = -25%
    expect(result.net_margin).toBe(-25);
  });

  it('handles 1 pint/acre correctly (16 oz)', () => {
    const product = makeProduct({ inventory_unit: 'Gallon', tier1_price: 40, current_cost: 20 });
    const item = makeItem({ actual_rate: 1, rate_unit: 'Pint', acres: 80 });
    const result = recalcItem(item, product, 1, conversions);

    // 1 pint = 16 oz/acre
    expect(result.oz_per_acre).toBe(16);
    // 80 × 16 / 128 = 10 gal
    expect(result.total_units_needed).toBe(10);
    // 10 × 40 = $400
    expect(result.total_price).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// computeQuoteTotals
// ---------------------------------------------------------------------------

describe('computeQuoteTotals', () => {
  it('computes totals across multiple items', () => {
    const items: CalcItem[] = [
      makeItem({ total_price: 500, current_cost: 10, total_units_needed: 25 }),
      makeItem({ total_price: 300, current_cost: 5, total_units_needed: 20 }),
    ];

    const totals = computeQuoteTotals(items);

    expect(totals.totalPrice).toBe(800);
    // Cost: (10×25) + (5×20) = 250 + 100 = 350
    expect(totals.totalCost).toBe(350);
    // Profit: 800 - 350 = 450
    expect(totals.totalProfit).toBe(450);
    // Margin: 450/800 = 56.25%
    expect(totals.totalMarginPct).toBe(56.25);
  });

  it('returns 0s for empty items', () => {
    const totals = computeQuoteTotals([]);
    expect(totals.totalPrice).toBe(0);
    expect(totals.totalCost).toBe(0);
    expect(totals.totalProfit).toBe(0);
    expect(totals.totalMarginPct).toBe(0);
  });

  it('handles items with zero total_units_needed', () => {
    const items: CalcItem[] = [
      makeItem({ total_price: 0, current_cost: 10, total_units_needed: 0 }),
    ];
    const totals = computeQuoteTotals(items);
    expect(totals.totalMarginPct).toBe(0);
  });

  // --- NaN guard tests (production hardening) ---

  it('handles items with undefined total_price without producing NaN', () => {
    const items: CalcItem[] = [
      makeItem({ total_price: undefined as unknown as number, current_cost: 10, total_units_needed: 5 }),
      makeItem({ total_price: 200, current_cost: 8, total_units_needed: 10 }),
    ];
    const totals = computeQuoteTotals(items);
    expect(Number.isFinite(totals.totalPrice)).toBe(true);
    expect(totals.totalPrice).toBe(200);
    expect(Number.isFinite(totals.totalCost)).toBe(true);
    expect(totals.totalCost).toBe(130); // (10*5) + (8*10)
  });

  it('handles items with undefined current_cost without producing NaN', () => {
    const items: CalcItem[] = [
      makeItem({ total_price: 100, current_cost: undefined as unknown as number, total_units_needed: 5 }),
    ];
    const totals = computeQuoteTotals(items);
    expect(Number.isFinite(totals.totalCost)).toBe(true);
    expect(totals.totalCost).toBe(0);
    expect(totals.totalPrice).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// validateCommissionSplits
// ---------------------------------------------------------------------------

describe('validateCommissionSplits', () => {
  it('returns null for splits summing to 100%', () => {
    expect(
      validateCommissionSplits([
        { recipient: 'Alice', percentage: 60 },
        { recipient: 'Bob', percentage: 40 },
      ])
    ).toBeNull();
  });

  it('returns error for splits summing to < 100%', () => {
    const result = validateCommissionSplits([
      { recipient: 'Alice', percentage: 50 },
      { recipient: 'Bob', percentage: 30 },
    ]);
    expect(result).toContain('80.00%');
  });

  it('returns error for splits summing to > 100%', () => {
    const result = validateCommissionSplits([
      { recipient: 'Alice', percentage: 60 },
      { recipient: 'Bob', percentage: 50 },
    ]);
    expect(result).toContain('110.00%');
  });

  it('returns null for empty splits', () => {
    expect(validateCommissionSplits([])).toBeNull();
  });

  it('handles single 100% split', () => {
    expect(
      validateCommissionSplits([{ recipient: 'Solo', percentage: 100 }])
    ).toBeNull();
  });

  it('tolerates floating point rounding (33.33 + 33.33 + 33.34)', () => {
    expect(
      validateCommissionSplits([
        { recipient: 'A', percentage: 33.33 },
        { recipient: 'B', percentage: 33.33 },
        { recipient: 'C', percentage: 33.34 },
      ])
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// convertToGlLb
// ---------------------------------------------------------------------------

describe('convertToGlLb', () => {
  // ── Liquid conversions ───────────────────────────────────────────────

  it('converts OZ to GL for liquid (÷128)', () => {
    const result = convertToGlLb(256, 'OZ', 'liquid');
    expect(result).toEqual({ value: 2, unit: 'GL' });
  });

  it('converts PT to GL for liquid (÷8)', () => {
    const result = convertToGlLb(16, 'PT', 'liquid');
    expect(result).toEqual({ value: 2, unit: 'GL' });
  });

  it('converts QT to GL for liquid (÷4)', () => {
    const result = convertToGlLb(8, 'QT', 'liquid');
    expect(result).toEqual({ value: 2, unit: 'GL' });
  });

  it('passes through GL for liquid', () => {
    const result = convertToGlLb(5, 'GL', 'liquid');
    expect(result).toEqual({ value: 5, unit: 'GL' });
  });

  it('treats unknown liquid unit as OZ→GL', () => {
    const result = convertToGlLb(128, 'EACH', 'liquid');
    expect(result).toEqual({ value: 1, unit: 'GL' });
  });

  // ── Dry conversions ─────────────────────────────────────────────────

  it('converts OZ to LB for dry (÷16)', () => {
    const result = convertToGlLb(32, 'OZ', 'dry');
    expect(result).toEqual({ value: 2, unit: 'LB' });
  });

  it('passes through LB for dry', () => {
    const result = convertToGlLb(10, 'LB', 'dry');
    expect(result).toEqual({ value: 10, unit: 'LB' });
  });

  it('treats unknown dry unit as LB pass-through', () => {
    const result = convertToGlLb(5, 'BAG', 'dry');
    expect(result).toEqual({ value: 5, unit: 'LB' });
  });

  // ── Null / undefined / empty unit (Sprint B fix) ────────────────────

  it('defaults null unit to OZ for liquid', () => {
    const result = convertToGlLb(128, null, 'liquid');
    expect(result).toEqual({ value: 1, unit: 'GL' });
  });

  it('defaults undefined unit to OZ for liquid', () => {
    const result = convertToGlLb(128, undefined, 'liquid');
    expect(result).toEqual({ value: 1, unit: 'GL' });
  });

  it('defaults empty string unit to OZ for liquid', () => {
    const result = convertToGlLb(128, '', 'liquid');
    expect(result).toEqual({ value: 1, unit: 'GL' });
  });

  it('defaults null unit to OZ for dry', () => {
    const result = convertToGlLb(16, null, 'dry');
    expect(result).toEqual({ value: 1, unit: 'LB' });
  });

  // ── Case insensitivity ──────────────────────────────────────────────

  it('handles lowercase unit strings', () => {
    expect(convertToGlLb(4, 'qt', 'liquid')).toEqual({ value: 1, unit: 'GL' });
    expect(convertToGlLb(16, 'oz', 'dry')).toEqual({ value: 1, unit: 'LB' });
  });

  it('handles mixed-case unit strings', () => {
    expect(convertToGlLb(8, 'Pt', 'liquid')).toEqual({ value: 1, unit: 'GL' });
  });

  // ── Zero value ──────────────────────────────────────────────────────

  it('handles zero totalApplied', () => {
    expect(convertToGlLb(0, 'QT', 'liquid')).toEqual({ value: 0, unit: 'GL' });
    expect(convertToGlLb(0, 'OZ', 'dry')).toEqual({ value: 0, unit: 'LB' });
  });
});
