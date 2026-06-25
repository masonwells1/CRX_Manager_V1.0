/**
 * loaderWorksheet — the PURE per-load tank-split math for the field-job Loader
 * Worksheet (field-app parity #10).
 *
 * The loader worksheet tells the tank loader how many tank loads to mix for a job
 * and exactly how much of each chemical goes into ONE tank. The split is driven by
 * the job's total SPRAY VOLUME (total acres × the per-acre carrier/diluent rate)
 * and the sprayer's tank capacity:
 *
 *     spray volume (gal) = total acres × carrier rate (gal/acre)
 *     loads              = ceil(spray volume / tank capacity)
 *
 * Each FULL load carries `capacity` gallons of spray; the LAST load carries the
 * remainder (a "partial last load") when the volume doesn't divide evenly. Every
 * product on the job is split across the loads IN PROPORTION to each load's volume
 * fraction, so:
 *
 *     • a load that is `capacity / sprayVolume` of the job gets that fraction of
 *       each product, and
 *     • the per-load amounts for a product SUM EXACTLY to the product's job total
 *       (the last load takes the residual, so there is never an over- or under-fill
 *       from float drift — the same penny-exact-residual pattern the invoice split
 *       engine uses).
 *
 * This module is React- and jsPDF-free so the loads/partial/per-load arithmetic is
 * unit-tested in isolation (loaderWorksheet.test.ts). JobDetail renders the in-page
 * preview from it and the PDF layout (loaderWorksheetPdf.ts) prints from the same
 * computed result, so screen and paper never disagree.
 */

/** A product to split across loads — its name, the job total, and the unit label. */
export interface LoaderProductInput {
  product_name: string;
  /** Total quantity of this product across the WHOLE job (rate × total acres). */
  total_quantity: number | null;
  /** The quantity's unit label (e.g. "gal", "oz", "lb"). Display only. */
  unit: string | null;
}

/** The inputs the worksheet split needs. */
export interface LoaderWorksheetInput {
  /** Sum of acres across the job's fields. */
  total_acres: number;
  /** Carrier (water/spray) gallons applied per acre. NULL/0 => invalid. */
  carrier_rate_gpa: number | null;
  /** Tank capacity in gallons (per-job override, else the vehicle's). NULL/0 => invalid. */
  tank_capacity: number | null;
  products: LoaderProductInput[];
}

/** One product's amount within one specific load. */
export interface LoaderLoadProduct {
  product_name: string;
  /** The amount of this product to put in THIS load (already rounded to 4 dp). */
  amount: number;
  unit: string | null;
}

/** One tank load: its 1-based number, its spray volume, and the per-product amounts. */
export interface LoaderLoad {
  /** 1-based load number. */
  load_number: number;
  /** Gallons of spray solution in this load (capacity for full loads; remainder for the last). */
  volume: number;
  /** True when this load is a partial (less than a full tank) — always the last load if any. */
  is_partial: boolean;
  products: LoaderLoadProduct[];
}

/** The computed worksheet. `valid` is false when capacity/rate/acres can't make a real plan. */
export interface LoaderWorksheet {
  /** False => show an "enter capacity / carrier rate" state, NOT a number. */
  valid: boolean;
  /** A short reason when invalid (for the UI hint). Empty when valid. */
  invalid_reason: string;
  total_acres: number;
  carrier_rate_gpa: number;
  tank_capacity: number;
  /** total acres × carrier rate (total gallons of spray solution). */
  spray_volume: number;
  /** Number of tank loads (full loads + at most one partial). */
  loads_count: number;
  /** Volume of the partial last load (0 when the volume divides evenly). */
  partial_load_volume: number;
  loads: LoaderLoad[];
}

/** Round to 4 dp (matches the chem calculator + applicator-sheet rounding). */
const round4 = (x: number): number => Math.round(x * 10000) / 10000;

/**
 * True when a vehicle's capacity unit measures GALLONS (the spray-volume unit the
 * loader math divides by). A dry spreader's capacity in lbs/tons must NOT be used
 * as a gallon tank capacity (that would divide gallons of spray by pounds and give
 * a wrong load count) — for those, the user supplies a per-job gallon override. A
 * blank/unknown unit is TREATED AS GALLONS (the historical default — capacity_unit
 * defaults to 'gal' and most sprayers are liquid).
 */
export function isGallonCapacityUnit(unit: string | null | undefined): boolean {
  const u = (unit || '').trim().toLowerCase();
  if (u === '') return true; // default/blank => gallons
  return u === 'gal' || u === 'gallon' || u === 'gallons' || u === 'gl';
}

/**
 * Hard cap on the number of loads. The DB CHECK only requires capacity > 0, so a
 * fat-fingered tiny capacity (e.g. 0.1 gal for a 1,500-gal job → 15,000 loads)
 * would otherwise allocate a column per load and freeze the tab / PDF. Beyond a
 * realistic sprayer plan we treat the count as invalid (show the guard) rather
 * than build thousands of columns. A real job is a handful of loads; 200 is a
 * generous ceiling that never trips on legitimate use.
 */
export const MAX_LOADS = 200;

/**
 * Compute the loader worksheet (loads + per-load per-product split) from the job's
 * acres, carrier rate, tank capacity, and products. Pure + tested.
 *
 * Guard (matches ChemMan): if the carrier rate, tank capacity, or acres are
 * missing / non-positive, the result is `valid: false` with an explanatory reason
 * and ZERO loads — the caller shows "enter capacity" rather than a wrong number or
 * a crash (never divides by zero, never returns NaN).
 */
export function computeLoaderWorksheet(input: LoaderWorksheetInput): LoaderWorksheet {
  const totalAcres = Number.isFinite(input.total_acres) ? input.total_acres : 0;
  const carrier = input.carrier_rate_gpa != null && Number.isFinite(input.carrier_rate_gpa) ? input.carrier_rate_gpa : 0;
  const capacity = input.tank_capacity != null && Number.isFinite(input.tank_capacity) ? input.tank_capacity : 0;

  const base: Omit<LoaderWorksheet, 'valid' | 'invalid_reason'> = {
    total_acres: round4(totalAcres),
    carrier_rate_gpa: round4(carrier),
    tank_capacity: round4(capacity),
    spray_volume: 0,
    loads_count: 0,
    partial_load_volume: 0,
    loads: [],
  };

  // ── Guard: every divisor / driver must be a real positive number ──────────────
  if (totalAcres <= 0) return { ...base, valid: false, invalid_reason: 'Add fields with acres to plan loads.' };
  if (carrier <= 0) return { ...base, valid: false, invalid_reason: 'Enter a carrier rate (gallons per acre) to plan loads.' };
  if (capacity <= 0) return { ...base, valid: false, invalid_reason: 'Enter the sprayer tank capacity (gallons) to plan loads.' };

  const sprayVolume = round4(totalAcres * carrier);
  if (sprayVolume <= 0) return { ...base, valid: false, invalid_reason: 'Spray volume is zero — check acres and carrier rate.' };

  const loadsCount = Math.ceil(sprayVolume / capacity);
  // Cap an unrealistic load count (a tiny capacity slips past the CHECK) so we
  // never allocate thousands of columns and freeze the UI/PDF. Show the guard.
  if (loadsCount > MAX_LOADS) {
    return {
      ...base,
      spray_volume: sprayVolume,
      valid: false,
      invalid_reason: `That tank capacity would need ${loadsCount.toLocaleString()} loads — check the capacity (it looks too small).`,
    };
  }
  // Remainder volume of the last (partial) load. When the volume divides evenly,
  // the last load is a FULL load and there is no partial remainder.
  const remainder = round4(sprayVolume - capacity * (loadsCount - 1));
  const lastIsPartial = remainder > 0 && remainder < capacity;

  // Per-load VOLUME for each load: full loads carry `capacity`; the final load
  // carries the remainder (= capacity when it divides evenly).
  const loadVolumes: number[] = [];
  for (let i = 0; i < loadsCount; i++) {
    loadVolumes.push(i < loadsCount - 1 ? round4(capacity) : remainder);
  }

  // Split each product across the loads in proportion to each load's volume share.
  // The first loadsCount-1 loads get their proportional (rounded) amount; the LAST
  // load takes the exact residual so the per-load amounts sum to the job total with
  // no over/under-fill. Single load => the one load gets the whole total.
  const loads: LoaderLoad[] = loadVolumes.map((vol, i) => ({
    load_number: i + 1,
    volume: vol,
    is_partial: i === loadsCount - 1 && lastIsPartial,
    products: [] as LoaderLoadProduct[],
  }));

  for (const p of input.products) {
    const total = p.total_quantity != null && Number.isFinite(p.total_quantity) ? p.total_quantity : 0;
    let allocated = 0;
    for (let i = 0; i < loadsCount; i++) {
      // The remaining un-allocated amount — every load is capped at this so the
      // running total NEVER exceeds the product's job total (the loader is never
      // told to over-apply), and it never goes negative.
      const remaining = round4(total - allocated);
      let amount: number;
      if (i < loadsCount - 1) {
        // Proportional share of this (full) load by its volume fraction, but never
        // more than what's left. With many loads + a tiny total, the rounded shares
        // could otherwise sum ABOVE the total before the last load (Codex) — the cap
        // keeps the column sum exactly == total, with no overfill and no negative.
        amount = Math.min(round4(total * (loadVolumes[i] / sprayVolume)), Math.max(0, remaining));
      } else {
        // Last load: exactly the residual so the column sums to the product total.
        amount = Math.max(0, remaining);
      }
      allocated = round4(allocated + amount);
      loads[i].products.push({ product_name: p.product_name, amount, unit: p.unit });
    }
  }

  return {
    ...base,
    valid: true,
    invalid_reason: '',
    spray_volume: sprayVolume,
    loads_count: loadsCount,
    partial_load_volume: lastIsPartial ? remainder : 0,
    loads,
  };
}

/**
 * The per-product TOTAL across all loads — used by the UI/PDF totals row and by
 * tests to assert sum(per-load amounts) === product job total (no over/under-fill).
 */
export function loaderProductTotals(ws: LoaderWorksheet): { product_name: string; total: number; unit: string | null }[] {
  const map = new Map<string, { product_name: string; total: number; unit: string | null }>();
  for (const load of ws.loads) {
    for (const lp of load.products) {
      const existing = map.get(lp.product_name);
      if (existing) {
        existing.total = round4(existing.total + lp.amount);
      } else {
        map.set(lp.product_name, { product_name: lp.product_name, total: lp.amount, unit: lp.unit });
      }
    }
  }
  return [...map.values()];
}
