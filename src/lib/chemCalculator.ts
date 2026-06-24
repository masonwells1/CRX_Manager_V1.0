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
// gallon-or-pound equivalent so the loader can plan tank loads. The unit text a
// user types is free-form (e.g. "GL", "gal", "fl oz", "pt", "qt", "LB", "oz").
// We convert the typed unit to gallons (liquid) or pounds (dry) using the
// standard US measure factors below. An unrecognized unit returns null (the UI
// shows a dash) — we never guess a conversion we don't know.

/** US fluid conversions → gallons (1 gal = 4 qt = 8 pt = 128 fl oz). */
const TO_GALLONS: Record<string, number> = {
  gal: 1, gallon: 1, gallons: 1, gl: 1,
  qt: 1 / 4, quart: 1 / 4, quarts: 1 / 4,
  pt: 1 / 8, pint: 1 / 8, pints: 1 / 8,
  'fl oz': 1 / 128, floz: 1 / 128, 'fluid ounce': 1 / 128,
};

/** Dry-weight conversions → pounds (1 lb = 16 oz). */
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

/**
 * Convert a total-applied quantity in `unit` to its gallon (liquid) or pound
 * (dry) equivalent. Returns null for a blank/zero quantity or an unrecognized
 * unit (caller renders a dash — never a guessed number). Pure + tested.
 */
export function toGallonOrLbEquivalent(quantity: number, unit: string | null | undefined): AppliedConversion | null {
  if (!Number.isFinite(quantity) || quantity === 0) return null;
  const key = (unit || '').trim().toLowerCase();
  if (key === '') return null;
  if (key in TO_GALLONS) return { value: Math.round(quantity * TO_GALLONS[key] * 10000) / 10000, unit: 'gal' };
  if (key in TO_POUNDS) return { value: Math.round(quantity * TO_POUNDS[key] * 10000) / 10000, unit: 'lb' };
  return null;
}
