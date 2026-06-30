import { describe, it, expect } from 'vitest';
import {
  normalizeRateUnit,
  compareToMaxRate,
  phiHarvestWarning,
  formatRei,
  formatPhi,
  needsOverride,
} from './labelGuardrails';

describe('normalizeRateUnit', () => {
  it('lowercases, trims, and strips a per-acre suffix', () => {
    expect(normalizeRateUnit('OZ/acre')).toBe('oz');
    expect(normalizeRateUnit('  pt/ac ')).toBe('pt');
    expect(normalizeRateUnit('gal per acre')).toBe('gal');
    expect(normalizeRateUnit('lb/a')).toBe('lb');
  });
  it('canonicalizes synonyms so equivalent spellings match', () => {
    expect(normalizeRateUnit('ounce')).toBe('oz');
    expect(normalizeRateUnit('fl oz')).toBe('oz');
    expect(normalizeRateUnit('gallons')).toBe('gal');
    expect(normalizeRateUnit('pounds')).toBe('lb');
  });
  it('returns null for blank/empty input', () => {
    expect(normalizeRateUnit('')).toBeNull();
    expect(normalizeRateUnit('   ')).toBeNull();
    expect(normalizeRateUnit(null)).toBeNull();
    expect(normalizeRateUnit(undefined)).toBeNull();
  });
  it('keeps an unknown token as-is (so two identical unknowns still match)', () => {
    expect(normalizeRateUnit('widgets')).toBe('widgets');
    expect(normalizeRateUnit('WIDGETS/acre')).toBe('widgets');
  });
  it('keeps a NON-acre denominator whole so it never collapses to a bare unit', () => {
    // 'L/ha' must NOT normalize to 'l' (which would falsely match a per-acre 'l' rate).
    expect(normalizeRateUnit('L/ha')).toBe('l/ha');
    expect(normalizeRateUnit('fl oz/100 gal')).toBe('fl oz/100 gal');
    expect(normalizeRateUnit('oz/1000 sq ft')).toBe('oz/1000 sq ft');
  });
});

describe('compareToMaxRate — non-acre denominator safety', () => {
  it('does NOT compare a per-acre rate against a per-hectare max (cannot_compare)', () => {
    // rate is 5 oz/acre, max is 2 L/ha — different denominators, must not flag.
    expect(compareToMaxRate(5, 'oz/acre', 2, 'L/ha').status).toBe('cannot_compare');
    // and a per-hectare rate vs a per-hectare max DOES compare (same whole token).
    expect(compareToMaxRate(5, 'L/ha', 2, 'L/ha').status).toBe('over');
  });
});

describe('compareToMaxRate', () => {
  it('flags an over-label rate when units match (the headline case)', () => {
    const r = compareToMaxRate(5, 'oz/acre', 2, 'oz/acre');
    expect(r.status).toBe('over');
    expect(r.rate).toBe(5);
    expect(r.maxRate).toBe(2);
    expect(r.comparedUnit).toBe('oz');
  });
  it('does NOT flag a within-label rate', () => {
    expect(compareToMaxRate(2, 'oz/acre', 2, 'oz/acre').status).toBe('within'); // at the max = within
    expect(compareToMaxRate(1, 'oz', 2, 'oz').status).toBe('within');
  });
  it('returns no_label_max when the product has no max on file (graceful, never blocks)', () => {
    expect(compareToMaxRate(5, 'oz/acre', null, null).status).toBe('no_label_max');
    expect(compareToMaxRate(5, 'oz/acre', 0, 'oz/acre').status).toBe('no_label_max');
    expect(compareToMaxRate(5, 'oz/acre', undefined, undefined).status).toBe('no_label_max');
  });
  it('UNIT SAFETY: never flags over-rate when units differ (no false positive)', () => {
    // 5 oz/acre vs a 2 pt/acre max — numerically 5 > 2 but the units differ, so we must NOT flag.
    const r = compareToMaxRate(5, 'oz/acre', 2, 'pt/acre');
    expect(r.status).toBe('cannot_compare');
  });
  it('UNIT SAFETY: cannot_compare when either unit is missing', () => {
    expect(compareToMaxRate(5, '', 2, 'oz').status).toBe('cannot_compare');
    expect(compareToMaxRate(5, 'oz', 2, null).status).toBe('cannot_compare');
    expect(compareToMaxRate(5, null, 2, 'oz').status).toBe('cannot_compare');
  });
  it('compares equal across synonym/suffix spellings (oz vs OUNCE/acre)', () => {
    expect(compareToMaxRate(5, 'oz', 2, 'OUNCE/acre').status).toBe('over');
    expect(compareToMaxRate(1, 'gallons', 2, 'gal/acre').status).toBe('within');
  });
  it('returns no_rate when no rate is entered', () => {
    expect(compareToMaxRate(null, 'oz', 2, 'oz').status).toBe('no_rate');
    expect(compareToMaxRate(0, 'oz', 2, 'oz').status).toBe('no_rate');
    expect(compareToMaxRate(undefined, 'oz', 2, 'oz').status).toBe('no_rate');
  });
  it('treats non-finite inputs defensively without throwing', () => {
    expect(compareToMaxRate(NaN, 'oz', 2, 'oz').status).toBe('no_rate');
    expect(compareToMaxRate(Infinity, 'oz', 2, 'oz').status).toBe('no_rate');
    expect(compareToMaxRate(5, 'oz', NaN, 'oz').status).toBe('no_label_max');
  });
});

describe('phiHarvestWarning', () => {
  it('warns when harvest falls inside the PHI window', () => {
    // applied 2026-06-01, 14-day PHI => earliest harvest 2026-06-15. Harvest 2026-06-10 is too soon.
    const r = phiHarvestWarning(14, '2026-06-10', '2026-06-01');
    expect(r.status).toBe('inside_window');
    expect(r.earliestHarvest).toBe('2026-06-15');
    expect(r.harvestDate).toBe('2026-06-10');
    expect(r.phiDays).toBe(14);
  });
  it('is clear when harvest is on/after the earliest safe harvest', () => {
    expect(phiHarvestWarning(14, '2026-06-15', '2026-06-01').status).toBe('clear'); // exactly earliest = clear
    expect(phiHarvestWarning(14, '2026-07-01', '2026-06-01').status).toBe('clear');
  });
  it('is unknown (no warning) when PHI is missing/zero', () => {
    expect(phiHarvestWarning(null, '2026-06-10', '2026-06-01').status).toBe('unknown');
    expect(phiHarvestWarning(0, '2026-06-10', '2026-06-01').status).toBe('unknown');
    expect(phiHarvestWarning(undefined, '2026-06-10', '2026-06-01').status).toBe('unknown');
  });
  it('is unknown (no warning) when there is no harvest date — graceful degrade', () => {
    expect(phiHarvestWarning(14, null, '2026-06-01').status).toBe('unknown');
    expect(phiHarvestWarning(14, '', '2026-06-01').status).toBe('unknown');
    expect(phiHarvestWarning(14, 'not-a-date', '2026-06-01').status).toBe('unknown');
  });
  it('accepts an ISO datetime harvest/application string (date-only is used)', () => {
    const r = phiHarvestWarning(7, '2026-06-05T00:00:00Z', '2026-06-01T12:00:00Z');
    expect(r.earliestHarvest).toBe('2026-06-08');
    expect(r.status).toBe('inside_window'); // harvest 06-05 < earliest 06-08
  });
});

describe('formatRei / formatPhi', () => {
  it('formats present values and dashes for missing', () => {
    expect(formatRei(12)).toBe('12 hr');
    expect(formatRei(null)).toBe('—');
    expect(formatRei(0)).toBe('—');
    expect(formatPhi(7)).toBe('7 d');
    expect(formatPhi(null)).toBe('—');
    expect(formatPhi(0)).toBe('—');
  });
});

describe('needsOverride', () => {
  it('NEVER gates a save in warn mode (the safety default)', () => {
    expect(needsOverride('warn', [{ status: 'over' }, { status: 'over' }])).toBe(false);
  });
  it('gates in block mode only when a line is over-label', () => {
    expect(needsOverride('block', [{ status: 'over' }])).toBe(true);
    expect(needsOverride('block', [{ status: 'within' }, { status: 'no_label_max' }])).toBe(false);
    expect(needsOverride('block', [{ status: 'cannot_compare' }])).toBe(false);
    expect(needsOverride('block', [])).toBe(false);
  });
});
