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
 * Re-derive a chem row when total acres change (caller guards `acres > 0`).
 *  • driver 'qty'  → HOLD the typed quantity, refigure the rate (never silently rewrite a
 *                    hand-entered total).
 *  • driver 'rate' → quantity follows = rate × acres.
 *  • no driver     → an untouched / RELOADED line is left exactly as saved (an acreage
 *                    change must not rewrite a persisted quantity whose origin is unknown).
 * Returns a NEW row when it changes, otherwise the same row reference.
 */
export function recomputeChemRowForAcres<T extends ChemCalcRow>(row: T, acres: number): T {
  const rate = parseFloat(row.rate_per_acre);
  const qty = parseFloat(row.quantity);
  if (row.driver === 'qty') {
    return row.quantity.trim() !== '' && !Number.isNaN(qty) && qty !== 0
      ? { ...row, rate_per_acre: fmt4(qty / acres) }
      : row;
  }
  if (row.driver === 'rate') {
    return row.rate_per_acre.trim() !== '' && !Number.isNaN(rate)
      ? { ...row, quantity: fmt4(rate * acres) }
      : row;
  }
  return row;
}
