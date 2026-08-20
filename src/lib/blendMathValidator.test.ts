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

    // The unit fields are free text and a new product row starts with unit '',
    // so "quantity typed, unit left blank" is a likely real state. That quantity
    // is already inside the sum, so treating it as agreeing with the ticket unit
    // would mask exactly the cross-unit mismatch this check exists to catch:
    // if the 200 below is pounds, 100 + 200 = 300 "matches" 300 gal by accident.
    it('refuses to compare when a contributing row has a quantity but no unit', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 300, total_volume_unit: 'gal' },
        [
          { product_name: 'A', quantity: 100, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null },
          { product_name: 'B', quantity: 200, unit: null, rate_per_acre: null, rate_per_acre_unit: null },
        ]
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('quantity but no unit');
    });

    // The other half of the same hole, found by CodeRabbit on PR #426. Products in
    // Gal against a total with no unit is not a match — the total's unit is simply
    // unknown. This is the shape EVERY scanned ticket arrives in, because the OCR
    // importer writes total_volume and never writes total_volume_unit.
    it('refuses to compare when the products have units but the ticket total does not', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 300, total_volume_unit: '' },
        [
          { product_name: 'A', quantity: 100, unit: 'Gal', rate_per_acre: null, rate_per_acre_unit: null },
          { product_name: 'B', quantity: 200, unit: 'Gal', rate_per_acre: null, rate_per_acre_unit: null },
        ]
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("total volume doesn't");
    });

    it('refuses a null ticket total unit the same way as a blank one', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 250, total_volume_unit: null },
        [{ product_name: 'A', quantity: 300, unit: 'Lb', rate_per_acre: null, rate_per_acre_unit: null }]
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('Total volume not checked');
      // Must NOT report the old numeric mismatch, which would be a guess.
      expect(warnings[0]).not.toContain('300.00');
    });

    it('treats a whitespace-only unit as not recorded, not as its own unit', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 300, total_volume_unit: 'gal' },
        [
          { product_name: 'A', quantity: 100, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null },
          { product_name: 'B', quantity: 200, unit: '   ', rate_per_acre: null, rate_per_acre_unit: null },
        ]
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('quantity but no unit');
    });

    it('ignores a blank unit on a row that contributes nothing to the sum', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 300, total_volume_unit: 'gal' },
        [
          { product_name: 'A', quantity: 300, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null },
          { product_name: 'B', quantity: 0, unit: null, rate_per_acre: null, rate_per_acre_unit: null },
        ]
      );
      expect(warnings).toHaveLength(0);
    });

    it('strips periods so an abbreviation still matches its plain spelling', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 300, total_volume_unit: 'gal' },
        [
          { product_name: 'A', quantity: 100, unit: 'gal.', rate_per_acre: null, rate_per_acre_unit: null },
          { product_name: 'B', quantity: 200, unit: 'Gal', rate_per_acre: null, rate_per_acre_unit: null },
        ]
      );
      expect(warnings).toHaveLength(0);
    });

    it('collapses interior whitespace so "fl.  oz" still matches "oz"', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 300, total_volume_unit: 'oz' },
        [
          { product_name: 'A', quantity: 100, unit: 'fl.  oz', rate_per_acre: null, rate_per_acre_unit: null },
          { product_name: 'B', quantity: 200, unit: 'oz', rate_per_acre: null, rate_per_acre_unit: null },
        ]
      );
      expect(warnings).toHaveLength(0);
    });

    // Found by the gpt-5.6-sol review of PR #426. A zero-width character pasted
    // from a PDF sits INSIDE the abbreviation. Replacing it with a space split
    // 'gal' into 'g al', which matched nothing: the check was skipped and the
    // message listed two units that look identical on screen. Zero-width means
    // zero-width — it must be deleted, not turned into a separator.
    const ZWSP = String.fromCharCode(0x200b);
    const ZWNJ = String.fromCharCode(0x200c);
    const BOM = String.fromCharCode(0xfeff);

    it('deletes a zero-width character inside an abbreviation instead of splitting it', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 300, total_volume_unit: 'gal' },
        [
          { product_name: 'A', quantity: 100, unit: `g${ZWSP}al`, rate_per_acre: null, rate_per_acre_unit: null },
          { product_name: 'B', quantity: 200, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null },
        ]
      );
      // Same unit, and 100 + 200 = 300 matches, so there is nothing to say at all.
      expect(warnings).toHaveLength(0);
    });

    it('deletes the zero-width non-joiner and the BOM the same way', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 300, total_volume_unit: `g${BOM}al` },
        [
          { product_name: 'A', quantity: 100, unit: `g${ZWNJ}al`, rate_per_acre: null, rate_per_acre_unit: null },
          { product_name: 'B', quantity: 200, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null },
        ]
      );
      expect(warnings).toHaveLength(0);
    });

    it('still reports a real mismatch through a zero-width character', () => {
      // Deleting the character must not also swallow the comparison it enables.
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 300, total_volume_unit: 'gal' },
        [{ product_name: 'A', quantity: 100, unit: `g${ZWSP}al`, rate_per_acre: null, rate_per_acre_unit: null }]
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('100.00');
      expect(warnings[0]).not.toContain('not checked');
    });

    it('treats a unit made only of zero-width characters as not recorded', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 300, total_volume_unit: 'gal' },
        [
          { product_name: 'A', quantity: 100, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null },
          { product_name: 'B', quantity: 200, unit: `${ZWSP}${BOM}`, rate_per_acre: null, rate_per_acre_unit: null },
        ]
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('quantity but no unit');
    });

    it('still keeps genuinely different units apart across a zero-width character', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 300, total_volume_unit: 'gal' },
        [
          { product_name: 'A', quantity: 100, unit: `g${ZWSP}al`, rate_per_acre: null, rate_per_acre_unit: null },
          { product_name: 'B', quantity: 200, unit: 'Lb', rate_per_acre: null, rate_per_acre_unit: null },
        ]
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('not all the same unit');
    });

    it('does not let a unit named like an Object property inherit a value', () => {
      // 'constructor' must behave like any other unrecognised free-text unit.
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 300, total_volume_unit: 'constructor' },
        [
          { product_name: 'A', quantity: 300, unit: 'constructor', rate_per_acre: null, rate_per_acre_unit: null },
        ]
      );
      expect(warnings).toHaveLength(0);
    });

    // Guards the `sumQuantities > 0` gate rather than the unit logic: with both
    // quantities still 0 there is nothing to compare, so the ticket stays quiet
    // while it is being filled in.
    it('stays silent before any quantity is entered, whatever the units say', () => {
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
