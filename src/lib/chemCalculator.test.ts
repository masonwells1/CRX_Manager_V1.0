import { describe, it, expect } from 'vitest';
import {
  fmt4,
  sumAcres,
  applyChemEdit,
  recomputeChemRowForAcres,
  toGallonOrLbEquivalent,
  baseUnitOfRate,
  reconcileChemAutofillUnits,
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

// #25 fix: when product_form is supplied the gal/lb choice comes from the FORM,
// not the unit text, so the on-screen preview EQUALS the saved/printed value the
// server computes via convert_to_gl_lb(total_applied, rate_unit, product_form).
//
//   convert_to_gl_lb rules (migration 20260219200000):
//     dry    → LB:  oz = q/16,  lb = q
//     liquid → GL:  oz = q/128, pt = q/8, qt = q/4, gal = q
//
// `serverGlLb` below is a literal re-statement of those SQL rules; each test
// asserts the CLIENT helper returns exactly what the SERVER would — so agreement
// is proven against the rules, not coincidental.
describe('chemCalculator — toGallonOrLbEquivalent branches on product_form (server parity, #25)', () => {
  /** Mirror of the SQL convert_to_gl_lb branch (migration 20260629140000) — the
   *  authority the client must equal. Reproduces BOTH CASE statements verbatim,
   *  including every fl-oz / pound / ton spelling and NULL-on-unrecognized. */
  function serverGlLb(q: number, unit: string, form: 'liquid' | 'dry'): { value: number; unit: 'gal' | 'lb' } | null {
    const u = unit.trim().toUpperCase();
    if (form === 'dry') {
      const f = (u === 'OZ' || u === 'OUNCE' || u === 'OUNCES') ? 1 / 16
        : (u === 'LB' || u === 'LBS' || u === 'POUND' || u === 'POUNDS') ? 1
        : (u === 'TON' || u === 'TONS') ? 2000 : null;
      return f === null ? null : { value: Math.round(q * f * 10000) / 10000, unit: 'lb' };
    }
    // Liquid: fl-oz spellings = q/128; gallons (GL/GAL/GALLON/GALLONS) = q.
    // An unrecognized liquid unit returns NULL (server) / null (client) — never a guess.
    const f = (u === 'OZ' || u === 'FL OZ' || u === 'FLOZ' || u === 'FLUID OUNCE') ? 1 / 128
      : u === 'PT' ? 1 / 8 : u === 'QT' ? 1 / 4
      : (u === 'GL' || u === 'GAL' || u === 'GALLON' || u === 'GALLONS') ? 1 : null;
    return f === null ? null : { value: Math.round(q * f * 10000) / 10000, unit: 'gal' };
  }

  it('LIQUID + bare oz (the field-app default) → GALLONS, matching the server (NOT pounds)', () => {
    // 80 oz of a liquid product: server says 80/128 = 0.625 GL. The OLD unit-only
    // helper wrongly hit the pounds table (80/16 = 5 LB) — the bug this fixes.
    expect(toGallonOrLbEquivalent(80, 'oz', 'liquid')).toEqual({ value: 0.625, unit: 'gal' });
    expect(toGallonOrLbEquivalent(80, 'oz')).toEqual({ value: 5, unit: 'lb' }); // legacy/no-form path (unchanged)
    expect(toGallonOrLbEquivalent(80, 'oz', 'liquid')).toEqual(serverGlLb(80, 'oz', 'liquid'));
  });

  it('LIQUID qt / pt / gal → GALLONS, equal to the server', () => {
    for (const [q, u] of [[4, 'qt'], [8, 'pt'], [3, 'GL'], [128, 'oz']] as [number, string][]) {
      expect(toGallonOrLbEquivalent(q, u, 'liquid')).toEqual(serverGlLb(q, u, 'liquid'));
    }
  });

  // FIX 3 (Wave 2a remediation): every gallon SPELLING the field app emits must
  // read as 1:1 gallons — NOT 1/128. The old server matched only the literal 'GL',
  // so 'GAL'/'gal'/'Gallon' fell through and showed ~128x too small. Both client and
  // server now accept GL/GAL/GALLON/GALLONS (case-folded).
  it('LIQUID gallon aliases {GAL, gal, Gallon, GALLON, GALLONS} → 1:1 gallons (server == client)', () => {
    for (const u of ['GAL', 'gal', 'Gallon', 'GALLON', 'GALLONS']) {
      expect(toGallonOrLbEquivalent(10, u, 'liquid')).toEqual({ value: 10, unit: 'gal' });
      expect(toGallonOrLbEquivalent(10, u, 'liquid')).toEqual(serverGlLb(10, u, 'liquid'));
    }
  });

  it('an UNRECOGNIZED liquid unit → null (was a silent /128 guess on the server)', () => {
    expect(toGallonOrLbEquivalent(10, 'widgets', 'liquid')).toBeNull();
    expect(toGallonOrLbEquivalent(10, 'widgets', 'liquid')).toEqual(serverGlLb(10, 'widgets', 'liquid'));
  });

  // FIX 3 regression guard (Codex re-review): NULL-on-unknown must NOT drop the
  // valid fluid-ounce spellings the field app emits, nor the dry pound/ton spellings.
  it('LIQUID fluid-ounce spellings {fl oz, floz, fluid ounce} → q/128 gallons (server == client)', () => {
    for (const u of ['fl oz', 'floz', 'fluid ounce']) {
      expect(toGallonOrLbEquivalent(128, u, 'liquid')).toEqual({ value: 1, unit: 'gal' });
      expect(toGallonOrLbEquivalent(128, u, 'liquid')).toEqual(serverGlLb(128, u, 'liquid'));
    }
  });

  it('DRY pound/ton spellings {lbs, pound, ton} match the server', () => {
    expect(toGallonOrLbEquivalent(10, 'lbs', 'dry')).toEqual(serverGlLb(10, 'lbs', 'dry'));   // 10 LB
    expect(toGallonOrLbEquivalent(10, 'pound', 'dry')).toEqual(serverGlLb(10, 'pound', 'dry')); // 10 LB
    expect(toGallonOrLbEquivalent(2, 'ton', 'dry')).toEqual({ value: 4000, unit: 'lb' });     // 2*2000
    expect(toGallonOrLbEquivalent(2, 'ton', 'dry')).toEqual(serverGlLb(2, 'ton', 'dry'));
  });

  it('DRY oz / lb → POUNDS, equal to the server (keeps the existing dry-oz case)', () => {
    expect(toGallonOrLbEquivalent(80, 'oz', 'dry')).toEqual({ value: 5, unit: 'lb' }); // 80/16 = 5 LB
    expect(toGallonOrLbEquivalent(80, 'oz', 'dry')).toEqual(serverGlLb(80, 'oz', 'dry'));
    expect(toGallonOrLbEquivalent(5, 'lb', 'dry')).toEqual(serverGlLb(5, 'lb', 'dry'));
  });

  it('a unit that does not belong to the product form → null (never a guessed number)', () => {
    expect(toGallonOrLbEquivalent(10, 'lb', 'liquid')).toBeNull(); // pounds on a liquid product
    expect(toGallonOrLbEquivalent(10, 'qt', 'dry')).toBeNull();    // quarts on a dry product
  });

  // FIX 1 (Wave 2b) call-site regression: the JobDetail Chemicals-tab gal/lb PREVIEW
  // (JobDetail.tsx ~2639) previously called toGallonOrLbEquivalent(qty, unit) WITHOUT
  // the product's form, so a LIQUID line in bare 'oz' took the legacy unit-only branch
  // and was mis-classified as POUNDS (oz = 1/16 lb) — disagreeing with the saved /
  // invoiced value (server convert_to_gl_lb treats liquid oz as FLUID ounces = 1/128
  // gal). The fix resolves product_form from allProducts and passes it. This mirrors
  // that exact call-site resolution to lock in the gallons (not pounds) classification.
  it('JobDetail preview call site: liquid product in bare oz resolves to GALLONS, not pounds', () => {
    const allProducts = [
      { id: 'p-liquid', product_form: 'liquid' as const },
      { id: 'p-dry', product_form: 'dry' as const },
      { id: 'p-unknown', product_form: null },
    ];
    const resolveForm = (productId: string) => {
      const f = allProducts.find((p) => p.id === productId)?.product_form ?? null;
      return f === 'liquid' || f === 'dry' ? f : null;
    };
    // 80 oz of a LIQUID product → 0.625 gal (NOT 5 lb) — the bug FIX 1 closes.
    expect(toGallonOrLbEquivalent(80, 'oz', resolveForm('p-liquid'))).toEqual({ value: 0.625, unit: 'gal' });
    expect(toGallonOrLbEquivalent(80, 'oz', resolveForm('p-liquid'))).toEqual(serverGlLb(80, 'oz', 'liquid'));
    // A DRY product in oz still reads as pounds (unchanged).
    expect(toGallonOrLbEquivalent(80, 'oz', resolveForm('p-dry'))).toEqual({ value: 5, unit: 'lb' });
    // An unknown-form product falls back to the legacy unit-only inference.
    expect(toGallonOrLbEquivalent(80, 'oz', resolveForm('p-unknown'))).toEqual({ value: 5, unit: 'lb' });
  });
});

describe('chemCalculator — baseUnitOfRate (strip the per-acre suffix)', () => {
  it('strips /ac, /acre, /a', () => {
    expect(baseUnitOfRate('pt/ac')).toBe('pt');
    expect(baseUnitOfRate('PT/ACRE')).toBe('pt');
    expect(baseUnitOfRate('gal/a')).toBe('gal');
  });
  it('strips a spelled-out per acre', () => {
    expect(baseUnitOfRate('pt per acre')).toBe('pt');
  });
  it('a bare unit with no suffix is returned lowercased', () => {
    expect(baseUnitOfRate('GAL')).toBe('gal');
  });
  it('blank in → blank out', () => {
    expect(baseUnitOfRate('')).toBe('');
    expect(baseUnitOfRate(null)).toBe('');
    expect(baseUnitOfRate(undefined)).toBe('');
  });
});

// ── P1 MONEY fix: the bug was stock unit (GAL) != rate base unit (pt) → the saved
// row read "240 GAL" with per-GAL cost/price, inflating cost/price/loader ~8×. ──
describe('chemCalculator — reconcileChemAutofillUnits (P1 money fix)', () => {
  it('THE BUG CASE: GAL stock + pt/ac rate → unit pt, cost/price per pint (÷8), so the line is NOT ~8× inflated', () => {
    // Roundup PowerMax: unit_size=GAL, rate_unit=pt/ac, cost $22.50/GAL (2250¢),
    // tier1 price $28.00/GAL (2800¢), liquid. 1 GAL = 8 pt.
    const r = reconcileChemAutofillUnits('GAL', 'pt/ac', 2250, 2800, 'liquid');
    expect(r.unit).toBe('pt');                 // NOT 'GAL'
    expect(r.costPerUnitCents).toBe(281);      // 2250 / 8 = 281.25 → 281¢ per pint
    expect(r.pricePerUnitCents).toBe(350);     // 2800 / 8 = 350¢ per pint

    // 1.5 pt/ac × 160 ac = 240 (pints). The grid bills quantity × per-unit cents.
    const quantity = 1.5 * 160; // 240
    const lineCost = quantity * r.costPerUnitCents;   // 240 × 281 = 67,440¢ = $674.40
    const linePrice = quantity * r.pricePerUnitCents; // 240 × 350 = 84,000¢ = $840.00

    // The BUGGY row would have billed 240 × per-GAL cents:
    const buggyLineCost = quantity * 2250;   // 540,000¢ = $5,400 (≈8× too high)
    const buggyLinePrice = quantity * 2800;  // 672,000¢ = $6,720

    // Correct line ≈ the gal-equivalent (30 gal) × per-GAL price.
    expect(lineCost).toBe(67440);
    expect(linePrice).toBe(84000);
    // 30 gal × $22.50 = $675 (off by the 281 vs 281.25 rounding); within 1%.
    expect(Math.abs(lineCost - 30 * 2250)).toBeLessThan(2250 * 0.01 * 30);
    expect(linePrice).toBe(30 * 2800); // 84,000 exactly
    // And it is ~8× below the bug.
    expect(buggyLineCost / lineCost).toBeCloseTo(8, 0);
    expect(buggyLinePrice / linePrice).toBe(8);
  });

  it('SAME-UNIT case is unchanged: stock unit == rate base unit (most products)', () => {
    // unit_size=pt, rate_unit=pt/ac → no conversion; stock cost/price kept verbatim.
    const r = reconcileChemAutofillUnits('pt', 'pt/ac', 1000, 1500, 'liquid');
    expect(r.unit).toBe('pt');
    expect(r.costPerUnitCents).toBe(1000);
    expect(r.pricePerUnitCents).toBe(1500);
  });

  it('dry product: LB stock + oz/ac rate → unit oz, cost ÷16', () => {
    const r = reconcileChemAutofillUnits('LB', 'oz/ac', 1600, 3200, 'dry');
    expect(r.unit).toBe('oz');
    expect(r.costPerUnitCents).toBe(100);  // 1600 / 16
    expect(r.pricePerUnitCents).toBe(200); // 3200 / 16
  });

  it('infers the form from the stock unit when product_form is omitted', () => {
    const r = reconcileChemAutofillUnits('GAL', 'qt/ac', 400, 800); // 1 GAL = 4 qt
    expect(r.unit).toBe('qt');
    expect(r.costPerUnitCents).toBe(100); // 400 / 4
    expect(r.pricePerUnitCents).toBe(200);
  });

  it('SAFE FALLBACK: unknown / unreconcilable units keep the stock unit + per-stock cost/price', () => {
    // unknown stock unit → can't convert → keep as-is (no worse than before, no guess).
    const r1 = reconcileChemAutofillUnits('widgets', 'pt/ac', 1000, 2000, 'liquid');
    expect(r1).toEqual({ unit: 'widgets', costPerUnitCents: 1000, pricePerUnitCents: 2000 });
    // cross-form (liquid stock, dry-only rate unit) → don't guess, keep stock.
    const r2 = reconcileChemAutofillUnits('GAL', 'lb/ac', 1000, 2000, 'liquid');
    expect(r2).toEqual({ unit: 'GAL', costPerUnitCents: 1000, pricePerUnitCents: 2000 });
    // no rate unit → keep stock.
    const r3 = reconcileChemAutofillUnits('GAL', '', 1000, 2000, 'liquid');
    expect(r3).toEqual({ unit: 'GAL', costPerUnitCents: 1000, pricePerUnitCents: 2000 });
  });
});
