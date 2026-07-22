import type { Product } from '../types';

/** Prefer customer-facing quote guidance, with the grower description as a legacy fallback. */
export function preferredQuoteNotes(
  product: Pick<Product, 'quoting_notes' | 'notes'>,
): string {
  return product.quoting_notes || product.notes || '';
}
