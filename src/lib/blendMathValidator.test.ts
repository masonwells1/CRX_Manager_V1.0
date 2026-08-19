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

  describe('mixed-unit total volume', () => {
    // `quantity` values are not additive across units, and `unit_conversions`
    // cannot bridge them: factor_oz is within-family only (Lb = 16 DRY oz,
    // Gal = 128 FLUID oz). The check is skipped and says so.
    it('skips the total-volume check on a liquid+dry mixed ticket instead of summing', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 10, total_volume_unit: 'Gal' },
        [
          { product_name: 'Liquid A', quantity: 10, unit: 'Gal', rate_per_acre: null, rate_per_acre_unit: null },
          { product_name: 'Liquid B', quantity: 32, unit: 'oz', rate_per_acre: null, rate_per_acre_unit: null },
          { product_name: 'Dry C', quantity: 5, unit: 'Lb', rate_per_acre: null, rate_per_acre_unit: null },
        ]
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('Total volume not checked');
      expect(warnings[0]).toContain('Gal');
      expect(warnings[0]).toContain('oz');
      expect(warnings[0]).toContain('Lb');
      // The old code summed 10 + 32 + 5 = 47 and compared it to 10.
      expect(warnings[0]).not.toContain('47');
    });

    it('does not mask a real mismatch that unit-blind cancellation would hide', () => {
      // Unit-blind sum is 100 + 200 = 300, which matches total_volume 300 exactly
      // and produced NO warning before. The units disagree, so it is not a match.
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 300, total_volume_unit: 'Gal' },
        [
          { product_name: 'A', quantity: 100, unit: 'Gal', rate_per_acre: null, rate_per_acre_unit: null },
          { product_name: 'B', quantity: 200, unit: 'oz', rate_per_acre: null, rate_per_acre_unit: null },
        ]
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('Total volume not checked');
    });

    it('warns when products agree with each other but not with the ticket unit', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 300, total_volume_unit: 'Gal' },
        [
          { product_name: 'A', quantity: 150, unit: 'oz', rate_per_acre: null, rate_per_acre_unit: null },
          { product_name: 'B', quantity: 150, unit: 'oz', rate_per_acre: null, rate_per_acre_unit: null },
        ]
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('Total volume not checked');
    });

    it('still compares when units differ only by case (frozen-key aliases)', () => {
      // 'Gal' and 'gal' are the same unit; 'Lb'/'LB' and 'oz'/'Oz' are deliberate
      // case aliases in unit_conversions with identical factors.
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 300, total_volume_unit: 'Gal' },
        [
          { product_name: 'A', quantity: 100, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null },
          { product_name: 'B', quantity: 200, unit: 'GAL', rate_per_acre: null, rate_per_acre_unit: null },
        ]
      );
      expect(warnings).toHaveLength(0);
    });

    it('treats surrounding whitespace as the same unit', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 300, total_volume_unit: ' gal ' },
        [
          { product_name: 'A', quantity: 100, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null },
          { product_name: 'B', quantity: 100, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null },
        ]
      );
      // Units agree, so the real 200-vs-300 mismatch is still reported.
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('200.00');
    });

    it('keeps comparing legacy tickets that record no units at all', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 300, total_volume_unit: null },
        [
          { product_name: 'A', quantity: 100, unit: null, rate_per_acre: null, rate_per_acre_unit: null },
          { product_name: 'B', quantity: 100, unit: '', rate_per_acre: null, rate_per_acre_unit: null },
        ]
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('200.00');
    });

    it('treats a blank product unit alongside a recorded one as unknown, not mixed', () => {
      // A half-filled row must not fire the mixed-unit notice on its own.
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 300, total_volume_unit: 'gal' },
        [
          { product_name: 'A', quantity: 100, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null },
          { product_name: 'B', quantity: 200, unit: null, rate_per_acre: null, rate_per_acre_unit: null },
        ]
      );
      expect(warnings).toHaveLength(0);
    });

    it('stays silent on a mixed-unit ticket before any quantity is entered', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 300, total_volume_unit: 'Gal' },
        [
          { product_name: 'A', quantity: 0, unit: 'Gal', rate_per_acre: null, rate_per_acre_unit: null },
          { product_name: 'B', quantity: 0, unit: 'Lb', rate_per_acre: null, rate_per_acre_unit: null },
        ]
      );
      expect(warnings).toHaveLength(0);
    });

    it('reports each distinct unit only once', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 10, total_volume_unit: 'Gal' },
        [
          { product_name: 'A', quantity: 5, unit: 'Gal', rate_per_acre: null, rate_per_acre_unit: null },
          { product_name: 'B', quantity: 5, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null },
          { product_name: 'C', quantity: 5, unit: 'Lb', rate_per_acre: null, rate_per_acre_unit: null },
        ]
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('Gal, Lb');
    });

    it('treats fl oz and oz as the same unit and still compares', () => {
      // unit_conversions records 'oz' as an alias for 'fl oz' — same unit_type
      // (liquid) and same factor_oz — so these quantities really are additive.
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 300, total_volume_unit: 'fl oz' },
        [
          { product_name: 'A', quantity: 100, unit: 'oz', rate_per_acre: null, rate_per_acre_unit: null },
          { product_name: 'B', quantity: 100, unit: 'fl oz', rate_per_acre: null, rate_per_acre_unit: null },
        ]
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('200.00');
      expect(warnings[0]).not.toContain('not checked');
    });

    it('treats Unit and Ea as the same unit and still compares', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 300, total_volume_unit: 'Ea' },
        [
          { product_name: 'A', quantity: 150, unit: 'Unit', rate_per_acre: null, rate_per_acre_unit: null },
          { product_name: 'B', quantity: 150, unit: 'Ea', rate_per_acre: null, rate_per_acre_unit: null },
        ]
      );
      expect(warnings).toHaveLength(0);
    });

    it('does not merge oz with Dry oz, which are different unit types', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 300, total_volume_unit: 'oz' },
        [
          { product_name: 'A', quantity: 150, unit: 'oz', rate_per_acre: null, rate_per_acre_unit: null },
          { product_name: 'B', quantity: 150, unit: 'Dry oz', rate_per_acre: null, rate_per_acre_unit: null },
        ]
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('Total volume not checked');
    });

    it('ignores the unit of a half-entered row that has no quantity yet', () => {
      // The 'Lb' row contributes nothing to the sum, so it must not disable the
      // check for the rows that are fully entered.
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 300, total_volume_unit: 'Gal' },
        [
          { product_name: 'A', quantity: 100, unit: 'Gal', rate_per_acre: null, rate_per_acre_unit: null },
          { product_name: 'B', quantity: 200, unit: 'Gal', rate_per_acre: null, rate_per_acre_unit: null },
          { product_name: 'C', quantity: 0, unit: 'Lb', rate_per_acre: null, rate_per_acre_unit: null },
        ]
      );
      expect(warnings).toHaveLength(0);
    });

    it('reports a real mismatch even when a half-entered row uses another unit', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 300, total_volume_unit: 'Gal' },
        [
          { product_name: 'A', quantity: 100, unit: 'Gal', rate_per_acre: null, rate_per_acre_unit: null },
          { product_name: 'C', quantity: 0, unit: 'Lb', rate_per_acre: null, rate_per_acre_unit: null },
        ]
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('100.00');
      expect(warnings[0]).toContain('300');
    });

    it('still reports per-product rate warnings on a mixed-unit ticket', () => {
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: 10, total_volume_unit: 'Gal' },
        [
          { product_name: 'Atrazine', quantity: 999, unit: 'Gal', rate_per_acre: 2, rate_per_acre_unit: 'Gal' },
          { product_name: 'Dry C', quantity: 5, unit: 'Lb', rate_per_acre: null, rate_per_acre_unit: null },
        ]
      );
      expect(warnings).toHaveLength(2);
      expect(warnings.some((w) => w.includes('Atrazine'))).toBe(true);
      expect(warnings.some((w) => w.includes('Total volume not checked'))).toBe(true);
    });
  });
});
