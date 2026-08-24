/**
 * chemCalculator — the "Chem Man" 3-way rate / acres / quantity calculator used by the
 * job chemical grid (JobDetail). Pure + framework-free so the billing math is unit-tested
 * in isolation (see chemCalculator.test.ts). quantity = rate_per_acre × total acres.
 *
 * The three flows the calculator supports:
 *  • set the per-acre RATE   → quantity is filled  = rate × acres   (driver = 'rate')
 *  • type a total QUANTITY    → rate is back-solved = quantity / acres (driver = 'qty')
 *  • change the ACRES         → the row's DRIVER side is held and the other re-derived
 */

import { normalizeRateUnit } from './labelGuardrails';

export type ChemDriver = 'rate' | 'qty';

/** The minimal row shape the calculator reads/writes. JobDetail's ChemRow is a superset. */
export interface ChemCalcRow {
  quantity: string;
  rate_per_acre: string;
  /** UI-only (NOT persisted): which field the user last drove. */
  driver?: ChemDriver;
}

/** Round to 4 dp and stringify (the grid stores numbers as strings). */
export const fmt4 = (x: number): string => (Math.round(x * 10000) / 10000).toString();

/** Total acres across the job's field rows. */
export function sumAcres(fieldRows: { acres_to_treat: string }[]): number {
  return fieldRows.reduce((s, f) => s + (parseFloat(f.acres_to_treat) || 0), 0);
}

/**
 * Apply a calculator edit to a chem row (the row must ALREADY carry the new `key`=`value`).
 * Records the `driver` flag whenever the user edits the rate or quantity — EVEN with no
 * fields selected yet (`acres === 0`). The DERIVED value (quantity from rate, or rate from
 * quantity) needs acres, so it is only computed when `acres > 0`; but the driver must be set
 * now so that adding fields later (recomputeChemRowForAcres) fills the derived value in.
 * Without recording the driver at acres === 0, a rate (or total) entered BEFORE fields were
 * chosen would be silently dropped and the job would persist a 0 / stale quantity. A blank
 * value leaves the row alone, so a flat / quantity-only line still works. Returns a NEW row.
 */
export function applyChemEdit<T extends ChemCalcRow>(
  row: T,
  key: string,
  value: string,
  acres: number,
): T {
  if (key === 'rate_per_acre' && value.trim() !== '') {
    const rate = parseFloat(value);
    if (!Number.isNaN(rate)) {
      return { ...row, driver: 'rate', ...(acres > 0 ? { quantity: fmt4(rate * acres) } : {}) };
    }
  }
  if (key === 'quantity' && value.trim() !== '') {
    const qty = parseFloat(value);
    if (!Number.isNaN(qty)) {
      return { ...row, driver: 'qty', ...(acres > 0 ? { rate_per_acre: fmt4(qty / acres) } : {}) };
    }
  }
  return row;
}

/**
 * Re-derive a chem row when total acres change. Safe for `acres === 0` (the caller no
 * longer early-returns) so removing the last field clears a derived quantity.
 *  • driver 'rate' → quantity = rate × acres, re-derived on EVERY acreage change INCLUDING
 *                    acres dropping to 0 (→ quantity 0). Otherwise a removed-field job keeps
 *                    a stale billable quantity for 0 acres. (Codex r16)
 *  • driver 'qty'  → HOLD the user's typed total; refigure the rate only when acres > 0
 *                    (never silently rewrite a hand-entered total, and never divide by 0).
 *  • no driver     → an untouched / RELOADED line is left exactly as saved (an acreage
 *                    change must not rewrite a persisted quantity whose origin is unknown).
 * Returns a NEW row when it changes, otherwise the same row reference.
 */
export function recomputeChemRowForAcres<T extends ChemCalcRow>(row: T, acres: number): T {
  const rate = parseFloat(row.rate_per_acre);
  const qty = parseFloat(row.quantity);
  if (row.driver === 'rate') {
    return row.rate_per_acre.trim() !== '' && !Number.isNaN(rate)
      ? { ...row, quantity: fmt4(rate * acres) }
      : row;
  }
  if (row.driver === 'qty') {
    return acres > 0 && row.quantity.trim() !== '' && !Number.isNaN(qty) && qty !== 0
      ? { ...row, rate_per_acre: fmt4(qty / acres) }
      : row;
  }
  return row;
}

// `inferChemDriver` USED TO LIVE HERE AND WAS REMOVED AS UNSOUND. It tried to recover a
// reloaded row's lost `driver` by testing whether quantity == rate × acres. That test cannot
// work: applyChemEdit back-solves rate_per_acre whenever the user types a quantity, so a
// HAND-ENTERED total satisfies the same equality by construction. Acting on it would rewrite
// an operator's typed chemical amount whenever the acreage changed. Do not reintroduce a
// heuristic here — the driver must be PERSISTED on job_chemicals to be trustworthy.
// (Codex P1, 2026-08-20)

// ── Total Applied + gallon/lb-equivalent conversion (ChemMan parity #1) ──────
//
// ChemMan's Chemical/Charges tab shows, per product line, the "Total Applied"
// (the quantity column already = rate × total acres) AND a converted
// gallon-or-pound equivalent so the loader can plan tank loads.
//
// THE SERVER IS AUTHORITATIVE. The field-app invoice save RPC computes the
// saved/printed value via the SQL fn `convert_to_gl_lb(total_applied, rate_unit,
// product_form)` (migration 20260219200000), which chooses gallons-vs-pounds
// from the PRODUCT FORM, not the unit text:
//   • product_form = 'dry'  → POUNDS:  oz = 1/16 lb,  lb = 1
//   • product_form = liquid → GALLONS: oz = 1/128 gal, pt = 1/8, qt = 1/4, gal = 1
// So a LIQUID product dosed in bare 'oz' (the field-app default rate_unit) must
// preview as GALLONS — NOT pounds — to match the invoice + PDF. The #25 preview
// passes `product_form`; we replicate the server's branch exactly so the on-screen
// figure equals the saved one (loader/tank-planning depends on agreement).
//
// When `product_form` is omitted (the legacy job-grid loader worksheet in
// JobDetail, which has no product_form on its rows) we fall back to inferring
// liquid-vs-dry from the free-text unit string (the original behavior).
//
// An unrecognized OR product_form-mismatched unit returns null (the UI shows a
// dash) — we never guess a conversion we don't know.

/** Server-parity factors → GALLONS for a LIQUID product (matches convert_to_gl_lb's liquid branch). */
const LIQUID_TO_GALLONS: Record<string, number> = {
  gal: 1, gallon: 1, gallons: 1, gl: 1,
  qt: 1 / 4, quart: 1 / 4, quarts: 1 / 4,
  pt: 1 / 8, pint: 1 / 8, pints: 1 / 8,
  oz: 1 / 128, 'fl oz': 1 / 128, floz: 1 / 128, 'fluid ounce': 1 / 128,
};

/** Server-parity factors → POUNDS for a DRY product (matches convert_to_gl_lb's dry branch). */
const DRY_TO_POUNDS: Record<string, number> = {
  lb: 1, lbs: 1, pound: 1, pounds: 1,
  oz: 1 / 16, ounce: 1 / 16, ounces: 1 / 16,
  ton: 2000, tons: 2000,
};

/** Legacy free-text inference → gallons, used ONLY when product_form is unknown (JobDetail loader worksheet). */
const TO_GALLONS: Record<string, number> = {
  gal: 1, gallon: 1, gallons: 1, gl: 1,
  qt: 1 / 4, quart: 1 / 4, quarts: 1 / 4,
  pt: 1 / 8, pint: 1 / 8, pints: 1 / 8,
  'fl oz': 1 / 128, floz: 1 / 128, 'fluid ounce': 1 / 128,
};

/** Legacy free-text inference → pounds, used ONLY when product_form is unknown. */
const TO_POUNDS: Record<string, number> = {
  lb: 1, lbs: 1, pound: 1, pounds: 1,
  oz: 1 / 16, ounce: 1 / 16, ounces: 1 / 16,
  ton: 2000, tons: 2000,
};

export interface AppliedConversion {
  /** The converted magnitude (e.g. 30 if 240 pints → 30 gal). */
  value: number;
  /** Which equivalent the value is expressed in. */
  unit: 'gal' | 'lb';
}

/** 4-dp rounding — matches the server's ROUND(..., 4) on the saved gl/lb value. */
const round4 = (x: number): number => Math.round(x * 10000) / 10000;

/**
 * Convert a total-applied quantity to its gallon (liquid) or pound (dry)
 * equivalent for the on-screen preview. Returns null for a blank/zero quantity,
 * an unrecognized unit, or a unit that doesn't belong to the product's form
 * (caller renders a dash — never a guessed number). Pure + tested.
 *
 * @param productForm  when 'liquid' or 'dry', the gal/lb choice is taken from the
 *   product form to MATCH the server `convert_to_gl_lb` (the #25 field-app preview).
 *   When omitted/null, the form is inferred from the free-text unit (legacy path).
 */
export function toGallonOrLbEquivalent(
  quantity: number,
  unit: string | null | undefined,
  productForm?: 'liquid' | 'dry' | null,
): AppliedConversion | null {
  if (!Number.isFinite(quantity) || quantity === 0) return null;
  const key = (unit || '').trim().toLowerCase();
  if (key === '') return null;

  // #25 field-app preview: branch on product_form so screen == saved/PDF.
  if (productForm === 'dry') {
    if (key in DRY_TO_POUNDS) return { value: round4(quantity * DRY_TO_POUNDS[key]), unit: 'lb' };
    return null; // a non-dry unit on a dry product → don't guess
  }
  if (productForm === 'liquid') {
    if (key in LIQUID_TO_GALLONS) return { value: round4(quantity * LIQUID_TO_GALLONS[key]), unit: 'gal' };
    return null; // a non-liquid unit on a liquid product → don't guess
  }

  // Legacy path (product_form unknown): infer liquid-vs-dry from the unit text.
  if (key in TO_GALLONS) return { value: round4(quantity * TO_GALLONS[key]), unit: 'gal' };
  if (key in TO_POUNDS) return { value: round4(quantity * TO_POUNDS[key]), unit: 'lb' };
  return null;
}

// ── Field-app pricing unit conversion (PARKED-010 MONEY fix) ─────────────────
//
// THE BUG this fixes (preview side). The field-app chemical line is billed as
// (rate × acres) × unit_price, where the applied amount (rate × acres) is in the
// RATE unit (e.g. oz) but unit_price is per the product's SOLD/inventory unit
// (e.g. $/gal). Without converting between them the line over-bills by the unit
// ratio (oz→gal = 128×). `fieldAppPricedQuantity` converts the applied amount into
// the sold unit so it can be priced at the per-sold-unit price. It MIRRORS the SQL
// fn `field_app_priced_quantity` used by save_field_app_invoice EXACTLY (same unit
// sets, identity when the units already match, null when they don't convert) so the
// on-screen preview equals the saved/invoiced amount.

/** Unit size in the form's base unit (liquid base = fluid ounce; dry base = ounce). */
const LIQUID_UNIT_SIZE: Record<string, number> = {
  oz: 1, 'fl oz': 1, floz: 1, 'fluid ounce': 1,
  pt: 16, pint: 16, pints: 16,
  qt: 32, quart: 32, quarts: 32,
  gl: 128, gal: 128, gallon: 128, gallons: 128,
};
const DRY_UNIT_SIZE: Record<string, number> = {
  oz: 1, 'dry oz': 1, ounce: 1, ounces: 1,
  lb: 16, lbs: 16, pound: 16, pounds: 16,
  ton: 32000, tons: 32000,
};

/**
 * Convert an applied quantity from its RATE unit into the product's SOLD (inventory)
 * unit, so it can be priced at the per-inventory-unit price. Mirrors the SQL fn
 * `field_app_priced_quantity` so the field-app preview equals the invoiced amount.
 *  • same unit (case-insensitive) → identity (no conversion; never breaks an already-correct line).
 *  • both units known in the product's form → qty × sizeOf(rateUnit) / sizeOf(invUnit).
 *  • not convertible (unknown unit, or different forms) → null (caller treats as unpriceable).
 * A null/unknown product_form is treated as liquid, matching the server.
 */
export function fieldAppPricedQuantity(
  appliedQty: number,
  rateUnit: string | null | undefined,
  inventoryUnit: string | null | undefined,
  productForm?: 'liquid' | 'dry' | null,
): number | null {
  if (!Number.isFinite(appliedQty)) return null;
  const r = (rateUnit || '').trim().toLowerCase();
  const i = (inventoryUnit || '').trim().toLowerCase();
  if (r === i) return appliedQty;            // same unit: no conversion needed
  if (r === '' || i === '') return null;
  const sizes = productForm === 'dry' ? DRY_UNIT_SIZE : LIQUID_UNIT_SIZE;
  const sr = sizes[r];
  const si = sizes[i];
  if (sr == null || si == null || si === 0) return null;  // not convertible
  return (appliedQty * sr) / si;
}

// ── Product-autofill unit reconciliation (P1 MONEY fix) ──────────────────────
//
// THE BUG this fixes. The job chem grid carries TWO units:
//   • rate_unit  (e.g. 'pt/ac')  — the per-acre dosing unit. quantity = rate × acres
//                                  is therefore expressed in this rate's BASE unit (pt).
//   • unit       (e.g. 'GAL')    — the measure unit OF that quantity; cost_per_unit_cents
//                                  and price_per_unit_cents are per THIS unit; it also
//                                  drives the gal/lb (loader) conversion.
// When a product's STOCK unit (products.unit_size, e.g. GAL) differs from its rate's
// base unit (pt), the old autofill set unit = stock unit (GAL) while quantity came out
// in pints — so the saved row read "240 GAL" instead of "240 pt", and because cost/price
// were per-GAL multiplied by a pint quantity, the line cost/price (and loader gallons)
// inflated ~8×. The fix expresses quantity, unit, AND cost/price in ONE consistent
// measure: the rate's base unit. cost/price are converted from per-stock-unit to
// per-base-unit with the SAME server-parity factor tables above.

/**
 * Does this raw unit spelling name a FLUID measure *explicitly*?
 *
 * Only the fluid-ounce spellings qualify. Everything else — including a bare 'oz' — is not
 * explicit: for a liquid product 'oz' means fluid ounces, for a dry product it means weight
 * ounces, and that ambiguity is exactly why the caller must know the product's form.
 *
 * Kept deliberately narrow and LOCAL to this file rather than folded into normalizeRateUnit:
 * that function mirrors the live SQL normalize_rate_unit, and the label-rate guardrail
 * compares against it. Changing the shared normalizer would drift the client away from the
 * server — the class of bug this whole branch exists to fix.
 */
function isExplicitlyFluidUnit(unit: string | null | undefined): boolean {
  const t = String(unit ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return t === 'fl oz' || t === 'floz' || t === 'fl. oz.' || t === 'fl oz.'
    || t === 'fluid ounce' || t === 'fluid ounces';
}

/**
 * Strip a per-acre suffix ('/ac', '/acre', '/a', ' per acre') from a rate_unit and
 * return the bare base measure unit (e.g. 'pt/ac' → 'pt', 'GAL' → 'gal'). Empty in →
 * empty out.
 */
export function baseUnitOfRate(rateUnit: string | null | undefined): string {
  const raw = (rateUnit || '').trim().toLowerCase();
  if (raw === '') return '';
  // take the part before the first '/' (handles 'pt/ac', 'pt/acre', 'pt/a')
  let base = raw.split('/')[0].trim();
  // also handle the spelled-out ' per acre' form
  base = base.replace(/\s+per\s+acre$/, '').trim();
  return base;
}

/**
 * Size of a unit within its product form (gallons for liquid, pounds for dry),
 * using the same server-parity tables as toGallonOrLbEquivalent. Returns null when
 * the unit is unknown for the given form.
 */
function unitSizeInForm(unitKey: string, form: 'liquid' | 'dry'): number | null {
  if (form === 'liquid') return unitKey in LIQUID_TO_GALLONS ? LIQUID_TO_GALLONS[unitKey] : null;
  return unitKey in DRY_TO_POUNDS ? DRY_TO_POUNDS[unitKey] : null;
}

export interface ChemAutofillUnits {
  /** The measure unit to store on the row (the rate's base unit when reconcilable). */
  unit: string;
  /** Per-`unit` cost in cents (converted from the per-stock-unit cost when units differ). */
  costPerUnitCents: number;
  /** Per-`unit` price in cents (converted from the per-stock-unit price when units differ). */
  pricePerUnitCents: number;
}

/**
 * Reconcile a product's autofill so the row's quantity, unit, and per-unit cost/price
 * are all in ONE measure — the rate's base unit — so quantity (= rate × acres, in the
 * rate's base unit) is billed and loader-converted correctly.
 *
 * Inputs are per the STOCK unit (products.unit_size): costPerStockCents, pricePerStockCents.
 *
 * Behavior:
 *  • No rate_unit, or stock base == rate base → returns the STOCK unit unchanged and the
 *    per-stock cost/price unchanged (the common case; NOTHING changes vs before).
 *  • Stock unit ≠ rate base unit, BOTH known in the same form → returns the rate's base
 *    unit and the cost/price CONVERTED to per-base-unit
 *    (perBase = perStock × sizeOf(baseUnit) / sizeOf(stockUnit)). Example: GAL→pt is
 *    1/8, so a $22.50/GAL cost becomes $2.8125/pt; 240 pt × $2.8125 = $675 = 30 gal ×
 *    $22.50 (the correct, NON-inflated amount).
 *  • Units can't be reconciled (unknown unit, or different forms) → SAFE FALLBACK: keep
 *    the STOCK unit + per-stock cost/price unchanged (never guess a conversion). This is
 *    the pre-fix behavior for those rows; the mismatch is at least no worse than before
 *    and the user can correct the unit/cost manually.
 *
 * Pure + tested (chemCalculator.test.ts).
 */
export function reconcileChemAutofillUnits(
  stockUnit: string | null | undefined,
  rateUnit: string | null | undefined,
  costPerStockCents: number,
  pricePerStockCents: number,
  productForm?: 'liquid' | 'dry' | null,
): ChemAutofillUnits {
  const stock = (stockUnit || '').trim();
  const stockKey = stock.toLowerCase();
  const baseKey = baseUnitOfRate(rateUnit);

  const fallback: ChemAutofillUnits = {
    unit: stock,
    costPerUnitCents: costPerStockCents,
    pricePerUnitCents: pricePerStockCents,
  };

  // No rate unit, or identical units → nothing to reconcile (common case).
  if (baseKey === '' || baseKey === stockKey || stockKey === '') return fallback;

  // Determine the form: trust product_form when given, else infer from the stock unit.
  let form: 'liquid' | 'dry' | null = productForm ?? null;
  if (form == null) {
    if (stockKey in LIQUID_TO_GALLONS) form = 'liquid';
    else if (stockKey in DRY_TO_POUNDS) form = 'dry';
  }
  if (form == null) return fallback;

  const stockSize = unitSizeInForm(stockKey, form);
  const baseSize = unitSizeInForm(baseKey, form);
  // Both units must be known in the SAME form to safely convert; otherwise don't guess.
  if (stockSize == null || baseSize == null || baseSize === 0) return fallback;

  // base-units per stock-unit = stockSize / baseSize (e.g. GAL/pt = 1 / (1/8) = 8).
  // per-base cost = per-stock cost / (base-units per stock-unit) = perStock × baseSize / stockSize.
  const perBaseFactor = baseSize / stockSize;
  return {
    unit: baseKey,
    costPerUnitCents: Math.round(costPerStockCents * perBaseFactor),
    pricePerUnitCents: Math.round(pricePerStockCents * perBaseFactor),
  };
}

// ── Billing-hazard guard (production fail-closed) ─────────────────────────────
//
// THE LIVE DEFECT this closes. A job chem row carries TWO units:
//   • rate_unit ('Dry oz/ac') — quantity is filled as rate × acres, so the NUMBER is
//     expressed in the RATE's base unit ('dry oz').
//   • unit      ('Lb')        — the unit the row's per-unit cost/price is quoted in.
// transfer_job_to_invoice bills safe_cents_qty(price_per_unit_cents, quantity) with NO unit
// conversion, so those two units MUST describe the same measure or the invoice is wrong by
// exactly their ratio.
//
// reconcileChemAutofillUnits normally keeps them aligned, but it sizes units off
// DRY_TO_POUNDS / LIQUID_TO_GALLONS, which mirror the DISPLAY function convert_to_gl_lb.
// That dry table has no 'dry oz' entry, so a 'Dry oz' rate against pound stock cannot be
// reconciled and takes the SAFE-FALLBACK branch: `unit` stays 'Lb' and the price stays per
// pound while the quantity is counted in ounces. 32 Dry oz/ac × 100 ac then bills
// 3,200 × $1.50 = $4,800 against a true $300 — 16× — and nothing on screen says so.
// 75 live products carry a 'Dry oz' rate (61 of them against pound stock).
//
// This guard deliberately changes NO money math — carrying the quantity into the selling
// unit is the separate, parked redesign. It only detects a row we can PROVE is mislabelled,
// so the save can be refused and a wrong invoice never created.

/**
 * True when a rate unit carries a denominator that is NOT acres — 'oz/cwt', 'fl oz/100 gal',
 * 'L/ha'. baseUnitOfRate strips everything after the first '/', so such a rate is silently
 * treated as per-ACRE and quantity is filled as rate × acres. For 'oz/cwt' (per hundredweight)
 * that is not merely a unit mismatch, it is the wrong quantity entirely, and it saves.
 *
 * This is the divergence the original investigation was opened for. The live SQL
 * `normalize_rate_unit` deliberately keeps such a string WHOLE so it can never match a bare
 * unit; the client's split-on-first-slash does the opposite. Measured across all 33
 * unit-bearing columns in the live database, NO stored value carries a non-acre denominator
 * (the only 3 slash values are 'pt/ac'), so this is hardening against a value the CSV product
 * import could introduce, not a defect with live rows behind it today.
 */
export function rateDenominatorIsUnrecognized(rateUnit: string | null | undefined): boolean {
  const raw = (rateUnit || '').trim().toLowerCase();
  if (raw === '') return false;
  if (/\s*\/\s*(?:ac|acre|acres|a)\s*$/.test(raw)) return false;  // a recognised per-acre rate
  if (/\s+per\s+acre$/.test(raw)) return false;
  return raw.includes('/');
}

export interface ChemBillingHazard {
  /** true only when the mislabelling is PROVEN (see below), never on suspicion. */
  hazard: boolean;
  /** The unit the quantity is actually counted in (the rate's base unit). */
  quantityUnit: string;
  /** The unit the per-unit cost/price is quoted in (the row's `unit`). */
  priceUnit: string;
  /** How many times too high the bill would be, when both units size in a known form. */
  billedRatio: number | null;
}

const NO_HAZARD: ChemBillingHazard = { hazard: false, quantityUnit: '', priceUnit: '', billedRatio: null };

/**
 * Detect a row whose quantity is measured in one unit but priced per another.
 *
 * PROOF STANDARD — FAIL CLOSED. The units disagreeing IS the hazard. We stay silent only
 * for a row that is provably fine:
 *  • either unit blank/unrecognized (a separate, pre-existing condition), or
 *  • the two units are the same, or
 *  • the quantity is exactly what rate × acres becomes once carried into the price's unit
 *    — the one thing that actually proves the quantity is expressed in the price's unit.
 * Everything else is flagged. An unprovable row is not a safe row.
 *
 * THE BYPASS THIS CLOSES (Codex, 2026-08-20). The previous version also returned safe when
 * the quantity matched NEITHER value, reasoning that it was "unprovable, so do not block".
 * That handed the guard an everyday off switch: a reloaded row deliberately keeps its saved
 * quantity when the acreage changes, so the quantity stops equalling rate × acres and the
 * warning vanished — on the very row that was mislabelled to begin with. Open a hazardous
 * job, edit the acres, and the protection disappeared silently.
 *
 * The trade is deliberate. A hand-entered quantity in a third unit is now flagged too. That
 * is a false positive the operator can clear by making the units agree; the alternative was
 * a guard that switched itself off during ordinary work.
 *
 * `billedRatio` is derived from the QUANTITY, not from rate × acres, so it stays truthful on
 * a stale row where the acreage has since moved.
 *
 * Driver-independent on purpose: `driver` is UI-only and is NOT persisted, so every
 * reloaded row has driver === undefined and a driver-gated check would miss them all.
 */
export function chemLineBillingHazard(
  row: { quantity: string; rate_per_acre: string; rate_unit?: string | null; unit?: string | null },
  acres: number,
  productForm?: 'liquid' | 'dry' | null,
): ChemBillingHazard {
  const rateBaseRaw = baseUnitOfRate(row.rate_unit);
  const quantityUnit = normalizeRateUnit(rateBaseRaw);
  const priceUnit = normalizeRateUnit(row.unit);
  if (quantityUnit == null || priceUnit == null) return NO_HAZARD;

  const qty = parseFloat(row.quantity);
  if (!Number.isFinite(qty) || qty <= 0) return NO_HAZARD;

  // VOLUME PRICED AS WEIGHT — caught BEFORE the equality fast path (Codex P2, 2026-08-23).
  //
  // normalizeRateUnit folds 'fl oz' into 'oz' (its SYNONYMS table, mirroring the live SQL
  // normalize_rate_unit). For a LIQUID product that is right: a bare 'oz' there means fluid
  // ounces, so the two spellings really are the same unit. For a DRY product it is not —
  // 'oz' is a WEIGHT and 'fl oz' is a VOLUME, and the two normalize equal, so a dry line
  // rated in 'fl oz/ac' and priced per 'oz' took the units-are-equal exit and was declared
  // safe. Product rate units are unvalidated free text (the CSV import writes them as-is),
  // so this shape is reachable, and it prices a volume as though it were a weight.
  //
  // There is no conversion to offer: volume→weight needs the product's density, which we do
  // not store. So this is refused outright with billedRatio null rather than a ratio we
  // cannot compute. The RAW spellings are reported, not the normalized ones — telling the
  // operator "measured in oz but priced per oz" would be unreadable.
  if ((productForm ?? null) === 'dry' && isExplicitlyFluidUnit(rateBaseRaw) !== isExplicitlyFluidUnit(row.unit)) {
    return {
      hazard: true,
      quantityUnit: (rateBaseRaw ?? '').trim() || quantityUnit,
      priceUnit: String(row.unit ?? '').trim() || priceUnit,
      billedRatio: null,
    };
  }

  if (quantityUnit === priceUnit) return NO_HAZARD;

  // `quantity` is stored through fmt4, so allow 4-dp slack plus a relative epsilon.
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= Math.max(1e-4, Math.abs(b) * 1e-6);

  // PROOF OF SAFETY, and the only one: the quantity is what rate × acres reads once carried
  // into the unit the price is quoted in. Requires a usable rate and acreage — without them
  // nothing is proven, so the row stays flagged rather than escaping.
  const rate = parseFloat(row.rate_per_acre);
  if (Number.isFinite(rate) && rate > 0 && acres > 0) {
    const carried = fieldAppPricedQuantity(rate * acres, quantityUnit, priceUnit, productForm ?? null);
    if (carried != null && near(qty, carried)) return NO_HAZARD;
  }

  // What this quantity SHOULD read if it were carried into the price's unit. Acreage plays
  // no part, so a stale row reports the same honest ratio as a fresh one.
  const correctlyPriced = fieldAppPricedQuantity(qty, quantityUnit, priceUnit, productForm ?? null);
  return {
    hazard: true,
    quantityUnit,
    priceUnit,
    billedRatio: correctlyPriced != null && correctlyPriced !== 0 ? qty / correctlyPriced : null,
  };
}
