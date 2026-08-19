import { describe, it, expect } from 'vitest';
import { validateBlendMath } from './blendMathValidator';

describe('validateBlendMath', () => {
  describe('per-product rate × acres validation', () => {
    it('returns no warnings when quantity matches rate × acres', () => {
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: null, total_volume_unit: null },
        [
          { product_name: 'Atrazine', quantity: 200, unit: 'oz', rate_per_acre: 2, rate_per_acre_unit: 'oz', product_form: null, product_rate_unit: null, product_inventory_unit: null },
        ]
      );
      expect(warnings).toHaveLength(0);
    });

    it('warns when quantity deviates > 5% from expected', () => {
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: null, total_volume_unit: null },
        [
          { product_name: 'Atrazine', quantity: 250, unit: 'oz', rate_per_acre: 2, rate_per_acre_unit: 'oz', product_form: null, product_rate_unit: null, product_inventory_unit: null },
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
          { product_name: 'Product A', quantity: 209, unit: 'oz', rate_per_acre: 2, rate_per_acre_unit: 'oz', product_form: null, product_rate_unit: null, product_inventory_unit: null },
        ]
      );
      expect(warnings).toHaveLength(0);
    });

    it('skips products with zero rate_per_acre', () => {
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: null, total_volume_unit: null },
        [
          { product_name: 'Water', quantity: 500, unit: 'gal', rate_per_acre: 0, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
        ]
      );
      expect(warnings).toHaveLength(0);
    });

    it('skips when total_acres is null', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: null, total_volume_unit: null },
        [
          { product_name: 'Atrazine', quantity: 250, unit: 'oz', rate_per_acre: 2, rate_per_acre_unit: 'oz', product_form: null, product_rate_unit: null, product_inventory_unit: null },
        ]
      );
      expect(warnings).toHaveLength(0);
    });

    it('skips when total_acres is 0', () => {
      const warnings = validateBlendMath(
        { total_acres: 0, total_volume: null, total_volume_unit: null },
        [
          { product_name: 'Atrazine', quantity: 250, unit: 'oz', rate_per_acre: 2, rate_per_acre_unit: 'oz', product_form: null, product_rate_unit: null, product_inventory_unit: null },
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
          { product_name: 'A', quantity: 100, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
          { product_name: 'B', quantity: 200, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
        ]
      );
      expect(warnings).toHaveLength(0);
    });

    it('warns when sum deviates > 5% from total volume', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 300, total_volume_unit: 'gal' },
        [
          { product_name: 'A', quantity: 100, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
          { product_name: 'B', quantity: 100, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
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
          { product_name: 'A', quantity: 100, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
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
          { product_name: 'A', quantity: 999, unit: 'gal', rate_per_acre: 2, rate_per_acre_unit: 'oz', product_form: null, product_rate_unit: null, product_inventory_unit: null },
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
          { product_name: 'A', quantity: 200, unit: 'oz', rate_per_acre: 2, rate_per_acre_unit: 'oz', product_form: null, product_rate_unit: null, product_inventory_unit: null },
          { product_name: 'B', quantity: 200, unit: 'oz', rate_per_acre: 2, rate_per_acre_unit: 'oz', product_form: null, product_rate_unit: null, product_inventory_unit: null },
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
          { product_name: 'Liquid A', quantity: 10, unit: 'Gal', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
          { product_name: 'Liquid B', quantity: 32, unit: 'oz', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
          { product_name: 'Dry C', quantity: 5, unit: 'Lb', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
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
          { product_name: 'A', quantity: 100, unit: 'Gal', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
          { product_name: 'B', quantity: 200, unit: 'oz', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
        ]
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('Total volume not checked');
    });

    it('warns when products agree with each other but not with the ticket unit', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 300, total_volume_unit: 'Gal' },
        [
          { product_name: 'A', quantity: 150, unit: 'oz', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
          { product_name: 'B', quantity: 150, unit: 'oz', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
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
          { product_name: 'A', quantity: 100, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
          { product_name: 'B', quantity: 200, unit: 'GAL', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
        ]
      );
      expect(warnings).toHaveLength(0);
    });

    it('treats surrounding whitespace as the same unit', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 300, total_volume_unit: ' gal ' },
        [
          { product_name: 'A', quantity: 100, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
          { product_name: 'B', quantity: 100, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
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
          { product_name: 'A', quantity: 100, unit: null, rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
          { product_name: 'B', quantity: 100, unit: '', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
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
          { product_name: 'A', quantity: 100, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
          { product_name: 'B', quantity: 200, unit: null, rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
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
          { product_name: 'A', quantity: 100, unit: 'Gal', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
          { product_name: 'B', quantity: 200, unit: 'Gal', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
        ]
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("total volume doesn't");
    });

    it('refuses a null ticket total unit the same way as a blank one', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 250, total_volume_unit: null },
        [{ product_name: 'A', quantity: 300, unit: 'Lb', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null }]
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
          { product_name: 'A', quantity: 100, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
          { product_name: 'B', quantity: 200, unit: '   ', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
        ]
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('quantity but no unit');
    });

    it('ignores a blank unit on a row that contributes nothing to the sum', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 300, total_volume_unit: 'gal' },
        [
          { product_name: 'A', quantity: 300, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
          { product_name: 'B', quantity: 0, unit: null, rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
        ]
      );
      expect(warnings).toHaveLength(0);
    });

    it('strips periods so an abbreviation still matches its plain spelling', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 300, total_volume_unit: 'gal' },
        [
          { product_name: 'A', quantity: 100, unit: 'gal.', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
          { product_name: 'B', quantity: 200, unit: 'Gal', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
        ]
      );
      expect(warnings).toHaveLength(0);
    });

    it('collapses interior whitespace so "fl.  oz" still matches "oz"', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 300, total_volume_unit: 'oz' },
        [
          { product_name: 'A', quantity: 100, unit: 'fl.  oz', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
          { product_name: 'B', quantity: 200, unit: 'oz', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
        ]
      );
      expect(warnings).toHaveLength(0);
    });

    it('does not let a unit named like an Object property inherit a value', () => {
      // 'constructor' must behave like any other unrecognised free-text unit.
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 300, total_volume_unit: 'constructor' },
        [
          { product_name: 'A', quantity: 300, unit: 'constructor', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
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
          { product_name: 'A', quantity: 0, unit: 'Gal', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
          { product_name: 'B', quantity: 0, unit: 'Lb', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
        ]
      );
      expect(warnings).toHaveLength(0);
    });

    it('reports each distinct unit only once', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 10, total_volume_unit: 'Gal' },
        [
          { product_name: 'A', quantity: 5, unit: 'Gal', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
          { product_name: 'B', quantity: 5, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
          { product_name: 'C', quantity: 5, unit: 'Lb', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
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
          { product_name: 'A', quantity: 100, unit: 'oz', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
          { product_name: 'B', quantity: 100, unit: 'fl oz', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
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
          { product_name: 'A', quantity: 150, unit: 'Unit', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
          { product_name: 'B', quantity: 150, unit: 'Ea', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
        ]
      );
      expect(warnings).toHaveLength(0);
    });

    it('does not merge oz with Dry oz, which are different unit types', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 300, total_volume_unit: 'oz' },
        [
          { product_name: 'A', quantity: 150, unit: 'oz', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
          { product_name: 'B', quantity: 150, unit: 'Dry oz', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
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
          { product_name: 'A', quantity: 100, unit: 'Gal', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
          { product_name: 'B', quantity: 200, unit: 'Gal', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
          { product_name: 'C', quantity: 0, unit: 'Lb', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
        ]
      );
      expect(warnings).toHaveLength(0);
    });

    it('reports a real mismatch even when a half-entered row uses another unit', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 300, total_volume_unit: 'Gal' },
        [
          { product_name: 'A', quantity: 100, unit: 'Gal', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
          { product_name: 'C', quantity: 0, unit: 'Lb', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
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
          { product_name: 'Atrazine', quantity: 999, unit: 'Gal', rate_per_acre: 2, rate_per_acre_unit: 'Gal', product_form: null, product_rate_unit: null, product_inventory_unit: null },
          { product_name: 'Dry C', quantity: 5, unit: 'Lb', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
        ]
      );
      expect(warnings).toHaveLength(2);
      expect(warnings.some((w) => w.includes('Atrazine'))).toBe(true);
      expect(warnings.some((w) => w.includes('Total volume not checked'))).toBe(true);
    });
  });

  // The rate arm feeds BILLING: create_invoice_from_blend_ticket prices each line
  // from rate_per_acre and its unit, never from quantity. These cases pin the check
  // to the same conversion rules the invoice uses, so the two can never disagree.
  describe('unit-aware rate check (billing parity)', () => {
    const liquid = { product_form: 'liquid', product_rate_unit: null, product_inventory_unit: null };
    const dry = { product_form: 'dry', product_rate_unit: null, product_inventory_unit: null };

    it('converts within the liquid family: 2 gal/ac over 100 ac = 25600 oz', () => {
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: null, total_volume_unit: null },
        [{ product_name: 'A', quantity: 25600, unit: 'oz', rate_per_acre: 2, rate_per_acre_unit: 'gal', ...liquid }]
      );
      expect(warnings).toHaveLength(0);
    });

    it('flags a real mismatch after converting, rather than comparing bare numbers', () => {
      // 2 gal/ac × 100 ac = 200 gal = 25600 oz. Entering 200 oz is a 128x error that
      // the old unit-blind check called a perfect match.
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: null, total_volume_unit: null },
        [{ product_name: 'A', quantity: 200, unit: 'oz', rate_per_acre: 2, rate_per_acre_unit: 'gal', ...liquid }]
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('25600.00');
    });

    // Mason, 2026-08-19: "oz" against a DRY product means a weight ounce.
    it('reads oz as a WEIGHT ounce for a dry product', () => {
      // 2 lb/ac × 100 ac = 200 lb = 3200 dry oz.
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: null, total_volume_unit: null },
        [{ product_name: 'Dry A', quantity: 3200, unit: 'oz', rate_per_acre: 2, rate_per_acre_unit: 'lb', ...dry }]
      );
      expect(warnings).toHaveLength(0);
    });

    it('refuses the same lb-to-oz pairing on a LIQUID product instead of guessing', () => {
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: null, total_volume_unit: null },
        [{ product_name: 'A', quantity: 3200, unit: 'oz', rate_per_acre: 2, rate_per_acre_unit: 'lb', ...liquid }]
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('Not checked');
    });

    // Billing does COALESCE(NULLIF(btrim(rate_per_acre_unit),''), p.rate_unit) and
    // charges. Recipe-applied rows ALWAYS arrive with a blank rate unit, so going
    // silent here would abandon exactly the rows that still bill.
    it('falls back to the product default rate unit when the line leaves it blank', () => {
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: null, total_volume_unit: null },
        [{
          product_name: 'A', quantity: 200, unit: 'oz', rate_per_acre: 2, rate_per_acre_unit: '',
          product_form: 'liquid', product_rate_unit: 'gal', product_inventory_unit: null,
        }]
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('25600.00');
    });

    it('strips a per-acre suffix so pt/ac matches a pt quantity', () => {
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: null, total_volume_unit: null },
        [{ product_name: 'A', quantity: 200, unit: 'pt', rate_per_acre: 2, rate_per_acre_unit: 'pt/ac', ...liquid }]
      );
      expect(warnings).toHaveLength(0);
    });

    // The live normalize_rate_unit keeps a non-acre denominator whole so it cannot
    // match a bare unit. chemCalculator's baseUnitOfRate would read this as 'oz' and
    // claim a conversion the invoice rejects — silence here, hard error at billing.
    it('refuses a non-acre denominator rather than reading oz/cwt as oz', () => {
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: null, total_volume_unit: null },
        [{ product_name: 'A', quantity: 200, unit: 'oz', rate_per_acre: 2, rate_per_acre_unit: 'oz/cwt', ...liquid }]
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('Not checked');
    });

    it('stays quiet on an MG-rated, MG-sold product (the identity path billing uses)', () => {
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: null, total_volume_unit: null },
        [{
          product_name: 'Post spray', quantity: 200, unit: 'MG', rate_per_acre: 2, rate_per_acre_unit: 'MG',
          product_form: 'dry', product_rate_unit: 'MG', product_inventory_unit: 'MG',
        }]
      );
      expect(warnings).toHaveLength(0);
    });

    // create_invoice_from_blend_ticket hard-raises BLEND_TICKET_UNIT_UNCONVERTIBLE
    // for this shape. Better a note now than a failed invoice weeks later.
    it('predicts the invoice failure when the rate unit cannot reach the sold unit', () => {
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: null, total_volume_unit: null },
        [{
          product_name: 'Post spray', quantity: 200, unit: 'MG', rate_per_acre: 2, rate_per_acre_unit: 'MG',
          product_form: 'dry', product_rate_unit: 'MG', product_inventory_unit: 'lb',
        }]
      );
      expect(warnings.some((w) => w.includes('fail when you invoice it'))).toBe(true);
    });

    it('keeps the plain numeric comparison when no unit is recorded on either side', () => {
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: null, total_volume_unit: null },
        [{ product_name: 'A', quantity: 250, unit: null, rate_per_acre: 2, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null }]
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('200.00');
    });
  });
});
