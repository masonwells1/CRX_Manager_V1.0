/**
 * Pure math functions extracted from QuoteBuilder for testability.
 * These are the core pricing / unit-conversion calculations.
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
  const inventoryUnitFactorOz = getConversionFactor(product.inventory_unit, conversions);

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

/** Validate commission splits sum to 100% */
export function validateCommissionSplits(
  splits: Array<{ recipient: string; percentage: number }>
): string | null {
  if (splits.length === 0) return null;
  const sum = splits.reduce((acc, s) => acc + s.percentage, 0);
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
