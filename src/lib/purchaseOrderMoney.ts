export function purchaseOrderUnitCostCents(unitCostDollars: number): number {
  if (!Number.isFinite(unitCostDollars)) return 0;
  return Math.round(unitCostDollars * 100);
}

export function purchaseOrderLineTotalCents(
  quantity: number,
  unitCostDollars: number,
): number {
  if (!Number.isFinite(quantity)) return 0;
  const unitCostCents = purchaseOrderUnitCostCents(unitCostDollars);
  const [mantissa, exponentText = '0'] = String(quantity).toLowerCase().split('e');
  const negative = mantissa.startsWith('-');
  const unsigned = negative || mantissa.startsWith('+') ? mantissa.slice(1) : mantissa;
  const [whole, fraction = ''] = unsigned.split('.');
  const exponent = Number(exponentText);
  const digits = `${whole || '0'}${fraction}`.replace(/^0+(?=\d)/, '');
  const decimalPlaces = fraction.length - exponent;
  const coefficient = BigInt(digits || '0') * BigInt(unitCostCents);
  const numerator = negative ? -coefficient : coefficient;

  if (decimalPlaces <= 0) {
    return Number(numerator * (10n ** BigInt(-decimalPlaces)));
  }

  const divisor = 10n ** BigInt(decimalPlaces);
  const absolute = numerator < 0n ? -numerator : numerator;
  let rounded = absolute / divisor;
  if ((absolute % divisor) * 2n >= divisor) rounded += 1n;
  return Number(numerator < 0n ? -rounded : rounded);
}

export function purchaseOrderCentsToDollars(cents: number): number {
  return cents / 100;
}
