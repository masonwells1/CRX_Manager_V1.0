/**
 * Parse a dollar string into cents (integer).
 * Uses string splitting to avoid parseFloat precision issues.
 * "25.50" → 2550, "$1,234.56" → 123456, "10" → 1000, "" → 0
 */
export function parseDollarsToCents(input: string): number {
  if (!input || typeof input !== 'string') return 0;
  const cleaned = input.replace(/[^0-9.]/g, '');
  if (!cleaned) return 0;
  const parts = cleaned.split('.');
  const dollars = parseInt(parts[0] || '0', 10);
  const centStr = (parts[1] || '00').substring(0, 2).padEnd(2, '0');
  const cents = parseInt(centStr, 10);
  return dollars * 100 + cents;
}
