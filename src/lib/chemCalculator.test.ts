import { describe, it, expect } from 'vitest';
import {
  fmt4,
  sumAcres,
  applyChemEdit,
  recomputeChemRowForAcres,
  toGallonOrLbEquivalent,
  type ChemCalcRow,
} from './chemCalculator';

const row = (over: Partial<ChemCalcRow> = {}): ChemCalcRow => ({
  quantity: '0',
  rate_per_acre: '',
  ...over,
});

describe('chemCalculator — fmt4 / sumAcres', () => {
  it('fmt4 rounds to 4 dp and stringifies', () => {
    expect(fmt4(2 / 3)).toBe('0.6667');
    expect(fmt4(100)).toBe('100');
  });
  it('sumAcres sums parseable acres and ignores blanks', () => {
    expect(sumAcres([{ acres_to_treat: '40' }, { acres_to_treat: '60' }, { acres_to_treat: '' }])).toBe(100);
  });
});

describe('chemCalculator — applyChemEdit (normal flow, fields already selected)', () => {
  it('editing the rate fills the quantity and sets driver=rate', () => {
    const r = applyChemEdit(row({ rate_per_acre: '1' }), 'rate_per_acre', '1', 100);
    expect(r.quantity).toBe('100');
    expect(r.driver).toBe('rate');
  });
  it('typing a total quantity back-solves the rate and sets driver=qty', () => {
    const r = applyChemEdit(row({ quantity: '150' }), 'quantity', '150', 100);
    expect(r.rate_per_acre).toBe('1.5');
    expect(r.driver).toBe('qty');
  });
  it('a blank value leaves the row alone (flat/quantity-only line)', () => {
    const r = applyChemEdit(row({ rate_per_acre: '' }), 'rate_per_acre', '', 100);
    expect(r.driver).toBeUndefined();
  });
});

describe('chemCalculator — Codex r15: rate/total entered BEFORE fields (acres === 0)', () => {
  it('a rate entered with no acres records driver=rate WITHOUT computing quantity yet', () => {
    const r = applyChemEdit(row({ rate_per_acre: '1' }), 'rate_per_acre', '1', 0);
    expect(r.driver).toBe('rate');
    expect(r.quantity).toBe('0'); // not computed yet — deferred until acres exist
  });

  it('adding fields later fills the deferred quantity from the held rate', () => {
    // 1) user enters rate 1 pt/ac before any field is selected
    const afterRate = applyChemEdit(row({ rate_per_acre: '1' }), 'rate_per_acre', '1', 0);
    // 2) user adds 100 acres of fields → acreage recompute runs
    const afterFields = recomputeChemRowForAcres(afterRate, 100);
    expect(afterFields.quantity).toBe('100'); // the rate entry is NOT dropped → no underbill
    expect(afterFields.rate_per_acre).toBe('1');
  });

  it('a total quantity entered with no acres records driver=qty and back-solves the rate once acres exist', () => {
    const afterQty = applyChemEdit(row({ quantity: '250' }), 'quantity', '250', 0);
    expect(afterQty.driver).toBe('qty');
    const afterFields = recomputeChemRowForAcres(afterQty, 100);
    expect(afterFields.rate_per_acre).toBe('2.5');
    expect(afterFields.quantity).toBe('250'); // held — never silently rewritten
  });
});

describe('chemCalculator — recomputeChemRowForAcres', () => {
  it('rate-driven line: quantity follows an acreage change', () => {
    const r = recomputeChemRowForAcres(row({ rate_per_acre: '2', quantity: '100', driver: 'rate' }), 80);
    expect(r.quantity).toBe('160');
  });
  it('quantity-driven line: HOLDS the quantity, refigures the rate', () => {
    const r = recomputeChemRowForAcres(row({ rate_per_acre: '2', quantity: '100', driver: 'qty' }), 50);
    expect(r.quantity).toBe('100'); // held
    expect(r.rate_per_acre).toBe('2'); // 100 / 50
  });
  it('untouched / RELOADED line (no driver) is left exactly as saved', () => {
    const saved = row({ rate_per_acre: '1', quantity: '42', driver: undefined });
    const r = recomputeChemRowForAcres(saved, 999);
    expect(r).toEqual(saved);
  });
});

describe('chemCalculator — Codex r16: removing the last field (acres → 0)', () => {
  it('rate-driven line clears its derived quantity to 0 (no stale billable amount)', () => {
    // user had rate 2 over 100 acres → quantity 200, then removes all fields → acres 0
    const before = row({ rate_per_acre: '2', quantity: '200', driver: 'rate' });
    const after = recomputeChemRowForAcres(before, 0);
    expect(after.quantity).toBe('0'); // not stale 200
    expect(after.rate_per_acre).toBe('2'); // the rate the user set is kept
  });

  it('quantity-driven line HOLDS its typed total and does not divide by zero', () => {
    const before = row({ rate_per_acre: '2.5', quantity: '250', driver: 'qty' });
    const after = recomputeChemRowForAcres(before, 0);
    expect(after.quantity).toBe('250'); // explicit total held
    expect(after.rate_per_acre).toBe('2.5'); // not rewritten to Infinity/NaN
  });

  it('no-driver line is untouched at acres 0', () => {
    const saved = row({ rate_per_acre: '1', quantity: '42', driver: undefined });
    expect(recomputeChemRowForAcres(saved, 0)).toEqual(saved);
  });
});

describe('chemCalculator — toGallonOrLbEquivalent (ChemMan parity #1)', () => {
  it('converts liquid units to gallons', () => {
    expect(toGallonOrLbEquivalent(4, 'qt')).toEqual({ value: 1, unit: 'gal' });
    expect(toGallonOrLbEquivalent(8, 'pt')).toEqual({ value: 1, unit: 'gal' });
    expect(toGallonOrLbEquivalent(128, 'fl oz')).toEqual({ value: 1, unit: 'gal' });
    expect(toGallonOrLbEquivalent(3, 'GL')).toEqual({ value: 3, unit: 'gal' });
  });

  it('converts dry units to pounds', () => {
    expect(toGallonOrLbEquivalent(16, 'oz')).toEqual({ value: 1, unit: 'lb' });
    expect(toGallonOrLbEquivalent(5, 'lb')).toEqual({ value: 5, unit: 'lb' });
    expect(toGallonOrLbEquivalent(1, 'ton')).toEqual({ value: 2000, unit: 'lb' });
  });

  it('is case- and whitespace-insensitive', () => {
    expect(toGallonOrLbEquivalent(8, '  Pt ')).toEqual({ value: 1, unit: 'gal' });
  });

  it('returns null for blank/zero quantity or an unknown unit', () => {
    expect(toGallonOrLbEquivalent(0, 'gal')).toBeNull();
    expect(toGallonOrLbEquivalent(10, '')).toBeNull();
    expect(toGallonOrLbEquivalent(10, null)).toBeNull();
    expect(toGallonOrLbEquivalent(10, 'widgets')).toBeNull();
  });
});
