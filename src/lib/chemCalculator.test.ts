import { describe, it, expect } from 'vitest';
import {
  fmt4,
  sumAcres,
  applyChemEdit,
  recomputeChemRowForAcres,
  toGallonOrLbEquivalent,
  fieldAppPricedQuantity,
  baseUnitOfRate,
  reconcileChemAutofillUnits,
  chemLineBillingHazard,
  rateDenominatorIsUnrecognized,
  type ChemCalcRow,
} from './chemCalculator';
import { normalizeRateUnit } from './labelGuardrails';

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

describe('chemCalculator — fieldAppPricedQuantity (PARKED-010 field-app billing unit fix)', () => {
  it('converts oz → gallons for a liquid product (÷128)', () =>
    expect(fieldAppPricedQuantity(3200, 'oz', 'Gal', 'liquid')).toBe(25));
  it('converts qt → gallons for a liquid product (÷4)', () =>
    expect(fieldAppPricedQuantity(100, 'qt', 'Gal', 'liquid')).toBe(25));
  it('converts oz → quarts for a liquid product (÷32)', () =>
    expect(fieldAppPricedQuantity(100, 'oz', 'Qt', 'liquid')).toBe(3.125));
  it('converts dry oz → pounds for a dry product (÷16)', () =>
    expect(fieldAppPricedQuantity(3200, 'Dry oz', 'Lb', 'dry')).toBe(200));
  it('is identity when the rate unit already equals the sold unit (never breaks a correct line)', () => {
    expect(fieldAppPricedQuantity(100, 'oz', 'Oz', 'liquid')).toBe(100);
    expect(fieldAppPricedQuantity(600, 'MG', 'MG', 'dry')).toBe(600);
  });
  it('is case-insensitive on the unit text', () =>
    expect(fieldAppPricedQuantity(128, 'OZ', 'gAlLoN', 'liquid')).toBe(1));
  it('returns null when the units genuinely do not convert (caller must block, not mis-bill)', () => {
    expect(fieldAppPricedQuantity(195, 'oz', 'Unit', null)).toBeNull();
    expect(fieldAppPricedQuantity(50, 'oz', 'Ea', null)).toBeNull();
  });
  it('returns null for a non-finite quantity', () =>
    expect(fieldAppPricedQuantity(NaN, 'oz', 'Gal', 'liquid')).toBeNull());

  it('pricing the converted qty fixes the ~128× overcharge (16 oz/ac × 100 ac @ $32.10/gal)', () => {
    const appliedOz = 16 * 100;                 // 1,600 oz applied
    const pricePerGalCents = 3210;              // $32.10 / gal
    const pricedQty = fieldAppPricedQuantity(appliedOz, 'oz', 'Gal', 'liquid');
    expect(pricedQty).toBe(12.5);               // 1,600 oz = 12.5 gal
    const extendedCents = Math.round((pricedQty as number) * pricePerGalCents);
    expect(extendedCents).toBe(40125);          // $401.25 (was 1600 × 3210 = $51,360)
  });
});

describe('chemCalculator — chemLineBillingHazard (production fail-closed guard)', () => {
  // The live defect: 'Dry oz' is absent from DRY_TO_POUNDS, so reconcile bails to its
  // safe fallback and leaves the price per POUND while the quantity counts OUNCES.
  it('catches the live Dry oz/Lb 16x over-bill and reports the exact ratio', () => {
    const h = chemLineBillingHazard(
      { quantity: '3200', rate_per_acre: '32', rate_unit: 'Dry oz/ac', unit: 'Lb' },
      100,
      'dry',
    );
    expect(h.hazard).toBe(true);
    expect(h.quantityUnit).toBe('dry oz');
    expect(h.priceUnit).toBe('lb');
    expect(h.billedRatio).toBe(16);
    // Proves the money: 3,200 x $1.50 = $4,800 against a true 200 lb x $1.50 = $300.
    expect(Math.round(3200 * 150)).toBe(480000);
    expect(Math.round((3200 / (h.billedRatio as number)) * 150)).toBe(30000);
  });

  it('catches the liquid pt/Gal 8x case too', () => {
    const h = chemLineBillingHazard(
      { quantity: '240', rate_per_acre: '1.5', rate_unit: 'pt/ac', unit: 'GAL' },
      160,
      'liquid',
    );
    expect(h.hazard).toBe(true);
    expect(h.billedRatio).toBe(8);
  });

  it('does NOT flag an aligned row (the common, correct case)', () => {
    expect(chemLineBillingHazard(
      { quantity: '240', rate_per_acre: '1.5', rate_unit: 'pt/ac', unit: 'pt' }, 160, 'liquid',
    ).hazard).toBe(false);
  });

  it('does NOT flag a quantity already carried into the price unit', () => {
    // 1.5 pt/ac x 100 ac = 150 pt = 18.75 gal — hand-converted correctly.
    expect(chemLineBillingHazard(
      { quantity: '18.75', rate_per_acre: '1.5', rate_unit: 'pt/ac', unit: 'Gal' }, 100, 'liquid',
    ).hazard).toBe(false);
  });

  it('does NOT flag a blank unit (a separate, pre-existing condition)', () => {
    expect(chemLineBillingHazard(
      { quantity: '240', rate_per_acre: '1.5', rate_unit: 'pt/ac', unit: '' }, 160, 'liquid',
    ).hazard).toBe(false);
  });

  describe('VOLUME PRICED AS WEIGHT — the units-are-equal fast path was a hole (Codex P2)', () => {
    // normalizeRateUnit folds 'fl oz' into 'oz' (mirroring the live SQL normalize_rate_unit),
    // so a DRY line rated in fl oz/ac and priced per oz compared EQUAL and exited "safe" —
    // pricing a volume as though it were a weight. Product rate units are unvalidated free
    // text from the CSV import, so this shape is reachable.
    const DRY_FL_OZ = { quantity: '100', rate_per_acre: '1', rate_unit: 'fl oz/ac', unit: 'oz' };

    it('proves the collapse that caused it: both spellings normalize to the same token', () => {
      expect(normalizeRateUnit(baseUnitOfRate('fl oz/ac'))).toBe('oz');
      expect(normalizeRateUnit('oz')).toBe('oz');
    });

    it('FLAGS a dry product measured in fl oz but priced per oz', () => {
      const h = chemLineBillingHazard(DRY_FL_OZ, 100, 'dry');
      expect(h.hazard).toBe(true);
      // No ratio is claimed: volume→weight needs a density this app does not store.
      expect(h.billedRatio).toBeNull();
    });

    it('reports the RAW spellings, so the message is readable', () => {
      // Reporting the normalized units would read "measured in oz but priced per oz".
      const h = chemLineBillingHazard(DRY_FL_OZ, 100, 'dry');
      expect(h.quantityUnit).toBe('fl oz');
      expect(h.priceUnit).toBe('oz');
    });

    it('leaves a LIQUID product alone — there, bare oz really does mean fluid ounces', () => {
      expect(chemLineBillingHazard(DRY_FL_OZ, 100, 'liquid').hazard).toBe(false);
      // and with the form unknown, nothing about volume-vs-weight is claimed either.
      expect(chemLineBillingHazard(DRY_FL_OZ, 100, null).hazard).toBe(false);
    });

    it('leaves a dry product alone when both sides are a DRY ounce', () => {
      expect(chemLineBillingHazard(
        { quantity: '100', rate_per_acre: '1', rate_unit: 'oz/ac', unit: 'oz' }, 100, 'dry',
      ).hazard).toBe(false);
    });

    it('does not fire on a blank or zero quantity — a fresh row is not born warning', () => {
      for (const q of ['', '0']) {
        expect(chemLineBillingHazard({ ...DRY_FL_OZ, quantity: q }, 100, 'dry').hazard).toBe(false);
      }
    });
  });

  describe('FLUID OUNCE ON A DRY PRODUCT — refused outright, on either side, however spelled', () => {
    // Aligns this guard with the predicate in migration 20260820120000 (PR #446), which
    // reached this shape over three review rounds. A client guard that is MORE LENIENT than
    // the SQL doing the billing is worse than no client guard: the operator passes the
    // browser, then hits a hard save refusal with nothing on screen explaining it — and
    // because performSave re-sends the whole grid, one such line makes the entire job
    // unsaveable, memo included.
    const dry = (rate_unit: string, unit: string) =>
      chemLineBillingHazard({ quantity: '100', rate_per_acre: '1', rate_unit, unit }, 100, 'dry');

    it('refuses a dry line when BOTH sides are fluid ounces (this assertion was inverted)', () => {
      // Self-consistent, so the old exclusive-or test read it as safe. But
      // fieldAppPricedQuantity's dry branch sizes 'fl oz' as null — unpriceable — so the
      // totals were being derived from a volume on a product billed by weight.
      expect(dry('fl oz/ac', 'fl oz').hazard).toBe(true);
      expect(dry('fl oz/ac', 'fl oz').billedRatio).toBeNull();
    });

    it('refuses the CONVERSION path the exclusive-or never even reached', () => {
      // 'fl oz' normalizes to 'oz' before the converter sees it, which then sizes it 1 and
      // converts 16:1 into pounds — turning a volume into a weight with nothing proven.
      expect(dry('fl oz/ac', 'lb').hazard).toBe(true);
    });

    it('catches the PERIOD spellings that a literal list missed', () => {
      // normalizeRateUnit has no SYNONYMS arm for these, so both sides normalize to the same
      // token and the line sailed past both the spelling list and the equality fast path.
      for (const spelling of ['fl. oz', 'fl.oz', 'Fl. Oz.', 'fl . oz']) {
        expect(dry(`${spelling}/ac`, spelling).hazard).toBe(true);
        expect(dry(`${spelling}/ac`, 'lb').hazard).toBe(true);
      }
    });

    it('catches the long and plural spellings too', () => {
      // Both sides carry the SAME spelling deliberately, so the units-are-equal exit would
      // wave the line through and only the fluid rule can refuse it. Written against 'lb'
      // instead, these would pass on the ordinary unit-mismatch rule even with the fluid
      // helper broken — a test that goes green for the wrong reason pins nothing.
      for (const spelling of ['fluid oz', 'fl ounces', 'fl ozs', 'fluid ounce', 'FLUID OUNCES', 'floz']) {
        expect(dry(`${spelling}/ac`, spelling).hazard).toBe(true);
      }
    });

    it('does NOT fire on a bare oz — on a dry product that is a legitimate dry ounce', () => {
      // The rule must stay narrow. Refusing bare 'oz' would block ordinary dry jobs.
      expect(dry('oz/ac', 'oz').hazard).toBe(false);
      expect(dry('dry oz/ac', 'oz').hazard).toBe(false);
    });

    it('does not OVER-match — the regex is anchored, so a longer word is not a fluid ounce', () => {
      // Both sides identical, so the units-are-equal exit is the only thing that can save
      // these. If the anchored regex ever loosened to a substring test, the fluid rule would
      // fire first and refuse them — which is what these pin.
      for (const spelling of ['flour oz', 'oz fl', 'fluid', 'oz', 'gal fl oz']) {
        expect(dry(`${spelling}/ac`, spelling).hazard).toBe(false);
      }
    });

    it('leaves LIQUID and unknown-form products untouched', () => {
      // On a liquid product 'oz' IS 'fl oz' — the live unit_conversions table records both
      // at factor 1 — so this rule must not move a single liquid line.
      for (const form of ['liquid', null] as const) {
        expect(chemLineBillingHazard(
          { quantity: '100', rate_per_acre: '1', rate_unit: 'fl oz/ac', unit: 'fl oz' }, 100, form,
        ).hazard).toBe(false);
      }
    });
  });

  it('DOES flag a quantity matching neither reading — unprovable is not safe', () => {
    // This assertion used to be inverted, and that inversion WAS the bypass: any row whose
    // quantity drifted from rate x acres escaped the guard entirely. Fail closed instead.
    // The deliberate cost is a false positive on a hand-entered third-unit quantity, which
    // the operator clears by making the units agree.
    expect(chemLineBillingHazard(
      { quantity: '77', rate_per_acre: '1.5', rate_unit: 'pt/ac', unit: 'Gal' }, 160, 'liquid',
    ).hazard).toBe(true);
  });

  it('SURVIVES AN ACREAGE CHANGE — the everyday off switch the guard used to have', () => {
    // The live shape: 32 Dry oz/ac priced per Lb, saved over 100 acres as 3,200.
    const row = { quantity: '3200', rate_per_acre: '32', rate_unit: 'Dry oz/ac', unit: 'Lb' };
    expect(chemLineBillingHazard(row, 100, 'dry').hazard).toBe(true);

    // A reloaded row deliberately KEEPS its saved quantity when the acreage moves (the
    // driver is not persisted, so it must not be re-derived). The quantity therefore stops
    // equalling rate x acres — which is exactly when the old guard fell silent, on the very
    // row that was mislabelled to begin with.
    const afterAcreageChange = chemLineBillingHazard(row, 200, 'dry');
    expect(afterAcreageChange.hazard).toBe(true);
    // And the ratio stays truthful: 3,200 oz is 200 lb, so the bill is still 16x.
    expect(afterAcreageChange.billedRatio).toBe(16);
  });

  it('tolerates the 4-dp rounding fmt4 applies to a stored quantity', () => {
    // 1.7 oz/ac x 137 ac = 232.9 exactly; fmt4 can store 232.9001 without hiding the hazard.
    expect(chemLineBillingHazard(
      { quantity: '232.9001', rate_per_acre: '1.7', rate_unit: 'oz/ac', unit: 'Gal' }, 137, 'liquid',
    ).hazard).toBe(true);
  });

  it('is driver-independent — a reloaded row carries no driver and must still be caught', () => {
    // Every row loaded from the database has driver === undefined; a driver-gated
    // check would miss all of them. This row simply has no driver field at all.
    expect(chemLineBillingHazard(
      { quantity: '3200', rate_per_acre: '32', rate_unit: 'Dry oz/ac', unit: 'Lb' }, 100, 'dry',
    ).hazard).toBe(true);
  });

  it('never throws on an inherited-property rate unit (CSV import writes rate_unit unvalidated)', () => {
    for (const evil of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
      expect(() => chemLineBillingHazard(
        { quantity: '10', rate_per_acre: '1', rate_unit: evil, unit: 'Gal' }, 10, 'liquid',
      )).not.toThrow();
    }
  });

  it('STILL flags when acres are unknown or the rate is absent — no proof, no pass', () => {
    // Also previously inverted. A missing rate or acreage means the safety proof cannot be
    // computed; that is a reason to keep the warning up, not to drop it. Both of these are
    // the live 16x shape with one input missing.
    expect(chemLineBillingHazard(
      { quantity: '3200', rate_per_acre: '32', rate_unit: 'Dry oz/ac', unit: 'Lb' }, 0, 'dry',
    ).hazard).toBe(true);
    expect(chemLineBillingHazard(
      { quantity: '3200', rate_per_acre: '', rate_unit: 'Dry oz/ac', unit: 'Lb' }, 100, 'dry',
    ).hazard).toBe(true);
  });

  it('stays silent on an empty or zero quantity, so a fresh row is not born warning', () => {
    for (const q of ['', '0']) {
      expect(chemLineBillingHazard(
        { quantity: q, rate_per_acre: '', rate_unit: 'Dry oz/ac', unit: 'Lb' }, 0, 'dry',
      ).hazard).toBe(false);
    }
  });

  it('still flags when the form is unknown and no ratio can be computed', () => {
    const h = chemLineBillingHazard(
      { quantity: '3200', rate_per_acre: '32', rate_unit: 'Dry oz/ac', unit: 'Lb' }, 100, null,
    );
    expect(h.hazard).toBe(true);      // fail closed
    expect(h.billedRatio).toBeNull(); // 'dry oz' is not a liquid unit — ratio unknowable
  });
});

describe('chemCalculator — rateDenominatorIsUnrecognized (the original divergence)', () => {
  it('flags a NON-acre denominator, which baseUnitOfRate silently strips', () => {
    for (const u of ['oz/cwt', 'fl oz/100 gal', 'L/ha', 'oz/1000 sq ft', 'pt/ton']) {
      expect(rateDenominatorIsUnrecognized(u)).toBe(true);
      // The reason it matters: the base unit comes back as if it were a per-acre rate.
      expect(baseUnitOfRate(u)).not.toContain('/');
    }
  });

  it('accepts every per-acre spelling the app actually uses', () => {
    for (const u of ['pt/ac', 'oz/acre', 'gal/a', 'lb/acres', 'GAL per acre', 'Dry oz/ac']) {
      expect(rateDenominatorIsUnrecognized(u)).toBe(false);
    }
  });

  it('accepts a bare unit and a blank', () => {
    for (const u of ['oz', 'Dry oz', 'GAL', '', '   ', null, undefined]) {
      expect(rateDenominatorIsUnrecognized(u)).toBe(false);
    }
  });
});

describe('chemCalculator — a RELOADED row is never rewritten (Codex P1 revert)', () => {
  // An earlier pass inferred driver === 'rate' from `quantity == rate x acres` and let an
  // acreage change re-derive the quantity. That is unsound: applyChemEdit back-solves
  // rate_per_acre when the user TYPES a quantity, so a hand-entered total satisfies the
  // same equality by construction. These pin the safe behaviour so it cannot regress.
  it('a hand-entered quantity produces the very equality the heuristic relied on', () => {
    // updateChemRow writes the typed value into the row FIRST, then calls applyChemEdit on
    // it — applyChemEdit only back-solves the other side. Mirror that here.
    const typed = applyChemEdit(row({ rate_per_acre: '', quantity: '150' }), 'quantity', '150', 100);
    expect(typed.driver).toBe('qty');
    expect(typed.rate_per_acre).toBe('1.5');
    // 1.5 x 100 === 150 exactly — indistinguishable from a rate-driven row once reloaded.
    expect(parseFloat(typed.rate_per_acre) * 100).toBe(parseFloat(typed.quantity));
  });

  it('leaves a driverless row exactly as saved when the acreage changes', () => {
    const reloaded = row({ quantity: '150', rate_per_acre: '1.5' });  // no driver, as loaded
    expect(recomputeChemRowForAcres(reloaded, 200).quantity).toBe('150');
    expect(recomputeChemRowForAcres(reloaded, 50).quantity).toBe('150');
  });
});

