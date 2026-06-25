import { describe, it, expect } from 'vitest';
import {
  buildApplicatorSheetData,
  parseCustomConfig,
  serializeCustomConfig,
  DEFAULT_CUSTOM_CONFIG,
  fmtNum,
  type BuildSheetInput,
  type RawSheetField,
  type RawSheetProduct,
} from './applicatorSheetData';

const field = (over: Partial<RawSheetField>): RawSheetField => ({
  field_id: 'f',
  field_name: 'Field',
  county: null,
  state: null,
  acres: 0,
  crop: null,
  pest: null,
  sort_order: 0,
  ...over,
});

const product = (over: Partial<RawSheetProduct>): RawSheetProduct => ({
  product_name: 'Product',
  rate_per_acre: null,
  rate_unit: null,
  unit: null,
  total_quantity: null,
  product_form: null,
  rei_hours: null,
  phi_days: null,
  epa_registration: null,
  ...over,
});

const baseInput = (over: Partial<BuildSheetInput> = {}): BuildSheetInput => ({
  job_number: 'JOB-1',
  customers: [{ customer_name: 'Acme', account_number: 'A100' }],
  scheduled_date: '2026-06-25',
  scheduled_time: null,
  applicator_name: null,
  vehicle_name: null,
  fields: [],
  products: [],
  loader_comment: null,
  ...over,
});

describe('buildApplicatorSheetData — route order', () => {
  it('sorts fields by sort_order and numbers stops 1..n', () => {
    const data = buildApplicatorSheetData(baseInput({
      fields: [
        field({ field_name: 'South Creek', sort_order: 2, acres: 30 }),
        field({ field_name: 'East 40', sort_order: 0, acres: 40 }),
        field({ field_name: 'North 80', sort_order: 1, acres: 80 }),
      ],
    }));
    expect(data.fields.map((f) => f.field_name)).toEqual(['East 40', 'North 80', 'South Creek']);
    expect(data.fields.map((f) => f.stop)).toEqual([1, 2, 3]);
  });

  it('renumbers stops contiguously even with non-contiguous sort_order', () => {
    const data = buildApplicatorSheetData(baseInput({
      fields: [
        field({ field_name: 'B', sort_order: 5 }),
        field({ field_name: 'A', sort_order: 1 }),
      ],
    }));
    expect(data.fields.map((f) => [f.field_name, f.stop])).toEqual([['A', 1], ['B', 2]]);
  });
});

describe('buildApplicatorSheetData — totals + conversion', () => {
  it('totals acres across the route', () => {
    const data = buildApplicatorSheetData(baseInput({
      fields: [field({ acres: 40, sort_order: 0 }), field({ acres: 80, sort_order: 1 })],
    }));
    expect(data.total_acres).toBe(120);
  });

  it('derives total applied = rate × total acres when no hand-entered total', () => {
    const data = buildApplicatorSheetData(baseInput({
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'Roundup', rate_per_acre: 2, rate_unit: 'qt' })],
    }));
    expect(data.products[0].total_applied).toBe(200);
  });

  it('uses the hand-entered total when present (not rate × acres)', () => {
    const data = buildApplicatorSheetData(baseInput({
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [product({ rate_per_acre: 2, rate_unit: 'qt', total_quantity: 250 })],
    }));
    expect(data.products[0].total_applied).toBe(250);
  });

  it('converts a liquid total to gallons matching the server branch (240 pt → 30 gal)', () => {
    const data = buildApplicatorSheetData(baseInput({
      products: [product({ unit: 'pt', product_form: 'liquid', total_quantity: 240 })],
    }));
    expect(data.products[0].total_gl_lb).toBe('30 gal');
  });

  it('converts a dry total to pounds (32 oz → 2 lb)', () => {
    const data = buildApplicatorSheetData(baseInput({
      products: [product({ unit: 'oz', product_form: 'dry', total_quantity: 32 })],
    }));
    expect(data.products[0].total_gl_lb).toBe('2 lb');
  });

  it('leaves the conversion null for an unrecognized unit (never guesses)', () => {
    const data = buildApplicatorSheetData(baseInput({
      products: [product({ unit: 'widgets', total_quantity: 5 })],
    }));
    expect(data.products[0].total_gl_lb).toBeNull();
  });

  // ── #9 MED fix: the Total Applied magnitude is measured in `unit`, NOT the
  // per-acre `rate_unit`. The conversion + the label must use `unit`, mirroring
  // the in-page preview (toGallonOrLbEquivalent(quantity, c.unit)) and loader
  // worksheet. The rate/acre column keeps using rate_unit.
  it('uses unit (not rate_unit) for the Total Applied label + gal/lb when they differ', () => {
    const data = buildApplicatorSheetData(baseInput({
      products: [product({
        rate_per_acre: 1,
        rate_unit: 'pt/ac',     // per-acre rate unit — must NOT label/convert the total
        unit: 'GAL',            // Total Applied measure unit — what the preview uses
        product_form: 'liquid',
        total_quantity: 12.5,
      })],
    }));
    const p = data.products[0];
    // Label the total with its own measure unit, not the per-acre rate unit.
    expect(p.total_unit).toBe('GAL');
    expect(p.rate_unit).toBe('pt/ac');
    // 12.5 GAL → 12.5 gal (matches in-page preview toGallonOrLbEquivalent(12.5,'GAL')).
    // If it had wrongly used rate_unit 'pt/ac' the conversion would NOT be 12.5 gal.
    expect(p.total_gl_lb).toBe('12.5 gal');
  });

  it('converts when rate_unit is blank but unit is set — a real number, not a dash', () => {
    const data = buildApplicatorSheetData(baseInput({
      products: [product({
        rate_per_acre: 2,
        rate_unit: null,        // no per-acre rate unit captured
        unit: 'gal',            // but the Total Applied measure unit IS set
        product_form: 'liquid',
        total_quantity: 40,     // saved total quantity, measured in unit
      })],
    }));
    const p = data.products[0];
    expect(p.total_unit).toBe('gal');
    // Real tank quantity — NOT null/dash (the old rate_unit path printed a dash here).
    expect(p.total_gl_lb).toBe('40 gal');
  });

  // Legacy/blank-unit row: when job_chemicals.unit is empty but rate_unit is set, fall
  // back to rate_unit so the pre-fix output (240 pt → 30 gal) is preserved (not a dash).
  it('falls back to rate_unit only when unit is blank (legacy row preserved)', () => {
    const data = buildApplicatorSheetData(baseInput({
      products: [product({
        unit: '',               // legacy/blank measure unit
        rate_unit: 'pt',        // only the rate unit is populated
        product_form: 'liquid',
        total_quantity: 240,
      })],
    }));
    const p = data.products[0];
    expect(p.total_unit).toBe('pt');     // fell back to rate_unit
    expect(p.total_gl_lb).toBe('30 gal'); // 240 pt → 30 gal — same as before the fix
  });
});

describe('buildApplicatorSheetData — passthrough', () => {
  it('carries customers, applicator, vehicle, REI/PHI, epa', () => {
    const data = buildApplicatorSheetData(baseInput({
      applicator_name: 'Sam',
      vehicle_name: 'Sprayer 1',
      customers: [{ customer_name: 'Acme', account_number: 'A100' }],
      products: [product({ rei_hours: 24, phi_days: 7, epa_registration: '12345-67' })],
    }));
    expect(data.applicator_name).toBe('Sam');
    expect(data.vehicle_name).toBe('Sprayer 1');
    expect(data.customers[0].account_number).toBe('A100');
    expect(data.products[0].rei_hours).toBe(24);
    expect(data.products[0].phi_days).toBe(7);
    expect(data.products[0].epa_registration).toBe('12345-67');
  });
});

describe('parseCustomConfig', () => {
  it('returns the inert default for blank / null / malformed input', () => {
    expect(parseCustomConfig(null)).toEqual(DEFAULT_CUSTOM_CONFIG);
    expect(parseCustomConfig('')).toEqual(DEFAULT_CUSTOM_CONFIG);
    expect(parseCustomConfig('not json {')).toEqual(DEFAULT_CUSTOM_CONFIG);
    expect(parseCustomConfig('123')).toEqual(DEFAULT_CUSTOM_CONFIG);
  });

  it('reads configured header/footer/logo + column toggles', () => {
    const cfg = parseCustomConfig(JSON.stringify({
      company_name: 'My Co',
      company_address: '1 Main St',
      footer_text: 'Thanks',
      logo_data_url: 'data:image/png;base64,AAAA',
      columns: { crop: false, pest: true, rei: false, phi: true, total_applied: true, gl_lb: false },
    }));
    expect(cfg.company_name).toBe('My Co');
    expect(cfg.company_address).toBe('1 Main St');
    expect(cfg.footer_text).toBe('Thanks');
    expect(cfg.logo_data_url).toBe('data:image/png;base64,AAAA');
    expect(cfg.columns).toEqual({ crop: false, pest: true, rei: false, phi: true, total_applied: true, gl_lb: false });
  });

  it('defaults a missing column toggle to TRUE (older config still shows new columns)', () => {
    const cfg = parseCustomConfig(JSON.stringify({ columns: { crop: false } }));
    expect(cfg.columns.crop).toBe(false);
    expect(cfg.columns.gl_lb).toBe(true);
    expect(cfg.columns.rei).toBe(true);
  });

  it('round-trips through serialize → parse', () => {
    const original = parseCustomConfig(JSON.stringify({
      company_name: 'Co', company_address: 'Addr', footer_text: 'F', logo_data_url: '',
      columns: { crop: true, pest: false, rei: true, phi: false, total_applied: false, gl_lb: true },
    }));
    expect(parseCustomConfig(serializeCustomConfig(original))).toEqual(original);
  });
});

describe('fmtNum', () => {
  it('returns empty for null/NaN and drops trailing zeros', () => {
    expect(fmtNum(null)).toBe('');
    expect(fmtNum(Number.NaN)).toBe('');
    expect(fmtNum(120)).toBe('120');
    expect(fmtNum(2.5)).toBe('2.5');
    expect(fmtNum(1234.5)).toBe('1,234.5');
  });
});
