/**
 * Pure math functions extracted from QuoteBuilder for testability.
 * These are the core pricing / unit-conversion calculations.
 */
import type { Product, UnitConversion } from '../types';

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
}

/** Get tier price from product — pure function */
export function getTierPrice(product: Product, tierNum: number): number {
  if (tierNum === 1) return product.tier1_price || 0;
  if (tierNum === 2) return product.tier2_price || 0;
  return product.tier3_price || 0;
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
  const actualRate = item.actual_rate || 0;
  const acres = item.acres || 0;

  // Convert application rate to oz using the rate_unit's conversion factor
  const rateUnitFactorOz = getConversionFactor(item.rate_unit, conversions);
  const rateInOz = actualRate * rateUnitFactorOz;
  const ozPerAcre = rateInOz;

  // Convert oz to inventory units using the product's inventory_unit factor
  const inventoryUnitFactorOz = getConversionFactor(product.inventory_unit, conversions);
  const totalInventoryUnits =
    inventoryUnitFactorOz > 0 ? (acres * rateInOz) / inventoryUnitFactorOz : 0;

  // Price is per inventory unit
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
    totalPrice += item.total_price;
    totalCost += item.current_cost * (item.total_units_needed || 0);
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
