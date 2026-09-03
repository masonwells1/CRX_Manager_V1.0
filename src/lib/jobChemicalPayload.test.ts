import { describe, it, expect } from 'vitest';
import { buildJobChemicalsPayload, type JobChemicalPayloadSource } from './jobChemicalPayload';

/**
 * buildJobChemicalsPayload turns free-text form rows into the payload written for
 * a job's chemicals. Two behaviors matter most:
 *   - money fields (cost/price per unit, in CENTS) must never become NaN or a float;
 *   - rate_per_acre distinguishes "not entered" (null) from a real 0, because a
 *     0 rate and an absent rate are different agronomic facts.
 */
function row(overrides: Partial<JobChemicalPayloadSource> = {}): JobChemicalPayloadSource {
  return {
    product_id: 'prod-1',
    quantity: '10',
    unit: 'gal',
    rate_per_acre: '2.5',
    rate_unit: 'oz/ac',
    cost_per_unit_cents: '1500',
    price_per_unit_cents: '2000',
    diluent_rate: '5',
    rei_hours: '12',
    phi_days: '7',
    warehouse: 'main',
    vendor: 'acme',
    customer_supplied: false,
    ...overrides,
  };
}

describe('buildJobChemicalsPayload', () => {
  it('maps a fully populated row', () => {
    expect(buildJobChemicalsPayload([row()])[0]).toEqual({
      product_id: 'prod-1',
      quantity: 10,
      unit: 'gal',
      rate_per_acre: 2.5,
      rate_unit: 'oz/ac',
      cost_per_unit_cents: 1500,
      price_per_unit_cents: 2000,
      diluent_rate: '5',
      rei_hours: '12',
      phi_days: '7',
      warehouse: 'main',
      vendor: 'acme',
      customer_supplied: false,
      sort_order: 0,
      driver: null,
    });
  });

  describe('F06: driver is persisted so a reloaded line knows which field was typed', () => {
    it.each(['rate', 'qty'] as const)('sends %j through unchanged', (driver) => {
      expect(buildJobChemicalsPayload([row({ driver })])[0].driver).toBe(driver);
    });
    it('sends null when unknown — the server stores NULL and the grid leaves the line as saved', () => {
      expect(buildJobChemicalsPayload([row()])[0].driver).toBeNull();
      expect(buildJobChemicalsPayload([row({ driver: undefined })])[0].driver).toBeNull();
    });
    it('never sends any other string, because save_job refuses it (CHEM_DRIVER_INVALID)', () => {
      const stale = { ...row(), driver: 'total' as unknown as 'rate' };
      expect(buildJobChemicalsPayload([stale])[0].driver).toBeNull();
    });
  });

  it('assigns sort_order from array position, preserving row order', () => {
    const out = buildJobChemicalsPayload([
      row({ product_id: 'a' }),
      row({ product_id: 'b' }),
      row({ product_id: 'c' }),
    ]);
    expect(out.map((r) => [r.product_id, r.sort_order])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ]);
  });

  it('returns an empty array for no rows', () => {
    expect(buildJobChemicalsPayload([])).toEqual([]);
  });

  describe('money fields stay integer cents', () => {
    it.each([
      ['', 0],
      ['abc', 0],
      ['0', 0],
      ['1500', 1500],
      ['1500.9', 1500], // parseInt truncates — cents never become fractional
    ])('parses cost %j as %i cents', (raw, expected) => {
      expect(buildJobChemicalsPayload([row({ cost_per_unit_cents: raw })])[0].cost_per_unit_cents)
        .toBe(expected);
    });

    it('never yields NaN for malformed money input', () => {
      const out = buildJobChemicalsPayload([
        row({ cost_per_unit_cents: 'oops', price_per_unit_cents: '' }),
      ])[0];
      expect(Number.isNaN(out.cost_per_unit_cents)).toBe(false);
      expect(Number.isNaN(out.price_per_unit_cents)).toBe(false);
      expect(out.cost_per_unit_cents).toBe(0);
      expect(out.price_per_unit_cents).toBe(0);
    });

    it('keeps cents as integers', () => {
      const out = buildJobChemicalsPayload([row({ price_per_unit_cents: '2000' })])[0];
      expect(Number.isInteger(out.price_per_unit_cents)).toBe(true);
    });
  });

  describe('rate_per_acre distinguishes absent from zero', () => {
    it('a real 0 is preserved, not coerced to null', () => {
      expect(buildJobChemicalsPayload([row({ rate_per_acre: '0' })])[0].rate_per_acre).toBe(0);
    });

    it.each(['', 'abc'])('non-numeric %j becomes null', (raw) => {
      expect(buildJobChemicalsPayload([row({ rate_per_acre: raw })])[0].rate_per_acre).toBeNull();
    });

    it('keeps fractional rates', () => {
      expect(buildJobChemicalsPayload([row({ rate_per_acre: '0.75' })])[0].rate_per_acre).toBe(0.75);
    });
  });

  describe('quantity', () => {
    it.each([
      ['', 0],
      ['abc', 0],
      ['12.5', 12.5],
    ])('parses %j as %d', (raw, expected) => {
      expect(buildJobChemicalsPayload([row({ quantity: raw })])[0].quantity).toBe(expected);
    });
  });

  describe('optional text fields collapse empty string to null', () => {
    it.each(['unit', 'rate_unit', 'diluent_rate', 'rei_hours', 'phi_days', 'warehouse', 'vendor'] as const)(
      '%s becomes null when blank',
      (field) => {
        const out = buildJobChemicalsPayload([row({ [field]: '' })])[0];
        expect(out[field]).toBeNull();
      },
    );
  });

  it('customer_supplied defaults to false and preserves true', () => {
    expect(buildJobChemicalsPayload([row({ customer_supplied: true })])[0].customer_supplied).toBe(true);
    expect(buildJobChemicalsPayload([row({ customer_supplied: false })])[0].customer_supplied).toBe(false);
  });
});
