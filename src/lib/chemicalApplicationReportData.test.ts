import { describe, it, expect } from 'vitest';
import {
  buildApplicatorSheetData,
  type BuildSheetInput,
  type RawSheetField,
  type RawSheetProduct,
} from './applicatorSheetData';
import { buildChemicalApplicationReportData, formatRatePerAcre } from './chemicalApplicationReportData';

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

describe('formatRatePerAcre — no double /ac suffix', () => {
  it('appends /ac to a bare unit', () => {
    expect(formatRatePerAcre(2, 'pt')).toBe('2 pt/ac');
    expect(formatRatePerAcre(5, 'lb')).toBe('5 lb/ac');
  });
  it('does NOT double-suffix a unit that already encodes per-acre', () => {
    expect(formatRatePerAcre(2, 'pt/ac')).toBe('2 pt/ac');
    expect(formatRatePerAcre(3, 'oz/ac')).toBe('3 oz/ac');
    expect(formatRatePerAcre(1, 'qt/acre')).toBe('1 qt/acre');
    expect(formatRatePerAcre(1, 'pt / ac')).toBe('1 pt / ac');
  });
  it('handles a blank/null unit', () => {
    expect(formatRatePerAcre(2, null)).toBe('2/ac');
    expect(formatRatePerAcre(2, '')).toBe('2/ac');
  });
});

describe('buildChemicalApplicationReportData — header + summary', () => {
  it('carries job, customers, applicator, date, total acres straight from the gatherer', () => {
    const sheet = buildApplicatorSheetData(baseInput({
      job_number: 'JOB-42',
      applicator_name: 'Jane Doe',
      scheduled_date: '2026-07-01',
      scheduled_time: '08:30',
      fields: [
        field({ field_name: 'East 40', acres: 40, sort_order: 0 }),
        field({ field_name: 'North 80', acres: 80, sort_order: 1 }),
      ],
    }));
    const rep = buildChemicalApplicationReportData(sheet);
    expect(rep.job_number).toBe('JOB-42');
    expect(rep.application_date).toBe('2026-07-01');
    expect(rep.scheduled_time).toBe('08:30');
    expect(rep.applicator_name).toBe('Jane Doe');
    expect(rep.total_acres).toBe(120);
    expect(rep.customers).toEqual([{ customer_name: 'Acme', account_number: 'A100' }]);
    expect(rep.fields.map((f) => f.field_name)).toEqual(['East 40', 'North 80']);
  });

  it('summarises distinct crops and pests across fields, dropping blanks/dupes', () => {
    const sheet = buildApplicatorSheetData(baseInput({
      fields: [
        field({ field_name: 'A', acres: 10, sort_order: 0, crop: 'Corn', pest: 'Waterhemp' }),
        field({ field_name: 'B', acres: 10, sort_order: 1, crop: 'Corn', pest: 'Foxtail' }),
        field({ field_name: 'C', acres: 10, sort_order: 2, crop: 'Soybeans', pest: null }),
      ],
    }));
    const rep = buildChemicalApplicationReportData(sheet);
    expect(rep.crops_summary).toBe('Corn, Soybeans');
    expect(rep.pests_summary).toBe('Waterhemp, Foxtail');
  });

  it('leaves crop/pest summaries empty when none are recorded', () => {
    const sheet = buildApplicatorSheetData(baseInput({
      fields: [field({ field_name: 'A', acres: 10, sort_order: 0 })],
    }));
    const rep = buildChemicalApplicationReportData(sheet);
    expect(rep.crops_summary).toBe('');
    expect(rep.pests_summary).toBe('');
  });
});

describe('buildChemicalApplicationReportData — chemical rows', () => {
  it('renders rate/acre, total applied + gal/lb, REI and PHI per product', () => {
    const sheet = buildApplicatorSheetData(baseInput({
      fields: [field({ field_name: 'A', acres: 100, sort_order: 0 })],
      products: [
        product({
          product_name: 'Roundup',
          rate_per_acre: 2,
          rate_unit: 'pt',
          unit: 'pt',
          product_form: 'liquid',
          rei_hours: 12,
          phi_days: 30,
          epa_registration: '524-549',
        }),
      ],
    }));
    const rep = buildChemicalApplicationReportData(sheet);
    expect(rep.chemicals).toHaveLength(1);
    const row = rep.chemicals[0];
    expect(row.product_name).toBe('Roundup');
    expect(row.epa_registration).toBe('524-549');
    expect(row.rate_per_acre_display).toBe('2 pt/ac');
    // 2 pt/ac × 100 ac = 200 pt total; 200 pt → 25 gal (8 pt per gal).
    expect(row.total_applied_display).toBe('200 pt');
    expect(row.gl_lb_display).toBe('25 gal');
    expect(row.rei_display).toBe('12 hr');
    expect(row.phi_display).toBe('30 d');
  });

  it('renders a blank EPA reg (—) without dropping the product (criterion 4)', () => {
    const sheet = buildApplicatorSheetData(baseInput({
      fields: [field({ field_name: 'A', acres: 50, sort_order: 0 })],
      products: [
        product({ product_name: 'WithReg', rate_per_acre: 1, rate_unit: 'qt', unit: 'qt', product_form: 'liquid', epa_registration: '100-200' }),
        product({ product_name: 'NoReg', rate_per_acre: 1, rate_unit: 'lb', unit: 'lb', product_form: 'dry', epa_registration: null }),
      ],
    }));
    const rep = buildChemicalApplicationReportData(sheet);
    expect(rep.chemicals.map((c) => c.product_name)).toEqual(['WithReg', 'NoReg']);
    expect(rep.chemicals[0].epa_registration).toBe('100-200');
    // null EPA reg -> the data carries null; the PDF renders it as a dash.
    expect(rep.chemicals[1].epa_registration).toBeNull();
  });

  it('shows dashes for missing rate/total/REI/PHI rather than guessing', () => {
    const sheet = buildApplicatorSheetData(baseInput({
      fields: [field({ field_name: 'A', acres: 0, sort_order: 0 })],
      products: [product({ product_name: 'Bare' })],
    }));
    const rep = buildChemicalApplicationReportData(sheet);
    const row = rep.chemicals[0];
    expect(row.rate_per_acre_display).toBe('—');
    expect(row.total_applied_display).toBe('—');
    expect(row.gl_lb_display).toBe('—');
    expect(row.rei_display).toBe('—');
    expect(row.phi_display).toBe('—');
  });

  it('uses the SAME product set + totals the applicator sheet computed (consistency)', () => {
    const sheet = buildApplicatorSheetData(baseInput({
      fields: [field({ field_name: 'A', acres: 80, sort_order: 0 })],
      products: [
        product({ product_name: 'P1', rate_per_acre: 3, rate_unit: 'oz', unit: 'oz', product_form: 'liquid' }),
        product({ product_name: 'P2', rate_per_acre: 2, rate_unit: 'lb', unit: 'lb', product_form: 'dry' }),
      ],
    }));
    const rep = buildChemicalApplicationReportData(sheet);
    // The report's chemical lines map 1:1 to the gatherer's products, in order.
    expect(rep.chemicals.map((c) => c.product_name)).toEqual(sheet.products.map((p) => p.product_name));
    // And the gal/lb equivalents are the gatherer's verbatim (not recomputed here).
    expect(rep.chemicals.map((c) => c.gl_lb_display)).toEqual(
      sheet.products.map((p) => p.total_gl_lb || '—'),
    );
  });
});
