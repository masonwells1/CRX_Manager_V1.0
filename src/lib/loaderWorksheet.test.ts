import { describe, it, expect } from 'vitest';
import {
  computeLoaderWorksheet,
  loaderProductTotals,
  isGallonCapacityUnit,
  MAX_LOADS,
  type LoaderWorksheetInput,
} from './loaderWorksheet';

/** Sum a product's amount across every load (the loader-facing invariant). */
function sumProductAcrossLoads(ws: ReturnType<typeof computeLoaderWorksheet>, name: string): number {
  return Math.round(
    ws.loads.reduce((s, load) => {
      const lp = load.products.find((p) => p.product_name === name);
      return s + (lp ? lp.amount : 0);
    }, 0) * 10000,
  ) / 10000;
}

describe('computeLoaderWorksheet — guard states (Invalid until valid inputs)', () => {
  const products = [{ product_name: 'Roundup', total_quantity: 100, unit: 'gal' }];

  it('is invalid (no crash, no number) when carrier rate is missing', () => {
    const ws = computeLoaderWorksheet({ total_acres: 100, carrier_rate_gpa: null, tank_capacity: 500, products });
    expect(ws.valid).toBe(false);
    expect(ws.loads_count).toBe(0);
    expect(ws.loads).toHaveLength(0);
    expect(ws.invalid_reason).toMatch(/carrier rate/i);
  });

  it('is invalid when carrier rate is zero', () => {
    const ws = computeLoaderWorksheet({ total_acres: 100, carrier_rate_gpa: 0, tank_capacity: 500, products });
    expect(ws.valid).toBe(false);
    expect(ws.loads_count).toBe(0);
  });

  it('is invalid when tank capacity is missing', () => {
    const ws = computeLoaderWorksheet({ total_acres: 100, carrier_rate_gpa: 15, tank_capacity: null, products });
    expect(ws.valid).toBe(false);
    expect(ws.invalid_reason).toMatch(/capacity/i);
  });

  it('is invalid when tank capacity is zero (never divides by zero)', () => {
    const ws = computeLoaderWorksheet({ total_acres: 100, carrier_rate_gpa: 15, tank_capacity: 0, products });
    expect(ws.valid).toBe(false);
    expect(ws.loads_count).toBe(0);
    expect(Number.isNaN(ws.loads_count)).toBe(false);
  });

  it('is invalid when there are no acres', () => {
    const ws = computeLoaderWorksheet({ total_acres: 0, carrier_rate_gpa: 15, tank_capacity: 500, products });
    expect(ws.valid).toBe(false);
    expect(ws.invalid_reason).toMatch(/acres/i);
  });

  it('caps an unrealistic loads count (tiny capacity) instead of allocating thousands of columns', () => {
    // 1500 gal spray / 0.1 gal tank = 15,000 loads — must be rejected, not built.
    const ws = computeLoaderWorksheet({ total_acres: 100, carrier_rate_gpa: 15, tank_capacity: 0.1, products });
    expect(ws.valid).toBe(false);
    expect(ws.loads).toHaveLength(0);
    expect(ws.invalid_reason).toMatch(/loads/i);
  });

  it('stays valid right at the MAX_LOADS ceiling', () => {
    // capacity sized so loads == MAX_LOADS exactly (sprayVolume = MAX_LOADS × 1 gal).
    const ws = computeLoaderWorksheet({ total_acres: MAX_LOADS, carrier_rate_gpa: 1, tank_capacity: 1, products });
    expect(ws.loads_count).toBe(MAX_LOADS);
    expect(ws.valid).toBe(true);
  });
});

describe('computeLoaderWorksheet — loads count + partial last load', () => {
  it('computes a full + partial last load (1500 gal / 500 tank = 3 loads, even)', () => {
    // 100 ac × 15 gpa = 1500 gal; 1500 / 500 = exactly 3 full loads, no partial.
    const ws = computeLoaderWorksheet({
      total_acres: 100,
      carrier_rate_gpa: 15,
      tank_capacity: 500,
      products: [{ product_name: 'Roundup', total_quantity: 120, unit: 'gal' }],
    });
    expect(ws.valid).toBe(true);
    expect(ws.spray_volume).toBe(1500);
    expect(ws.loads_count).toBe(3);
    expect(ws.partial_load_volume).toBe(0); // divides evenly => no partial
    expect(ws.loads.every((l) => l.volume === 500)).toBe(true);
    expect(ws.loads.some((l) => l.is_partial)).toBe(false);
  });

  it('flags a PARTIAL last load when the volume does not divide evenly', () => {
    // 100 ac × 16 gpa = 1600 gal; 1600 / 500 = 4 loads (3 full @500 + 1 partial @100).
    const ws = computeLoaderWorksheet({
      total_acres: 100,
      carrier_rate_gpa: 16,
      tank_capacity: 500,
      products: [{ product_name: 'Roundup', total_quantity: 160, unit: 'gal' }],
    });
    expect(ws.spray_volume).toBe(1600);
    expect(ws.loads_count).toBe(4);
    expect(ws.partial_load_volume).toBe(100);
    // First 3 loads are full (500), last is partial (100).
    expect(ws.loads.slice(0, 3).every((l) => l.volume === 500 && !l.is_partial)).toBe(true);
    const last = ws.loads[3];
    expect(last.volume).toBe(100);
    expect(last.is_partial).toBe(true);
  });

  it('handles a SINGLE load when the whole job fits one tank', () => {
    // 20 ac × 15 gpa = 300 gal < 500 tank => 1 load, partial (300 < 500).
    const ws = computeLoaderWorksheet({
      total_acres: 20,
      carrier_rate_gpa: 15,
      tank_capacity: 500,
      products: [{ product_name: 'Roundup', total_quantity: 40, unit: 'gal' }],
    });
    expect(ws.loads_count).toBe(1);
    expect(ws.spray_volume).toBe(300);
    expect(ws.partial_load_volume).toBe(300);
    expect(ws.loads).toHaveLength(1);
    // The single load holds the WHOLE product total.
    expect(ws.loads[0].products[0].amount).toBe(40);
  });

  it('treats an exactly-one-tank job as a single FULL (non-partial) load', () => {
    // 500 gal spray, 500 tank => exactly 1 full load.
    const ws = computeLoaderWorksheet({
      total_acres: 50,
      carrier_rate_gpa: 10,
      tank_capacity: 500,
      products: [{ product_name: 'Roundup', total_quantity: 50, unit: 'gal' }],
    });
    expect(ws.loads_count).toBe(1);
    expect(ws.partial_load_volume).toBe(0);
    expect(ws.loads[0].is_partial).toBe(false);
    expect(ws.loads[0].volume).toBe(500);
  });
});

describe('computeLoaderWorksheet — per-load split sums EXACTLY to the product total', () => {
  it('sum of per-load amounts === product total (even division)', () => {
    const ws = computeLoaderWorksheet({
      total_acres: 100,
      carrier_rate_gpa: 15,
      tank_capacity: 500,
      products: [{ product_name: 'Roundup', total_quantity: 120, unit: 'gal' }],
    });
    // 3 even loads => 40 each.
    ws.loads.forEach((l) => expect(l.products[0].amount).toBe(40));
    expect(sumProductAcrossLoads(ws, 'Roundup')).toBe(120);
  });

  it('sum of per-load amounts === product total WITH a partial last load (residual)', () => {
    // 1600 gal / 500 = 4 loads (500,500,500,100). Product total 160 gal of Roundup.
    // Full loads: 160 × 500/1600 = 50 each (×3 = 150); last load residual = 10.
    const ws = computeLoaderWorksheet({
      total_acres: 100,
      carrier_rate_gpa: 16,
      tank_capacity: 500,
      products: [{ product_name: 'Roundup', total_quantity: 160, unit: 'gal' }],
    });
    expect(ws.loads[0].products[0].amount).toBe(50);
    expect(ws.loads[1].products[0].amount).toBe(50);
    expect(ws.loads[2].products[0].amount).toBe(50);
    expect(ws.loads[3].products[0].amount).toBe(10); // partial-load residual
    expect(sumProductAcrossLoads(ws, 'Roundup')).toBe(160);
  });

  it('handles an ODD total with a residual that does not divide cleanly', () => {
    // 1500 gal / 700 tank = 3 loads (700,700,100). Product total = 100 units.
    // Loads: 100×700/1500 = 46.6667 (×2 = 93.3334); last = 100 − 93.3334 = 6.6666.
    const ws = computeLoaderWorksheet({
      total_acres: 100,
      carrier_rate_gpa: 15,
      tank_capacity: 700,
      products: [{ product_name: 'Atrazine', total_quantity: 100, unit: 'lb' }],
    });
    expect(ws.loads_count).toBe(3);
    expect(ws.loads[2].is_partial).toBe(true);
    // Critical invariant: the column sums to EXACTLY the product total (no drift).
    expect(sumProductAcrossLoads(ws, 'Atrazine')).toBe(100);
  });

  it('splits MULTIPLE products independently, each summing to its own total', () => {
    const input: LoaderWorksheetInput = {
      total_acres: 100,
      carrier_rate_gpa: 16,
      tank_capacity: 500,
      products: [
        { product_name: 'Roundup', total_quantity: 160, unit: 'gal' },
        { product_name: 'AMS', total_quantity: 320, unit: 'lb' },
        { product_name: 'Surfactant', total_quantity: 16, unit: 'oz' },
      ],
    };
    const ws = computeLoaderWorksheet(input);
    expect(ws.loads_count).toBe(4);
    expect(sumProductAcrossLoads(ws, 'Roundup')).toBe(160);
    expect(sumProductAcrossLoads(ws, 'AMS')).toBe(320);
    expect(sumProductAcrossLoads(ws, 'Surfactant')).toBe(16);
    // Each load lists every product.
    ws.loads.forEach((l) => expect(l.products).toHaveLength(3));
  });

  it('keeps DUPLICATE product lines index-aligned and independently split', () => {
    // Two lines of the SAME product name but different totals — load.products must
    // stay 1:1 with input.products by INDEX (a name lookup would collapse them).
    const ws = computeLoaderWorksheet({
      total_acres: 100,
      carrier_rate_gpa: 15, // 1500 gal / 500 = 3 even loads
      tank_capacity: 500,
      products: [
        { product_name: 'Roundup', total_quantity: 120, unit: 'gal' }, // index 0 => 40/40/40
        { product_name: 'Roundup', total_quantity: 60, unit: 'oz' },  // index 1 => 20/20/20
      ],
    });
    // Every load carries BOTH lines, in order.
    ws.loads.forEach((l) => {
      expect(l.products).toHaveLength(2);
      expect(l.products[0].amount).toBe(40);
      expect(l.products[1].amount).toBe(20);
    });
    // Each line sums to its OWN total via index, not a name collapse.
    const line0 = ws.loads.reduce((s, l) => s + l.products[0].amount, 0);
    const line1 = ws.loads.reduce((s, l) => s + l.products[1].amount, 0);
    expect(line0).toBe(120);
    expect(line1).toBe(60);
  });

  it('never OVER- or UNDER-applies on a many-loads + tiny-total rounding edge', () => {
    // Many valid loads + a very small product total: the rounded full-load shares
    // must NOT sum above the saved total (would tell the loader to over-apply) and
    // must NOT go negative. The running cap keeps the column sum exactly == total.
    const cases = [
      { total: 0.011, cap: 1.05 }, // Codex's example
      { total: 0.0198, cap: 1.0 },
      { total: 0.0001, cap: 1.2 },
    ];
    for (const { total, cap } of cases) {
      const ws = computeLoaderWorksheet({
        total_acres: 200,
        carrier_rate_gpa: 1, // 200 gal spray
        tank_capacity: cap,
        products: [{ product_name: 'Micro', total_quantity: total, unit: 'oz' }],
      });
      if (!ws.valid) { expect(ws.loads).toHaveLength(0); continue; }
      ws.loads.forEach((l) => l.products.forEach((pp) => expect(pp.amount).toBeGreaterThanOrEqual(0)));
      expect(sumProductAcrossLoads(ws, 'Micro')).toBeLessThanOrEqual(total);
      // And it should still account for (essentially) the whole total — within a
      // single 4dp rounding step.
      expect(sumProductAcrossLoads(ws, 'Micro')).toBeGreaterThanOrEqual(total - 0.0001);
    }
  });

  it('handles a zero-total product without polluting the split', () => {
    const ws = computeLoaderWorksheet({
      total_acres: 100,
      carrier_rate_gpa: 15,
      tank_capacity: 500,
      products: [
        { product_name: 'Roundup', total_quantity: 120, unit: 'gal' },
        { product_name: 'Blank', total_quantity: null, unit: null },
      ],
    });
    expect(sumProductAcrossLoads(ws, 'Roundup')).toBe(120);
    expect(sumProductAcrossLoads(ws, 'Blank')).toBe(0);
  });
});

describe('computeLoaderWorksheet — load balance modes + per-load acres overrides', () => {
  it('matches the ChemMan full-loads/remainder reference case', () => {
    const ws = computeLoaderWorksheet({
      total_acres: 344.67,
      carrier_rate_gpa: 15,
      tank_capacity: 2000,
      mode: 'full_loads_remainder',
      products: [{ product_name: 'AMS', total_quantity: 689.34, unit: 'lb' }],
    });

    expect(ws.valid).toBe(true);
    expect(ws.loads_count).toBe(3);
    expect(ws.loads.map((load) => Math.round((load.volume / 15) * 100) / 100)).toEqual([133.33, 133.33, 78]);
    expect(ws.loads[2].is_partial).toBe(true);
    expect(sumProductAcrossLoads(ws, 'AMS')).toBe(689.34);
    // Last load takes the exact 4dp residual after the two full loads.
    expect(ws.loads[2].products[0].amount).toBe(156.0066);
  });

  it('recomputes load volumes and product amounts from a per-load acres override', () => {
    const ws = computeLoaderWorksheet({
      total_acres: 100,
      carrier_rate_gpa: 15,
      tank_capacity: 500,
      products: [{ product_name: 'Roundup', total_quantity: 120, unit: 'gal' }],
      perLoadAcresOverride: [33.3, 33.3, 33.4],
    });

    expect(ws.valid).toBe(true);
    expect(ws.loads.map((load) => load.volume)).toEqual([499.5, 499.5, 501]);
    expect(ws.loads.map((load) => load.products[0].amount)).toEqual([39.96, 39.96, 40.08]);
    expect(sumProductAcrossLoads(ws, 'Roundup')).toBe(120);
  });

  it('rejects a manual load that exceeds the tank capacity', () => {
    const ws = computeLoaderWorksheet({
      total_acres: 100,
      carrier_rate_gpa: 15,
      tank_capacity: 500,
      products: [],
      perLoadAcresOverride: [20, 30, 50],
    });

    expect(ws.valid).toBe(false);
    expect(ws.invalid_reason).toBe('Load 3 needs 750 gal — tank holds 500 gal.');
  });

  it('rejects a per-load acres override whose length or total does not match the plan', () => {
    const wrongLength = computeLoaderWorksheet({
      total_acres: 100,
      carrier_rate_gpa: 15,
      tank_capacity: 500,
      products: [],
      perLoadAcresOverride: [50, 50],
    });
    expect(wrongLength.valid).toBe(false);
    expect(wrongLength.invalid_reason).toMatch(/all 3 loads/i);

    const wrongTotal = computeLoaderWorksheet({
      total_acres: 100,
      carrier_rate_gpa: 15,
      tank_capacity: 500,
      products: [],
      perLoadAcresOverride: [20, 30, 40],
    });
    expect(wrongTotal.valid).toBe(false);
    expect(wrongTotal.invalid_reason).toMatch(/must total/i);
  });

  it('keeps explicit proportional mode identical to the default regression output', () => {
    const input: LoaderWorksheetInput = {
      total_acres: 100,
      carrier_rate_gpa: 16,
      tank_capacity: 500,
      products: [{ product_name: 'Roundup', total_quantity: 160, unit: 'gal' }],
    };

    expect(computeLoaderWorksheet({ ...input, mode: 'proportional' })).toEqual(computeLoaderWorksheet(input));
  });
});

describe('isGallonCapacityUnit', () => {
  it('treats gallon units (and blank/default) as gallons', () => {
    for (const u of ['gal', 'Gallon', 'GALLONS', 'gl', '', null, undefined, '  gal  ']) {
      expect(isGallonCapacityUnit(u)).toBe(true);
    }
  });
  it('rejects dry/weight units (lbs/tons/etc.) — capacity can not seed gallon loads', () => {
    for (const u of ['lb', 'lbs', 'pounds', 'ton', 'tons', 'kg', 'liter']) {
      expect(isGallonCapacityUnit(u)).toBe(false);
    }
  });
});

describe('loaderProductTotals', () => {
  it('returns each product total = its job quantity', () => {
    const ws = computeLoaderWorksheet({
      total_acres: 100,
      carrier_rate_gpa: 16,
      tank_capacity: 500,
      products: [
        { product_name: 'Roundup', total_quantity: 160, unit: 'gal' },
        { product_name: 'AMS', total_quantity: 320, unit: 'lb' },
      ],
    });
    const totals = loaderProductTotals(ws);
    expect(totals.find((t) => t.product_name === 'Roundup')?.total).toBe(160);
    expect(totals.find((t) => t.product_name === 'AMS')?.total).toBe(320);
  });

  it('is empty for an invalid worksheet', () => {
    const ws = computeLoaderWorksheet({ total_acres: 0, carrier_rate_gpa: 15, tank_capacity: 500, products: [] });
    expect(loaderProductTotals(ws)).toHaveLength(0);
  });
});
