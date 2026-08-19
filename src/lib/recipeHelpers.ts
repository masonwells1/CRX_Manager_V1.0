/**
 * recipeHelpers — pure, framework-free helpers for loading/saving blend recipes
 * from the JobDetail Chemicals/Charges tab (field-app parity #2).
 *
 * Why client-side load (not the destructive load_recipe_into_job RPC):
 *   The server RPC DELETEs ALL job_chemicals first, requires the job to be saved,
 *   and forces a refetch — so it wipes unsaved edits and can't run on a brand-new
 *   job. The ChemMan flow is "drop these products into the editor, keep editing,
 *   then Save". Mapping a recipe into the in-memory chem rows keeps every line
 *   editable, lets the user choose REPLACE or ADD, never touches unrelated job
 *   data, and works on a new (unsaved) job. The job is persisted on the next Save
 *   like any other chemical edit.
 *
 * These functions are pure so the round-trip (save a recipe → load it back →
 * products/rates/units match) is unit-tested without mounting the page.
 */

import type { BlendRecipeItem, Product } from '../types';

/** localStorage key for the per-browser "last used recipe" shortcut. */
const LAST_RECIPE_KEY = 'crx-last-recipe-id';

/** The fields a recipe load needs to produce a JobDetail ChemRow. ChemRow is a
 *  superset of this shape, so the page spreads the result onto a fresh row. */
export interface RecipeChemRowSeed {
  product_id: string;
  product_name: string;
  quantity: string;
  unit: string;
  rate_per_acre: string;
  rate_unit: string;
  cost_per_unit_cents: string;
  price_per_unit_cents: string;
  diluent_rate: string;
  rei_hours: string;
  phi_days: string;
  warehouse: string;
  vendor: string;
  /** 'rate' so a later acreage change re-derives quantity = rate × acres. */
  driver: 'rate' | 'qty';
}

/** The minimal chem-row shape needed to build a save_blend_recipe p_items entry. */
export interface RecipeItemSource {
  product_id: string;
  product_name: string;
  quantity: string;
  unit: string;
  rate_per_acre: string;
  price_per_unit_cents: string;
}

/** One p_items element for the save_blend_recipe RPC. */
export interface RecipeItemPayload {
  product_id: string;
  product_name: string;
  quantity: number;
  unit: string;
  rate_per_acre: number | null;
  price_per_unit_cents: number;
  notes: string | null;
}

/**
 * Map a saved recipe item (+ its current product, + the customer's tier) into a
 * chem-row seed for the job editor.
 *
 * Pricing intent ("preserve sensible pricing"): a recipe price OVERRIDES the tier
 * default when set; otherwise fall back to the customer's tier price so a loaded
 * line is never silently $0 (the old server RPC hard-set price 0). Cost, vendor,
 * REI/PHI come from the live product; rate/qty/unit come from the recipe.
 */
export function recipeItemToChemRowSeed(
  item: BlendRecipeItem,
  product: Product | undefined,
  tier: 1 | 2 | 3,
): RecipeChemRowSeed {
  const recipePrice = item.price_per_unit_cents ?? 0;
  let priceCents = recipePrice;
  if (priceCents <= 0 && product) {
    const tierPrice = tier === 3 ? product.tier3_price : tier === 2 ? product.tier2_price : product.tier1_price;
    if (tierPrice != null) priceCents = Math.round(tierPrice * 100);
  }

  const costCents = product?.current_cost != null ? Math.round(product.current_cost * 100) : 0;
  // Unit of the recipe item wins; fall back to the product's SELLING unit (the unit its
  // price is quoted in — `_save_field_app_invoice_impl` calls inventory_unit "the product's
  // SOLD unit"). `unit_size` is blank on 8 live products and would seed an empty unit.
  const unit = item.unit || product?.inventory_unit || product?.unit_size || '';
  // `blend_recipe_items` has NO rate_unit column, so the unit the stored rate is quoted in
  // is genuinely unknowable. It used not to matter: nothing converted, and the rate was only
  // ever multiplied by acres. It matters now, because `recomputeChemRowForAcres` carries the
  // result from the rate's unit into the row's unit — and guessing the product's default
  // rate_unit here would apply a conversion the stored rate may never have been in. On a
  // recipe saved from a 'pt/ac' line whose product defaults to 'oz', that guess converts by
  // 1/128 and under-bills 16x.
  //
  // So the rate is read as being per the row's own unit, which makes the factor exactly 1
  // and reproduces `main`'s behaviour for every recipe. Storing the rate unit on the recipe
  // is the real fix; it needs a migration and is recorded in KNOWN_ISSUES.
  const rateUnit = unit;

  return {
    product_id: item.product_id,
    product_name: item.product_name || product?.product_name || '',
    quantity: item.quantity != null ? item.quantity.toString() : '0',
    unit,
    rate_per_acre: item.rate_per_acre != null ? item.rate_per_acre.toString() : '',
    rate_unit: rateUnit,
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

/**
 * Map a job chem row into a save_blend_recipe p_items entry (the reverse of the
 * load). Only rows with a product are recipe-worthy. Numbers are parsed from the
 * string-backed grid; price is carried so the round-trip preserves it.
 */
export function chemRowToRecipeItem(row: RecipeItemSource): RecipeItemPayload | null {
  if (!row.product_id) return null;
  return {
    product_id: row.product_id,
    product_name: row.product_name || '',
    quantity: parseFloat(row.quantity) || 0,
    unit: row.unit || 'gal',
    rate_per_acre: row.rate_per_acre.trim() !== '' ? parseFloat(row.rate_per_acre) : null,
    price_per_unit_cents: parseInt(row.price_per_unit_cents, 10) || 0,
    notes: null,
  };
}

/** Build the full p_items array for save_blend_recipe, dropping product-less rows. */
export function chemRowsToRecipeItems(rows: RecipeItemSource[]): RecipeItemPayload[] {
  return rows
    .map(chemRowToRecipeItem)
    .filter((p): p is RecipeItemPayload => p !== null);
}

/** Persist the last recipe loaded into a job (per-browser shortcut). */
export function setLastRecipeId(id: string): void {
  try {
    localStorage.setItem(LAST_RECIPE_KEY, id);
  } catch {
    // ignore storage errors (private mode / quota)
  }
}

/** Read the last recipe loaded into a job, or null if none / unavailable. */
export function getLastRecipeId(): string | null {
  try {
    return localStorage.getItem(LAST_RECIPE_KEY);
  } catch {
    return null;
  }
}
