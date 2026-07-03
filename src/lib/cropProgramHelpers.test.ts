import { describe, it, expect } from 'vitest';
import {
  parseCropPrograms,
  orderProgramsForJob,
  programItemToChemRowSeed,
  type CropProgram,
  type ProgramItem,
} from './cropProgramHelpers';
import type { Product } from '../types';

const prog = (over: Partial<CropProgram>): CropProgram => ({
  id: 'p', name: 'P', description: '', crop_type: 'Corn', season: '2026',
  is_active: true, items: [], created_at: '', updated_at: '', ...over,
});

describe('parseCropPrograms', () => {
  it('parses a valid JSON array', () => {
    const v = JSON.stringify([prog({ id: 'a', name: 'A' })]);
    expect(parseCropPrograms(v).map((p) => p.id)).toEqual(['a']);
  });
  it('returns [] for null / empty / malformed / non-array', () => {
    expect(parseCropPrograms(null)).toEqual([]);
    expect(parseCropPrograms('')).toEqual([]);
    expect(parseCropPrograms('{not json')).toEqual([]);
    expect(parseCropPrograms(JSON.stringify({ foo: 1 }))).toEqual([]);
  });
});

describe('orderProgramsForJob', () => {
  const corn = prog({ id: 'corn', name: 'Corn Prog', crop_type: 'Corn' });
  const soy = prog({ id: 'soy', name: 'Soy Prog', crop_type: 'Soybeans' });
  const inactive = prog({ id: 'x', name: 'Old', crop_type: 'Corn', is_active: false });

  it('drops inactive programs', () => {
    expect(orderProgramsForJob([corn, inactive], []).map((p) => p.id)).toEqual(['corn']);
  });
  it('puts crop-matching programs first (case-insensitive), then alphabetical', () => {
    const ordered = orderProgramsForJob([soy, corn], ['corn']);
    expect(ordered.map((p) => p.id)).toEqual(['corn', 'soy']);
  });
  it('does not mutate the input array', () => {
    const input = [soy, corn];
    orderProgramsForJob(input, ['Corn']);
    expect(input.map((p) => p.id)).toEqual(['soy', 'corn']);
  });
});

describe('programItemToChemRowSeed', () => {
  const item: ProgramItem = {
    product_id: 'prod1', product_name: 'Atrazine', rate: 32, rate_unit: 'oz/acre',
    section_name: 'Pre-Emerge', notes: '',
  };
  const product = {
    id: 'prod1', product_name: 'Atrazine', current_cost: 5, tier1_price: 10,
    tier2_price: 9, tier3_price: 8, rate_unit: 'oz/acre', unit_size: 'gal',
    vendor: 'Acme', rei_hours: 12, phi_days: 30,
  } as unknown as Product;

  it("maps the program's per-acre rate + unit and defers quantity", () => {
    const seed = programItemToChemRowSeed(item, product, 1);
    expect(seed.product_id).toBe('prod1');
    expect(seed.rate_per_acre).toBe('32');
    expect(seed.rate_unit).toBe('oz/acre');
    expect(seed.quantity).toBe('0'); // re-derived from rate × acres by the caller
    expect(seed.driver).toBe('rate');
  });

  it('uses the customer tier price (cents) so a loaded line is never $0', () => {
    expect(programItemToChemRowSeed(item, product, 1).price_per_unit_cents).toBe('1000');
    expect(programItemToChemRowSeed(item, product, 3).price_per_unit_cents).toBe('800');
  });

  it('takes cost/vendor/REI/PHI from the live product', () => {
    const seed = programItemToChemRowSeed(item, product, 1);
    expect(seed.cost_per_unit_cents).toBe('500');
    expect(seed.vendor).toBe('Acme');
    expect(seed.rei_hours).toBe('12');
    expect(seed.phi_days).toBe('30');
  });

  it('is safe when the product is missing (deleted/inactive) — no price/cost, keeps rate', () => {
    const seed = programItemToChemRowSeed(item, undefined, 2);
    expect(seed.price_per_unit_cents).toBe('0');
    expect(seed.cost_per_unit_cents).toBe('0');
    expect(seed.rate_per_acre).toBe('32');
    expect(seed.rate_unit).toBe('oz/acre'); // program unit still applies
  });
});

// Regression against the EXACT live production program (app_settings.crop_programs,
// project rhyzpcqhnizqbxphqdkr, captured 2026-07-03) — proves the parse + map handle
// real data incl. a decimal rate (9.6) and a non-standard unit ("Dry oz").
describe('live production data: "2026 Wells NON-GMO"', () => {
  const LIVE = '[{"id":"37f36b07-91bc-4f4c-a577-0a64a696d79c","name":"2026 Wells NON-GMO","description":"Non-GMO Program","crop_type":"Corn","season":"2026","is_active":true,"items":[{"product_id":"53966e2b-be1a-498a-8aa2-675aedef17f1","product_name":"Gen Callisto","rate":4,"rate_unit":"oz","section_name":"Pre-Emerge","notes":""},{"product_id":"af04c5aa-f15d-4507-98e7-4b154b5a987e","product_name":"Atrazine 4L - 2.5 Gal","rate":64,"rate_unit":"oz","section_name":"Pre-Emerge","notes":""},{"product_id":"768cd6c9-70d4-40fa-bd05-c1ba68294466","product_name":"NIS 90 - 2.5 Gal","rate":9.6,"rate_unit":"oz","section_name":"Pre-Emerge","notes":""},{"product_id":"da3a29ed-2994-44b5-921d-96dca2547bce","product_name":"Ammonium Sulfate - 51# Bag","rate":32,"rate_unit":"Dry oz","section_name":"Pre-Emerge","notes":""}],"created_at":"2026-02-11T18:45:36.498Z","updated_at":"2026-02-11T18:45:36.498Z"}]';

  it('parses the live JSON and preserves each per-acre rate/unit through the mapping', () => {
    const programs = parseCropPrograms(LIVE);
    expect(programs).toHaveLength(1);
    expect(programs[0].name).toBe('2026 Wells NON-GMO');
    expect(programs[0].crop_type).toBe('Corn');
    expect(programs[0].items).toHaveLength(4);

    // Product not in the (empty) catalog here → mapper stays safe, carries rate+unit.
    const seeds = programs[0].items.map((it) => programItemToChemRowSeed(it, undefined, 1));
    expect(seeds.map((s) => s.rate_per_acre)).toEqual(['4', '64', '9.6', '32']); // decimal preserved
    expect(seeds.map((s) => s.rate_unit)).toEqual(['oz', 'oz', 'oz', 'Dry oz']); // non-standard unit carried
    expect(seeds.every((s) => s.driver === 'rate')).toBe(true);
  });

  it('sorts before a non-Corn program for a Corn job', () => {
    const live = parseCropPrograms(LIVE);
    const soy = prog({ id: 'soy', name: 'Soy', crop_type: 'Soybeans' });
    const ordered = orderProgramsForJob([soy, ...live], ['Corn']);
    expect(ordered[0].name).toBe('2026 Wells NON-GMO');
  });
});
