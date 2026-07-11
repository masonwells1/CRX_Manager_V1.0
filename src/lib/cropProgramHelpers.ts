/**
 * cropProgramHelpers — pure, framework-free helpers for loading a saved Crop
 * Program's products into the JobDetail Chemicals editor (Structure Wave-2 P2-4).
 *
 * Crop programs are reusable product/rate templates stored as JSON in
 * `app_settings` (setting_key='crop_programs') by src/pages/CropPrograms.tsx.
 * They were write-only — nothing consumed them. This wires an "Apply Program"
 * flow that drops a program's products into the in-memory chem rows so the user
 * reviews/edits and Saves like any other chemical edit.
 *
 * Same non-destructive philosophy as recipeHelpers (NOT the server-side
 * load_recipe_into_job RPC, which DELETEs all job_chemicals): loading APPENDS to
 * the editable grid, never wipes existing lines, and works on an unsaved job.
 *
 * These are pure so the program→chem-row mapping is unit-tested without the page.
 */

import type { Product } from '../types';
import type { RecipeChemRowSeed } from './recipeHelpers';
import { reconcileChemAutofillUnits } from './chemCalculator';

/** One product line inside a crop program. Mirrors the shape written by
 *  src/pages/CropPrograms.tsx (kept in sync — the store has no DB table). */
export interface ProgramItem {
  product_id: string;
  product_name: string;
  rate: number;
  rate_unit: string;
  section_name: string;
  notes: string;
}

/** A reusable crop program template (app_settings JSON, key='crop_programs'). */
export interface CropProgram {
  id: string;
  name: string;
  description: string;
  crop_type: string;
  season: string;
  is_active: boolean;
  items: ProgramItem[];
  created_at: string;
  updated_at: string;
}

/** Parse the raw app_settings.setting_value JSON into a program list (never throws). */
export function parseCropPrograms(settingValue: string | null | undefined): CropProgram[] {
  if (!settingValue) return [];
  try {
    const parsed = JSON.parse(settingValue);
    return Array.isArray(parsed) ? (parsed as CropProgram[]) : [];
  } catch {
    return [];
  }
}

/**
 * Active programs ordered for a job: programs whose crop_type matches ANY of the
 * job's field crops come first (case-insensitive), then alphabetical. Inactive
 * programs are dropped. Non-destructive on the input (returns a new array).
 */
export function orderProgramsForJob(programs: CropProgram[], jobCrops: string[]): CropProgram[] {
  const crops = new Set(jobCrops.map((c) => (c || '').trim().toLowerCase()).filter(Boolean));
  return programs
    .filter((p) => p.is_active)
    .slice()
    .sort((a, b) => {
      const am = crops.has((a.crop_type || '').trim().toLowerCase()) ? 0 : 1;
      const bm = crops.has((b.crop_type || '').trim().toLowerCase()) ? 0 : 1;
      if (am !== bm) return am - bm;
      return (a.name || '').localeCompare(b.name || '');
    });
}

/**
 * Normalize a crop-program rate unit so the money/loader math can reconcile it.
 * Crop programs carry free-text units; the live data uses "Dry oz", which the
 * unit-factor tables (and reconcileChemAutofillUnits) key as bare "oz" — the
 * dry-vs-liquid distinction is carried by the product's form, not the unit text.
 * Strips a leading "dry " qualifier so "Dry oz" → "oz" (and leaves everything
 * else, incl. per-acre suffixes, untouched). Empty in → empty out.
 */
export function normalizeProgramRateUnit(unit: string | null | undefined): string {
  const u = (unit || '').trim();
  return /^dry\s+/i.test(u) ? u.replace(/^dry\s+/i, '').trim() : u;
}

/**
 * Map a crop-program item (+ its current product, + the customer's tier) into a
 * chem-row seed for the job editor. The program's per-acre rate + unit are
 * authoritative (the program author set them); cost/vendor/REI/PHI come from the
 * live product. Programs carry no price, so fall back to the customer's tier price
 * (never a silent $0). Quantity starts at 0 and is re-derived from rate × acres by
 * the caller (recomputeChemRowForAcres) once the job's fields/acreage are known.
 */
export function programItemToChemRowSeed(
  item: ProgramItem,
  product: Product | undefined,
  tier: 1 | 2 | 3,
): RecipeChemRowSeed {
  let priceStockCents = 0;
  if (product) {
    const tierPrice = tier === 3 ? product.tier3_price : tier === 2 ? product.tier2_price : product.tier1_price;
    if (tierPrice != null) priceStockCents = Math.round(tierPrice * 100);
  }
  const costStockCents = product?.current_cost != null ? Math.round(product.current_cost * 100) : 0;
  const rate = typeof item.rate === 'number' && Number.isFinite(item.rate) ? item.rate : null;
  // Normalize "Dry oz" → "oz" so the reconciliation below can convert it (dry vs
  // liquid comes from product_form). Without this, a "Dry oz" line on a per-lb
  // product falls through reconcile and over-bills 16×.
  const rateUnit = normalizeProgramRateUnit(item.rate_unit) || product?.rate_unit || '';

  // P1 MONEY fix (mirror the manual product-pick path in JobDetail): quantity =
  // rate × acres comes out in the RATE's base unit (e.g. oz), but the product's
  // STOCK unit (unit_size, e.g. GAL) and its per-unit cost/price are per STOCK unit.
  // Without reconciling, saving an oz/acre program line for a per-gallon product
  // persists (acres × oz) labeled as GAL at the per-GAL price — a ~128× over-bill.
  // reconcileChemAutofillUnits expresses unit + cost/price in the rate's base unit
  // (falls back to the stock unit unchanged when it can't convert). Uses the same
  // server-parity factors as the invoice math.
  const reconciled = reconcileChemAutofillUnits(
    product?.unit_size,
    rateUnit,
    costStockCents,
    priceStockCents,
    product?.product_form ?? null,
  );

  return {
    product_id: item.product_id,
    product_name: item.product_name || product?.product_name || '',
    quantity: '0',
    unit: reconciled.unit,
    rate_per_acre: rate != null ? rate.toString() : '',
    rate_unit: rateUnit,
    cost_per_unit_cents: reconciled.costPerUnitCents.toString(),
    price_per_unit_cents: reconciled.pricePerUnitCents.toString(),
    diluent_rate: '',
    rei_hours: product?.rei_hours != null ? product.rei_hours.toString() : '',
    phi_days: product?.phi_days != null ? product.phi_days.toString() : '',
    warehouse: '',
    vendor: product?.vendor || '',
    driver: 'rate',
  };
}
