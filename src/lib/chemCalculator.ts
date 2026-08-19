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
 * TRUE when the rate unit carries a denominator the app does not understand — anything
 * other than acres ('oz/cwt', 'lb/ton', 'oz/1000 sq ft'). The per-acre forms ('pt/ac',
 * 'gal per acre') are understood and return FALSE.
 *
 * Worth its own predicate because such a rate is not merely awkward to convert, it is
 * uninterpretable: `quantity = rate x acres` assumes the denominator IS acres, so for
 * 'oz per hundredweight' the quantity is meaningless before any unit question arises.
 * No arithmetic can rescue it; only a human fixing the unit can.
 */
export function rateDenominatorIsUnrecognized(rateUnit: string | null | undefined): boolean {
  const raw = (rateUnit || '').trim().toLowerCase();
  if (raw === '') return false;
  if (/\s*\/\s*(ac|acre|acres|a)\s*$/.test(raw)) return false;
  return raw.includes('/');
}

/**
 * Strip a per-acre suffix from a rate_unit and return the bare base measure unit
 * ('pt/ac' → 'pt', 'GAL' → 'gal', 'gallons/ac' → 'gal'). Empty in → empty out.
 *
 * Folding is delegated to `labelGuardrails.normalizeRateUnit`, the single mirror of the
 * live SQL `normalize_rate_unit`. This file used to keep a partial copy that folded
 * nothing, so 'ounces/ac' missed the size tables the server reaches after folding to
 * 'oz' — dropping the row into the unreconciled branch and over-billing. That half is
 * now shared.
 *
 * THE ONE DELIBERATE DIVERGENCE — a non-acre denominator. `normalize_rate_unit` returns
 * the whole string so it cannot match a bare unit and the conversion refuses. Copying
 * that here was tried (`bd080626`) and REVERTED (`0890a2eb`): it only refuses safely if
 * the consumer also refuses, and the consumer here does not. `field_app_priced_quantity`
 * returns NULL and the field-app path errors, but `transfer_job_to_invoice` — the actual
 * consumer of this function — bills `safe_cents_qty(price_per_unit_cents, quantity)` with
 * no conversion and no refusal. So keeping the string whole turned a $44 line into a
 * $5,600 line: a 128x OVER-bill, the dangerous direction.
 *
 * Until Mason decides whether an unrecognized denominator should BLOCK the save (see the
 * 2026-08-19 entry in KNOWN_ISSUES), the numerator is used for the money — matching the
 * behaviour on `main` — and `rateDenominatorIsUnrecognized` above raises the flag that
 * makes it visible instead of silent. Do not "fix" this to match the SQL without changing
 * what the consumer does with the result.
 */
export function baseUnitOfRate(rateUnit: string | null | undefined): string {
  const folded = normalizeRateUnit(rateUnit) ?? '';
  if (!folded.includes('/')) return folded;
  // Unrecognized denominator: price off the numerator, as `main` does. Fold it too, so
  // 'ounces/cwt' and 'oz/cwt' agree.
  return normalizeRateUnit(folded.split('/')[0]) ?? '';
}

/**
 * Size of a unit within its product form, in the form's base unit (fluid ounce for
 * liquid, ounce for dry). Returns null when the unit is unknown for that form.
 *
 * MUST use the PRICING tables (`LIQUID_UNIT_SIZE`/`DRY_UNIT_SIZE`, which mirror the SQL
 * `field_app_priced_quantity`), NOT the gl/lb display tables that mirror
 * `convert_to_gl_lb`. Reconciliation exists to make the row's stored money agree with
 * what the server bills, and the server bills through `field_app_priced_quantity`.
 *
 * The two table pairs are NOT interchangeable. `convert_to_gl_lb`'s dry branch has no
 * `dry oz`, while `field_app_priced_quantity`'s does. Reading the display table meant
 * `dry oz` was treated as unconvertible, dropping the row into the fallback below with a
 * quantity in ounces priced per pound — a 16x over-bill, and a 16x over-deduction at
 * `complete_job`, on the 61 live products that carry `rate_unit = 'Dry oz'` against
 * pound stock. The ratios the two pairs produce are otherwise identical (gal:oz is
 * 1:1/128 one way and 128:1 the other), so this changes nothing for any other unit.
 *
 * Own-property lookup rather than `in` so a unit literally spelled 'constructor' or
 * 'toString' cannot inherit a value off Object.prototype and yield NaN money.
 * (`Object.hasOwn` would need an es2022 lib target; this is the same check.)
 */
const hasOwn = (o: Record<string, number>, k: string): boolean =>
  Object.prototype.hasOwnProperty.call(o, k);

function unitSizeInForm(unitKey: string, form: 'liquid' | 'dry'): number | null {
  const sizes = form === 'dry' ? DRY_UNIT_SIZE : LIQUID_UNIT_SIZE;
  return hasOwn(sizes, unitKey) ? sizes[unitKey] : null;
}

export interface ChemAutofillUnits {
  /** The measure unit to store on the row (the rate's base unit when reconcilable). */
  unit: string;
  /** Per-`unit` cost in cents (converted from the per-stock-unit cost when units differ). */
  costPerUnitCents: number;
  /** Per-`unit` price in cents (converted from the per-stock-unit price when units differ). */
  pricePerUnitCents: number;
  /**
   * FALSE when the rate unit and the stock unit could not be reconciled, so the values
   * above are the untouched stock unit and per-stock cost/price.
   *
   * This is NOT cosmetic. The row's quantity is rate × acres, expressed in the RATE's
   * unit, while an unreconciled row carries a price per the STOCK unit — and
   * `transfer_job_to_invoice` bills the line as a raw
   * `safe_cents_qty(price_per_unit_cents, quantity)` with no unit conversion of its own.
   * So an unreconciled row bills the numerator quantity at the stock price. For 'oz/cwt'
   * on a $28.00/GAL product that is $5,600 where a per-ounce reading would be $44.
   * `complete_job` deducts stock the same way and does not refuse either — its hard
   * JOB_INV_UNIT_UNCONVERTIBLE raise was removed under U11 in favour of a raw fallback
   * plus an office-review flag.
   *
   * Callers MUST surface this to the user. Per the house convention set out in
   * `labelGuardrails` — warn, never block, until Mason authorizes a hard block — the
   * line still saves; it must not save SILENTLY.
   */
  reconciled: boolean;
  /** Why reconciliation failed, for the on-screen warning. Null when `reconciled`. */
  reason: string | null;
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
 *  • Units can't be reconciled (unknown unit, or different forms) → keep the STOCK unit +
 *    per-stock cost/price unchanged (never guess a conversion) AND return
 *    `reconciled: false` with a reason. This branch is NOT harmless and must not be
 *    described as a safe fallback: the row's quantity is still rate × acres in the RATE's
 *    unit, so pairing it with a per-stock price over-bills by the unit ratio, and nothing
 *    downstream refuses it. See `ChemAutofillUnits.reconciled`. The caller is responsible
 *    for surfacing the warning.
 *
 * Pure + tested (chemCalculator.test.ts).
 */
/**
 * Does a saved chem line's own quantity unit disagree with its rate unit? Returns a
 * plain-English warning, or null when the line is coherent.
 *
 * THE INVARIANT. `quantity` is rate × acres, so it is expressed in the RATE's unit.
 * `price_per_unit_cents` is per the row's `unit`. `transfer_job_to_invoice` bills the
 * line as a raw `safe_cents_qty(price_per_unit_cents, quantity)` — it performs NO unit
 * conversion — and `complete_job` deducts stock from the same pair without refusing.
 * So the line is correct only when those two units are THE SAME. Any difference bills
 * and deducts by exactly the wrong ratio.
 *
 * Checked at render time rather than trusted from the autofill moment, so it still holds
 * after a reload and after a user edits either dropdown by hand — the autofill's own
 * `reconciled` flag cannot see those.
 *
 * Deliberately silent when either unit is blank: an empty unit is a separate, pre-existing
 * concern and warning on it here would fire on ordinary flat/quantity-only lines.
 */
export function chemLineUnitMismatch(
  rowUnit: string | null | undefined,
  rateUnit: string | null | undefined,
  productForm?: 'liquid' | 'dry' | null,
): string | null {
  // An unrecognized denominator is its own problem and outranks any unit comparison:
  // `quantity = rate x acres` assumes the denominator IS acres, so the quantity itself is
  // wrong before units are considered. Reported even when the units line up.
  if (rateDenominatorIsUnrecognized(rateUnit)) {
    return `The rate unit "${rateUnit}" isn't per acre, but the quantity is worked out as rate x acres — so the amount on this line is not what the rate describes. Fix the unit before invoicing.`;
  }

  // BOTH sides folded before comparing. Comparing a folded rate unit against a merely
  // lowercased row unit made every equivalent spelling look like a mismatch — 'fl oz' vs
  // 'oz', 'lbs' vs 'lb' — and since those have a size ratio of exactly 1 the message read
  // "under-bills by about 1x", which is both false and self-contradictory. Both are real
  // options in the live unit vocabulary, so this fired on correct lines.
  const rowKey = normalizeRateUnit(rowUnit) ?? '';
  const baseKey = baseUnitOfRate(rateUnit);

  // No rate unit → a flat / quantity-only line. Nothing to reconcile against, and warning
  // here would fire on ordinary lines.
  if (baseKey === '') return null;

  // A rate unit but NO unit on the line is a real gap, not a quiet one: the quantity is
  // counted in the rate's unit while the per-unit price is per nothing in particular, and
  // the server cannot convert it either (normalize_rate_unit('') is NULL, so complete_job
  // falls back to the raw quantity). 8 live products carry a blank unit_size and autofill
  // straight into this state.
  if (rowKey === '') {
    return `This line has no unit, but the quantity is counted in "${baseKey}" and the price is per unit — so what is billed and what is taken out of stock are both unreliable. Set the unit before invoicing.`;
  }

  if (rowKey === baseKey) return null;

  // Try the stated form first; with none stated (every manual line) try BOTH before
  // declaring the units unconvertible. Inferring the form from the row unit alone and
  // testing liquid first told the user that 'oz' against a 'lb/ac' rate "can't be
  // converted" when it converts fine as dry.
  const forms: Array<'liquid' | 'dry'> = productForm ? [productForm] : ['liquid', 'dry'];
  for (const form of forms) {
    const rowSize = unitSizeInForm(rowKey, form);
    const baseSize = unitSizeInForm(baseKey, form);
    if (rowSize == null || baseSize == null || rowSize === 0) continue;
    const ratio = baseSize / rowSize;
    // Equivalent spellings of the same measure ('fl oz' and 'oz') — the money is right.
    if (ratio === 1) return null;
    const factor = ratio > 1 ? ratio : 1 / ratio;
    const rounded = Math.round(factor * 100) / 100;
    const direction = ratio < 1 ? 'over-bills' : 'under-bills';
    return `Quantity is counted in "${baseKey}" but the line is priced per "${rowUnit}". As saved this ${direction} by about ${rounded}x — set the unit to "${baseKey}", or change the rate unit.`;
  }
  return `Quantity is counted in "${baseKey}" but the line is priced per "${rowUnit}", and those can't be converted, so the amount billed will be wrong. Fix the unit before invoicing.`;
}

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

  const unreconciled = (reason: string): ChemAutofillUnits => ({
    unit: stock,
    costPerUnitCents: costPerStockCents,
    pricePerUnitCents: pricePerStockCents,
    reconciled: false,
    reason,
  });
  /** Nothing to reconcile — the row is already in one measure. Not a warning state. */
  const alreadyAligned: ChemAutofillUnits = {
    unit: stock,
    costPerUnitCents: costPerStockCents,
    pricePerUnitCents: pricePerStockCents,
    reconciled: true,
    reason: null,
  };

  // No rate unit, or identical units → nothing to reconcile (common case).
  if (baseKey === '' || baseKey === normalizeRateUnit(stockKey)) return alreadyAligned;

  // A BLANK stock unit is a failure, not an alignment. 8 live products carry
  // unit_size = '' against a real inventory_unit, and lumping them in with the aligned
  // cases above reported reconciled:true while writing an empty unit and the per-GALLON
  // price against a quantity counted in ounces — the same 128x shape this function
  // exists to prevent, invisible to every guard.
  if (stockKey === '') {
    return unreconciled(`This product has no stock unit recorded, so a rate in "${rateUnit}" can't be priced against it. Set the product's unit size, or fix the unit on this line, before invoicing.`);
  }

  // Determine the form: trust product_form when given, else infer from the stock unit.
  // Inferred from the PRICING tables, the same ones the sizes below come from.
  let form: 'liquid' | 'dry' | null = productForm ?? null;
  if (form == null) {
    if (hasOwn(LIQUID_UNIT_SIZE, stockKey)) form = 'liquid';
    else if (hasOwn(DRY_UNIT_SIZE, stockKey)) form = 'dry';
  }
  if (form == null) {
    return unreconciled(`Product form is unknown and the stock unit "${stock}" isn't a recognized measure, so "${rateUnit}" can't be converted to it.`);
  }

  const stockSize = unitSizeInForm(stockKey, form);
  const baseSize = unitSizeInForm(baseKey, form);
  // Both units must be known in the SAME form to safely convert; otherwise don't guess.
  if (stockSize == null || baseSize == null || baseSize === 0) {
    const culprit = baseSize == null || baseSize === 0 ? `rate unit "${rateUnit}"` : `stock unit "${stock}"`;
    return unreconciled(`The ${culprit} isn't a recognized ${form} measure, so the rate can't be converted to the stock unit "${stock}". The quantity is counted in the rate's unit but priced per "${stock}" — check the unit before invoicing.`);
  }

  // base-units per stock-unit = stockSize / baseSize (e.g. GAL/pt = 1 / (1/8) = 8).
  // per-base cost = per-stock cost / (base-units per stock-unit) = perStock × baseSize / stockSize.
  const perBaseFactor = baseSize / stockSize;
  return {
    unit: baseKey,
    costPerUnitCents: Math.round(costPerStockCents * perBaseFactor),
    pricePerUnitCents: Math.round(pricePerStockCents * perBaseFactor),
    reconciled: true,
    reason: null,
  };
}
