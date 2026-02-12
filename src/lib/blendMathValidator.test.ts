import { describe, it, expect } from 'vitest';
import { validateBlendMath } from './blendMathValidator';

describe('validateBlendMath', () => {
  describe('per-product rate × acres validation', () => {
    it('returns no warnings when quantity matches rate × acres', () => {
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: null, total_volume_unit: null },
        [
          { product_name: 'Atrazine', quantity: 200, unit: 'oz', rate_per_acre: 2, rate_per_acre_unit: 'oz' },
        ]
      );
      expect(warnings).toHaveLength(0);
    });

    it('warns when quantity deviates > 5% from expected', () => {
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: null, total_volume_unit: null },
        [
          { product_name: 'Atrazine', quantity: 250, unit: 'oz', rate_per_acre: 2, rate_per_acre_unit: 'oz' },
        ]
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('Atrazine');
      expect(warnings[0]).toContain('250');
      expect(warnings[0]).toContain('200');
    });

    it('passes within 5% tolerance', () => {
      // 2 × 100 = 200 expected, 209 is 4.5% off (within 5%)
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: null, total_volume_unit: null },
        [
          { product_name: 'Product A', quantity: 209, unit: 'oz', rate_per_acre: 2, rate_per_acre_unit: 'oz' },
        ]
      );
      expect(warnings).toHaveLength(0);
    });

    it('skips products with zero rate_per_acre', () => {
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: null, total_volume_unit: null },
        [
          { product_name: 'Water', quantity: 500, unit: 'gal', rate_per_acre: 0, rate_per_acre_unit: null },
        ]
      );
      expect(warnings).toHaveLength(0);
    });

    it('skips when total_acres is null', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: null, total_volume_unit: null },
        [
          { product_name: 'Atrazine', quantity: 250, unit: 'oz', rate_per_acre: 2, rate_per_acre_unit: 'oz' },
        ]
      );
      expect(warnings).toHaveLength(0);
    });

    it('skips when total_acres is 0', () => {
      const warnings = validateBlendMath(
        { total_acres: 0, total_volume: null, total_volume_unit: null },
        [
          { product_name: 'Atrazine', quantity: 250, unit: 'oz', rate_per_acre: 2, rate_per_acre_unit: 'oz' },
        ]
      );
      expect(warnings).toHaveLength(0);
    });
  });

  describe('total volume validation', () => {
    it('returns no warnings when sum of quantities matches total volume', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 300, total_volume_unit: 'gal' },
        [
          { product_name: 'A', quantity: 100, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null },
          { product_name: 'B', quantity: 200, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null },
        ]
      );
      expect(warnings).toHaveLength(0);
    });

    it('warns when sum deviates > 5% from total volume', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 300, total_volume_unit: 'gal' },
        [
          { product_name: 'A', quantity: 100, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null },
          { product_name: 'B', quantity: 100, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null },
        ]
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('200.00');
      expect(warnings[0]).toContain('300');
    });

    it('skips when total_volume is null', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: null, total_volume_unit: null },
        [
          { product_name: 'A', quantity: 100, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null },
        ]
      );
      expect(warnings).toHaveLength(0);
    });
  });

  describe('combined validation', () => {
    it('can return warnings for both rate and volume mismatch', () => {
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: 500, total_volume_unit: 'gal' },
        [
          { product_name: 'A', quantity: 999, unit: 'gal', rate_per_acre: 2, rate_per_acre_unit: 'oz' },
        ]
      );
      // Rate mismatch: 999 vs 200
      // Volume mismatch: 999 vs 500
      expect(warnings.length).toBeGreaterThanOrEqual(2);
    });

    it('returns empty array when all checks pass', () => {
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: 400, total_volume_unit: 'oz' },
        [
          { product_name: 'A', quantity: 200, unit: 'oz', rate_per_acre: 2, rate_per_acre_unit: 'oz' },
          { product_name: 'B', quantity: 200, unit: 'oz', rate_per_acre: 2, rate_per_acre_unit: 'oz' },
        ]
      );
      expect(warnings).toHaveLength(0);
    });
  });
});
