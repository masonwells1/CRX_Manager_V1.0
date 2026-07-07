import { describe, it, expect } from 'vitest';
import { unitOptionsForForm, isKnownUnit } from './units';
import type { UnitConversion } from '../types';

const CONV = [
  { id: '1', unit: 'oz', factor_oz: 1, unit_type: 'liquid' },
  { id: '2', unit: 'Gal', factor_oz: 128, unit_type: 'liquid' },
  { id: '3', unit: 'Lb', factor_oz: 16, unit_type: 'dry' },
  { id: '4', unit: 'Dry oz', factor_oz: 1, unit_type: 'dry' },
  { id: '5', unit: 'Ea', factor_oz: 1, unit_type: 'both' },
] as unknown as UnitConversion[];

describe('unitOptionsForForm', () => {
  it('returns all units when form is null/undefined', () => {
    expect(unitOptionsForForm(CONV, null).map((u) => u.unit)).toEqual(['oz', 'Gal', 'Lb', 'Dry oz', 'Ea']);
    expect(unitOptionsForForm(CONV, undefined)).toHaveLength(5);
  });
  it('filters to liquid + both for a liquid product', () => {
    expect(unitOptionsForForm(CONV, 'liquid').map((u) => u.unit)).toEqual(['oz', 'Gal', 'Ea']);
  });
  it('filters to dry + both for a dry product', () => {
    expect(unitOptionsForForm(CONV, 'dry').map((u) => u.unit)).toEqual(['Lb', 'Dry oz', 'Ea']);
  });
});

describe('isKnownUnit (grandfathering)', () => {
  it('true for a unit present in the filtered list', () => {
    expect(isKnownUnit(CONV, 'liquid', 'Gal')).toBe(true);
    expect(isKnownUnit(CONV, 'dry', 'Lb')).toBe(true);
    expect(isKnownUnit(CONV, 'liquid', 'Ea')).toBe(true); // 'both' always included
  });
  it('false when the value exists but the form filter hides it (must be grandfathered)', () => {
    expect(isKnownUnit(CONV, 'dry', 'Gal')).toBe(false);   // Gal is liquid -> hidden for a dry product
    expect(isKnownUnit(CONV, 'liquid', 'Lb')).toBe(false); // Lb is dry -> hidden for a liquid product
  });
  it('false for a genuinely unknown unit', () => {
    expect(isKnownUnit(CONV, 'liquid', 'furlong')).toBe(false);
  });
  it('true for a blank/undefined unit (nothing to grandfather)', () => {
    expect(isKnownUnit(CONV, 'liquid', '')).toBe(true);
    expect(isKnownUnit(CONV, 'liquid', null)).toBe(true);
  });
});
