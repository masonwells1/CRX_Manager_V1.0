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
  let priceCents = 0;
  if (product) {
    const tierPrice = tier === 3 ? product.tier3_price : tier === 2 ? product.tier2_price : product.tier1_price;
    if (tierPrice != null) priceCents = Math.round(tierPrice * 100);
  }
  const costCents = product?.current_cost != null ? Math.round(product.current_cost * 100) : 0;
  const rate = typeof item.rate === 'number' && Number.isFinite(item.rate) ? item.rate : null;

  return {
    product_id: item.product_id,
    product_name: item.product_name || product?.product_name || '',
    quantity: '0',
    unit: product?.unit_size || '',
    rate_per_acre: rate != null ? rate.toString() : '',
    rate_unit: item.rate_unit || product?.rate_unit || '',
    cost_per_unit_cents: costCents.toString(),
    price_per_unit_cents: priceCents.toString(),
    diluent_rate: '',
    rei_hours: product?.rei_hours != null ? product.rei_hours.toString() : '',
    phi_days: product?.phi_days != null ? product.phi_days.toString() : '',
    warehouse: '',
    vendor: product?.vendor || '',
    driver: 'rate',
  };
}
