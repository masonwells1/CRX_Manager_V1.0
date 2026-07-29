export function parseApplicationServiceCostCents(value: unknown): bigint {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  // Backward compatibility while production still has the bigint-returning RPC.
  // Unsafe JSON numbers are rejected because their original cents are already lost.
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  throw new Error('Application service cost RPC returned unsafe cents.');
}

export function formatApplicationServiceCostDollars(cents: bigint): string {
  const whole = (cents / 100n).toString();
  const fraction = (cents % 100n).toString().padStart(2, '0');
  return `${whole}.${fraction}`;
}

export function formatApplicationServiceCostPerAcre(cents: bigint): string {
  return `$${formatApplicationServiceCostDollars(cents)}/ac`;
}
