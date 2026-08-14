/**
 * Pure math functions extracted from QuoteBuilder for testability.
 * These are the core pricing / unit-conversion calculations.
 *
 * NOT AUTHORITATIVE FOR PERSISTENCE. The server recalculates and persists all
 * quote line math in save_quote() (migration 20260528042000) — that is the
 * single source of truth for stored prices. These functions provide exact-cent
 * live-preview math for QuoteBuilder, but the save payload is still only a
 * request: callers must install the authoritative totals returned by save_quote
 * after a successful save. (Foundation audit P2-E, 2026-05-28.)
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
  /**
   * Quote-time cost snapshot. `null` means the line has no snapshot yet (new
   * line, or one whose product just changed) and the live catalog cost should
   * be used. A stored `0` is a real cost, not a missing one, so this is read
   * with `??` rather than `||`.
   */
  current_cost: number | null;
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

type DecimalParts = { coefficient: bigint; scale: number };

/**
 * Convert a finite JS number's canonical decimal spelling into an exact
 * coefficient/scale pair. Money rounding below then uses bigint arithmetic,
 * not binary floating-point Math.round (which turns 1.005 into 1.00).
 */
function decimalParts(value: number): DecimalParts {
  if (!Number.isFinite(value)) throw new RangeError('Money operand must be finite');
  const match = value.toString().match(/^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
  if (!match) throw new RangeError('Money operand must be decimal');
  const [, sign, whole, fraction = '', exponentText = '0'] = match;
  const exponent = Number(exponentText);
  let coefficient = BigInt(`${whole}${fraction}`);
  if (sign === '-') coefficient = -coefficient;
  let scale = fraction.length - exponent;
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { coefficient, scale };
}

function roundedDecimalRatio(
  numerators: number[],
  denominators: number[] = [],
  targetScale = 2,
): number {
  let numerator = 1n;
  let numeratorScale = 0;
  for (const value of numerators) {
    const parts = decimalParts(value);
    numerator *= parts.coefficient;
    numeratorScale += parts.scale;
  }

  let denominator = 1n;
  let denominatorScale = 0;
  for (const value of denominators) {
    const parts = decimalParts(value);
    denominator *= parts.coefficient;
    denominatorScale += parts.scale;
  }
  if (denominator === 0n) throw new RangeError('Money divisor must be non-zero');

  numerator *= 10n ** BigInt(denominatorScale + targetScale);
  denominator *= 10n ** BigInt(numeratorScale);
  const negative = (numerator < 0n) !== (denominator < 0n);
  const absoluteNumerator = numerator < 0n ? -numerator : numerator;
  const absoluteDenominator = denominator < 0n ? -denominator : denominator;
  let rounded = absoluteNumerator / absoluteDenominator;
  if ((absoluteNumerator % absoluteDenominator) * 2n >= absoluteDenominator) rounded += 1n;
  if (negative) rounded = -rounded;

  const asNumber = Number(rounded);
  if (!Number.isSafeInteger(asNumber)) throw new RangeError('Money result exceeds safe cents');
  return asNumber;
}

const centsToDollars = (cents: number): number => cents / 100;
const ratioDollars = (numerators: number[], denominators: number[]): number =>
  centsToDollars(roundedDecimalRatio(numerators, denominators));

/**
 * Settle a product or ratio to whole-cent dollars using PostgreSQL-compatible
 * decimal half-up rounding. Callers pass the original decimal operands so a
 * binary-float intermediate cannot move an exact half-cent boundary.
 */
export function settleMoneyRatio(
  numerators: number[],
  denominators: number[] = [],
): number {
  return centsToDollars(roundedDecimalRatio(numerators, denominators));
}

/** Settle decimal money operands directly to an integer-cent comparison key. */
export function settleMoneyCents(
  numerators: number[],
  denominators: number[] = [],
): number {
  return roundedDecimalRatio(numerators, denominators);
}

/**
 * Settle an inventory quantity to the same two-decimal boundary used by
 * save_quote before that quantity participates in line-level money math.
 */
export function settleQuantityHundredths(
  numerators: number[],
  denominators: number[] = [],
): number {
  return roundedDecimalRatio(numerators, denominators) / 100;
}

/** Difference between two independently settled money expressions. */
export function settleMoneyDifference(
  minuendNumerators: number[],
  subtrahendNumerators: number[],
  minuendDenominators: number[] = [],
  subtrahendDenominators: number[] = [],
): number {
  const minuendCents = roundedDecimalRatio(minuendNumerators, minuendDenominators);
  const subtrahendCents = roundedDecimalRatio(subtrahendNumerators, subtrahendDenominators);
  return centsToDollars(minuendCents - subtrahendCents);
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
  // Preserve the line's stored quote-time cost; only fall back to the live
  // catalog cost when the line has none yet (new or just-changed product).
  // Mirrors QuoteBuilder.recalcItem and the save_quote snapshot semantics.
  const currentCost = item.current_cost ?? product.current_cost ?? 0;

  if (mode === 'units_direct') {
    // User entered total_units_needed directly — skip rate×acres computation
    const enteredInventoryUnits = item.total_units_needed || 0;
    const totalInventoryUnits = settleQuantityHundredths([enteredInventoryUnits]);
    // Settled revenue minus settled extended cost -- the SAME boundary
    // save_quote and the report RPCs use. Rounding (price - cost) * qty as one
    // expression disagrees with them by a cent on fractional quantities whose
    // extensions land on a half-cent, so the quote on screen would differ from
    // the quote that was stored and converted. (Codex round 41.)
    const totalPriceCents = roundedDecimalRatio([pricePerUnit, totalInventoryUnits]);
    const totalCostCents = roundedDecimalRatio([currentCost, totalInventoryUnits]);
    const totalPrice = centsToDollars(totalPriceCents);
    const profit = centsToDollars(totalPriceCents - totalCostCents);
    const netMargin = totalPrice > 0 ? profit / totalPrice : 0;

    // Back-calculate rate if acres is also set (informational)
    const acres = item.acres || 0;
    let ozPerAcre: number | null = item.oz_per_acre;
    let pricePerAcre: number | null = item.price_per_acre;
    if (acres > 0 && inventoryUnitFactorOz > 0) {
      const totalOz = totalInventoryUnits * inventoryUnitFactorOz;
      ozPerAcre = Math.round((totalOz / acres) * 100) / 100;
      pricePerAcre = ratioDollars([totalPrice], [acres]);
    }

    return {
      ...item,
      price_per_unit: pricePerUnit,
      current_cost: currentCost,
      oz_per_acre: ozPerAcre,
      price_per_acre: pricePerAcre,
      total_units_needed: Math.round(totalInventoryUnits * 100) / 100,
      total_price: totalPrice,
      profit: profit,
      net_margin: Math.round(netMargin * 100 * 100) / 100,
    };
  }

  // Default: rate_acres mode — compute units from rate × acres
  const actualRate = item.actual_rate || 0;
  const acres = item.acres || 0;

  const rateUnitFactorOz = getConversionFactor(item.rate_unit, conversions);
  const rateInOz = actualRate * rateUnitFactorOz;
  const ozPerAcre = rateInOz;

  const totalInventoryUnits = inventoryUnitFactorOz > 0
    ? settleQuantityHundredths(
        [acres, actualRate, rateUnitFactorOz],
        [inventoryUnitFactorOz],
      )
    : 0;

  const pricePerAcre =
    inventoryUnitFactorOz > 0
      ? ratioDollars(
          [pricePerUnit, actualRate, rateUnitFactorOz],
          [inventoryUnitFactorOz],
        )
      : 0;
  // save_quote first settles quantity to hundredths, then extends revenue and
  // cost from that stored quantity. Reuse that boundary so the preview cannot
  // disagree with the authoritative persisted line on tiny applications.
  const totalPriceCents = roundedDecimalRatio([pricePerUnit, totalInventoryUnits]);
  const totalCostCents = roundedDecimalRatio([currentCost, totalInventoryUnits]);
  const totalPrice = centsToDollars(totalPriceCents);
  const profit = centsToDollars(totalPriceCents - totalCostCents);
  const netMargin = totalPrice > 0 ? profit / totalPrice : 0;

  return {
    ...item,
    price_per_unit: pricePerUnit,
    current_cost: currentCost,
    oz_per_acre: Math.round(ozPerAcre * 100) / 100,
    price_per_acre: pricePerAcre,
    total_units_needed: Math.round(totalInventoryUnits * 100) / 100,
    total_price: totalPrice,
    profit: profit,
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
  const rateFactor = getConversionFactor(product.rate_unit, conversions);
  return ratioDollars(
    [getTierPrice(product, tierNum), rate, rateFactor],
    [inventoryUnitFactorOz],
  );
}

/** Compute quote-level totals from items */
export function computeQuoteTotals(items: CalcItem[]): {
  totalPrice: number;
  totalCost: number;
  totalProfit: number;
  totalMarginPct: number;
} {
  let totalPriceCents = 0;
  let totalCostCents = 0;
  let totalProfitCents = 0;
  for (const item of items) {
    const linePriceCents = roundedDecimalRatio([item.total_price || 0]);
    const lineProfitCents = roundedDecimalRatio([item.profit || 0]);
    totalPriceCents += linePriceCents;
    totalProfitCents += lineProfitCents;
    totalCostCents += linePriceCents - lineProfitCents;
  }
  const totalPrice = centsToDollars(totalPriceCents);
  const totalCost = centsToDollars(totalCostCents);
  const totalProfit = centsToDollars(totalProfitCents);
  const totalMarginPct = totalPrice > 0 ? (totalProfit / totalPrice) * 100 : 0;
  return {
    totalPrice,
    totalCost,
    totalProfit,
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
