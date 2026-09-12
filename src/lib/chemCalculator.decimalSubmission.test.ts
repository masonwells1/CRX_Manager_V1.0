import { describe, expect, it } from 'vitest';
import { chemLineBillingHazard, fieldAcresSurvivesSave, sumAcresExact } from './chemCalculator';

describe('converted-unit SQL decimal submission boundary', () => {
  const row = { quantity: '1.5992', rate_per_acre: '0.1', rate_unit: 'Lb/ac', unit: 'oz' };

  it('accepts the exact inclusive lower boundary without floating subtraction', () => {
    // SQL: 0.1 lb/ac * 1 ac * 16 = 1.6 oz; converted slack = 0.0008 oz.
    expect(chemLineBillingHazard(row, 1, 'dry').hazard).toBe(false);
  });

  it('accepts the complementary upper boundary', () => {
    expect(chemLineBillingHazard({ ...row, quantity: '1.6008' }, 1, 'dry').hazard).toBe(false);
  });

  it('refuses quantities just outside either boundary', () => {
    for (const quantity of ['1.599199999', '1.600800001']) {
      expect(chemLineBillingHazard({ ...row, quantity }, 1, 'dry').hazard).toBe(true);
    }
  });

  it.each(['constructor', 'toString', '__proto__'])('keeps inherited unit name %s flagged without a render crash', (unit) => {
    expect(chemLineBillingHazard({ ...row, rate_unit: `${unit}/ac` }, 1, 'dry').hazard).toBe(true);
    expect(chemLineBillingHazard({ ...row, unit }, 1, 'dry').hazard).toBe(true);
  });

  it('uses the exact decimal field sum instead of rounding the total back to Number', () => {
    const acres = sumAcresExact([
      { acres_to_treat: '1000000000000000' }, { acres_to_treat: '0.05' },
    ]);
    expect(acres).toBe('1000000000000000.05');
    expect(chemLineBillingHazard({
      quantity: '62500000000000', rate_per_acre: '1', rate_unit: 'oz/ac', unit: 'lb',
    }, acres as string, 'dry').hazard).toBe(false);
    // The total's .05 acres contributes .003125 lb, within the converted .00625 cap.
    const outsideAcres = sumAcresExact([
      { acres_to_treat: '1000000000000000' }, { acres_to_treat: '0.11' },
    ]);
    expect(outsideAcres).toBe('1000000000000000.11');
    expect(chemLineBillingHazard({
      quantity: '62500000000000', rate_per_acre: '1', rate_unit: 'oz/ac', unit: 'lb',
    }, outsideAcres as string, 'dry').hazard).toBe(true);
    // Rounding this independently representable field sum down to .1 would accept it.
    expect(chemLineBillingHazard({
      quantity: '62500000000000', rate_per_acre: '1', rate_unit: 'oz/ac', unit: 'lb',
    }, Number(outsideAcres), 'dry').hazard).toBe(false);
  });

  it.each([
    ['liquid', 'gl/ac', 'oz', '0.1', '1', '12.7936', '12.793599999'],
    ['dry', 'oz/ac', 'lb', '1', '1', '0.0624', '0.062399999'],
    ['dry', 'lb/ac', 'oz', '0.1', '3000', '4798.4', '4798.399999'],
    ['dry', 'ton/ac', 'lb', '0.1', '1', '199.9', '199.899999'],
  ] as const)('mirrors converted floor/cap for %s %s → %s', (form, rateUnit, unit, rate, acres, boundary, outside) => {
    const chemical = { quantity: boundary, rate_per_acre: rate, rate_unit: rateUnit, unit };
    expect(chemLineBillingHazard(chemical, acres, form).hazard).toBe(false);
    expect(chemLineBillingHazard({ ...chemical, quantity: outside }, acres, form).hazard).toBe(true);
  });
});

describe('acreage survives the established numeric payload unchanged', () => {
  it.each(['', '  ', '0', '-0', '0.1', '0.2000', '1e3', '1e-7', '1e+15', '0e999999999', '0e-999999999'])('accepts %j without changing its decimal value', (raw) => {
    expect(fieldAcresSurvivesSave(raw)).toBe(true);
  });

  it.each(['1000000000000000.05', '0.29999999999999999', '1e-999999999', '1e999', 'Infinity', 'NaN', '-1', '1foo', '.'])('refuses %j instead of silently rounding or coercing', (raw) => {
    expect(fieldAcresSurvivesSave(raw)).toBe(false);
  });
});
