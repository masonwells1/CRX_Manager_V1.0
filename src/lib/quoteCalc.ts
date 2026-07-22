/**
 * Pure math functions extracted from QuoteBuilder for testability.
 * These are the core pricing / unit-conversion calculations.
 *
 * NOT AUTHORITATIVE FOR PERSISTENCE. The server recalculates and persists all
 * quote line math in save_quote() (migration 20260528042000) — that is the
 * single source of truth for stored prices. These functions exist only for
 * unit-test coverage of the pricing rules and as a reference for live-preview
 * display math. They are NOT imported by QuoteBuilder's save payload, and new
 * code must NOT route persisted values through them — read the server-returned
 * values after save instead. (Foundation audit P2-E, 2026-05-28.)
 */
import type { Product, UnitConversion } from '../types';

export type CalcMode = 'rate_acres' | 'units_direct';

export interface CalcItem {
  product_id: string;
  product?: Product;
  actual_rate: number | null;
  rate_unit: string | null;
  acres: number | null;
  price_per_unit: number;
  current_cost: number;
  oz_per_acre: number | null;
  price_per_acre: number | null;
  total_units_needed: number | null;
  total_price: number;
  profit: number;
  net_margin: number;
  suggested_rate: string | null;
  unit_size: string | null;
  notes: string | null;
  sort_order: number;
  calc_mode?: CalcMode;
}

/** Get tier price from product — pure function.
 * Falls back to tier1_price when tier2/3 is missing (matches QuoteBuilder behavior). */
export function getTierPrice(product: Product, tierNum: number): number {
  const t1 = product.tier1_price || 0;
  if (tierNum === 1) return t1;
  if (tierNum === 2) return product.tier2_price || t1;
  return product.tier3_price || t1;
}

/** Look up unit→oz conversion factor — pure function */
export function getConversionFactor(
  unit: string | null,
  conversions: UnitConversion[]
): number {
  if (!unit) return 1;
  const conv = conversions.find(
    (c) => c.unit.toLowerCase() === unit.toLowerCase()
  );
  return conv ? conv.factor_oz : 1;
}

/** Core pricing recalculation — pure function (no React deps) */
export function recalcItem(
  item: CalcItem,
  product: Product,
  tierNum: number,
  conversions: UnitConversion[]
): CalcItem {
  const pricePerUnit = getTierPrice(product, tierNum);
  const mode = item.calc_mode || 'rate_acres';
  // Fall back to unit_size if inventory_unit is not set on the product
  const inventoryUnitFactorOz = getConversionFactor(
    product.inventory_unit || product.unit_size,
    conversions
  );

  if (mode === 'units_direct') {
    // User entered total_units_needed directly — skip rate×acres computation
    const totalInventoryUnits = item.total_units_needed || 0;
    const totalPrice = pricePerUnit * totalInventoryUnits;
    const profit = (pricePerUnit - (product.current_cost || 0)) * totalInventoryUnits;
    const netMargin = totalPrice > 0 ? profit / totalPrice : 0;

    // Back-calculate rate if acres is also set (informational)
    const acres = item.acres || 0;
    let ozPerAcre: number | null = item.oz_per_acre;
    let pricePerAcre: number | null = item.price_per_acre;
    if (acres > 0 && inventoryUnitFactorOz > 0) {
      const totalOz = totalInventoryUnits * inventoryUnitFactorOz;
      ozPerAcre = Math.round((totalOz / acres) * 100) / 100;
      pricePerAcre = Math.round((totalPrice / acres) * 100) / 100;
    }

    return {
      ...item,
      price_per_unit: pricePerUnit,
      current_cost: product.current_cost || 0,
      oz_per_acre: ozPerAcre,
      price_per_acre: pricePerAcre,
      total_units_needed: Math.round(totalInventoryUnits * 100) / 100,
      total_price: Math.round(totalPrice * 100) / 100,
      profit: Math.round(profit * 100) / 100,
      net_margin: Math.round(netMargin * 100 * 100) / 100,
    };
  }

  // Default: rate_acres mode — compute units from rate × acres
  const actualRate = item.actual_rate || 0;
  const acres = item.acres || 0;

  const rateUnitFactorOz = getConversionFactor(item.rate_unit, conversions);
  const rateInOz = actualRate * rateUnitFactorOz;
  const ozPerAcre = rateInOz;

  const totalInventoryUnits =
    inventoryUnitFactorOz > 0 ? (acres * rateInOz) / inventoryUnitFactorOz : 0;

  const pricePerAcre =
    inventoryUnitFactorOz > 0
      ? pricePerUnit * (rateInOz / inventoryUnitFactorOz)
      : 0;
  const totalPrice = pricePerUnit * totalInventoryUnits;
  const profit = (pricePerUnit - (product.current_cost || 0)) * totalInventoryUnits;
  const netMargin = totalPrice > 0 ? profit / totalPrice : 0;

  return {
    ...item,
    price_per_unit: pricePerUnit,
    current_cost: product.current_cost || 0,
    oz_per_acre: Math.round(ozPerAcre * 100) / 100,
    price_per_acre: Math.round(pricePerAcre * 100) / 100,
    total_units_needed: Math.round(totalInventoryUnits * 100) / 100,
    total_price: Math.round(totalPrice * 100) / 100,
    profit: Math.round(profit * 100) / 100,
    net_margin: Math.round(netMargin * 100 * 100) / 100, // stored as percentage
  };
}

/**
 * A product's CATALOG price PER ACRE at a tier — the cost/acre if applied at its
 * OWN standard rate_per_acre. Computed the SAME way recalcItem prices a line's
 * per-acre (tierPrice × rateInOz / inventoryUnitFactorOz), so the value shown in
 * the product picker equals the line's $/acre once the product is added at its
 * default rate. Reference-only, for comparing products by cost-per-acre (P2-5).
 *
 * Deliberately recomputes rather than reading products.tierN_price_per_acre.
 * Those stored columns are now maintained CORRECTLY (unit-fixed 2026-07-03,
 * migration 20260702190000 — same formula as here), but we recompute live so the
 * picker always reflects the VIEWING customer's tier and can never lag a save.
 * (Before that fix they used a unit-inconsistent formula — rate in oz over
 * container_size in gal — and were wildly wrong: ~43% over $500/acre, up to $16k.)
 *
 * Returns null when the product has no positive rate_per_acre, or the inventory
 * unit doesn't convert (factor 0) — never a fabricated number.
 */
export function catalogPricePerAcre(
  product: Product,
  tierNum: number,
  conversions: UnitConversion[]
): number | null {
  const rate = product.rate_per_acre;
  if (rate == null || !Number.isFinite(rate) || rate <= 0) return null;
  const inventoryUnitFactorOz = getConversionFactor(
    product.inventory_unit || product.unit_size,
    conversions
  );
  if (!(inventoryUnitFactorOz > 0)) return null;
  const rateInOz = rate * getConversionFactor(product.rate_unit, conversions);
  const perAcre = getTierPrice(product, tierNum) * (rateInOz / inventoryUnitFactorOz);
  return Math.round(perAcre * 100) / 100;
}

/** Compute quote-level totals from items */
export function computeQuoteTotals(items: CalcItem[]): {
  totalPrice: number;
  totalCost: number;
  totalProfit: number;
  totalMarginPct: number;
} {
  let totalPrice = 0;
  let totalCost = 0;
  for (const item of items) {
    totalPrice += (item.total_price || 0);
    totalCost += (item.current_cost || 0) * (item.total_units_needed || 0);
  }
  const totalProfit = totalPrice - totalCost;
  const totalMarginPct = totalPrice > 0 ? (totalProfit / totalPrice) * 100 : 0;
  return {
    totalPrice: Math.round(totalPrice * 100) / 100,
    totalCost: Math.round(totalCost * 100) / 100,
    totalProfit: Math.round(totalProfit * 100) / 100,
    totalMarginPct: Math.round(totalMarginPct * 100) / 100,
  };
}

/** Mirror the database commission-split contract for immediate UI feedback. */
export function validateCommissionSplits(
  splits: Array<{ recipient: string; recipient_user_id?: string | null; percentage: number }>
): string | null {
  if (splits.length === 0) return null;

  const seenRecipients = new Set<string>();
  let sum = 0;
  for (const split of splits) {
    const recipient = split.recipient.trim();
    if (!recipient) return 'Every commission split needs a recipient';

    const recipientKey = recipient.toLowerCase();
    if (seenRecipients.has(recipientKey)) {
      return `Commission recipient "${recipient}" is listed more than once`;
    }
    seenRecipients.add(recipientKey);

    if (!Number.isFinite(split.percentage) || split.percentage <= 0 || split.percentage > 100) {
      return `Commission percentage for "${recipient}" must be greater than 0 and no more than 100`;
    }
    sum += split.percentage;
  }

  if (Math.abs(sum - 100) > 0.01) {
    return `Commission splits sum to ${sum.toFixed(2)}%, expected 100%`;
  }
  return null;
}

/**
 * Convert total applied quantity to gallons (liquid) or pounds (dry).
 * Liquid: OZ→GL (/128), PT→GL (/8), QT→GL (/4), GL stays.
 * Dry:    OZ→LB (/16), LB stays.
 */
export function convertToGlLb(
  totalApplied: number,
  unit: string | null | undefined,
  productForm: 'liquid' | 'dry' | string,
): { value: number; unit: string } {
  const u = (unit || 'OZ').toUpperCase();

  if (productForm === 'dry') {
    if (u === 'OZ') return { value: totalApplied / 16, unit: 'LB' };
    if (u === 'LB') return { value: totalApplied, unit: 'LB' };
    // Unknown dry unit — assume already in LB
    return { value: totalApplied, unit: 'LB' };
  }
  // Liquid
  if (u === 'OZ') return { value: totalApplied / 128, unit: 'GL' };
  if (u === 'PT') return { value: totalApplied / 8, unit: 'GL' };
  if (u === 'QT') return { value: totalApplied / 4, unit: 'GL' };
  if (u === 'GL') return { value: totalApplied, unit: 'GL' };
  // Unknown liquid unit — default to OZ→GL
  return { value: totalApplied / 128, unit: 'GL' };
}
