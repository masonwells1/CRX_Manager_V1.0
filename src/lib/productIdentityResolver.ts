export interface ProductIdentityCandidate {
  id: string;
  product_name: string;
  sku?: string | null;
  is_active?: boolean | null;
}

export type ProductIdentityResolution<T extends ProductIdentityCandidate> =
  | { status: 'unique'; product: T }
  | { status: 'missing'; product: null }
  | { status: 'ambiguous'; product: null; candidates: T[] };

export function normalizeProductIdentity(value: string | null | undefined): string {
  return (value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function distinctById<T extends ProductIdentityCandidate>(products: T[]): T[] {
  return [...new Map(products.map((product) => [product.id, product])).values()];
}

/**
 * Resolves an exact normalized Product identity without treating siblings as
 * interchangeable. Name and SKU matches form one UUID-deduplicated candidate
 * set, so a SKU that equals a different Product's name fails closed.
 */
export function resolveExactProductIdentity<T extends ProductIdentityCandidate>(
  value: string | null | undefined,
  products: T[],
): ProductIdentityResolution<T> {
  const normalized = normalizeProductIdentity(value);
  if (!normalized) return { status: 'missing', product: null };

  const active = products.filter((product) => product.is_active !== false);
  const matches = distinctById(active.filter(
    (product) => (
      normalizeProductIdentity(product.product_name) === normalized
      || (product.sku != null && normalizeProductIdentity(product.sku) === normalized)
    ),
  ));
  if (matches.length === 1) return { status: 'unique', product: matches[0] };
  if (matches.length > 1) return { status: 'ambiguous', product: null, candidates: matches };
  return { status: 'missing', product: null };
}

function calculateSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  if (!left || !right) return 0;
  if (left.includes(right) || right.includes(left)) return 0.85;

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + substitutionCost,
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return 1 - (previous[right.length] / Math.max(left.length, right.length));
}

/**
 * OCR-only fallback after exact identity resolution. A tied best score is
 * deliberately unresolved so similarly named siblings can never be selected
 * by catalog order.
 */
export function resolveFuzzyProductIdentity<T extends ProductIdentityCandidate>(
  value: string | null | undefined,
  products: T[],
  minimumScore = 0.7,
): { product: T | null; score: number } {
  const exact = resolveExactProductIdentity(value, products);
  if (exact.status === 'unique') return { product: exact.product, score: 1 };
  if (exact.status === 'ambiguous') return { product: null, score: 0 };

  const normalized = normalizeProductIdentity(value).replace(/[^a-z0-9]/g, '');
  let bestScore = 0;
  const scored = products
    .filter((product) => product.is_active !== false)
    .map((product) => ({
      product,
      score: calculateSimilarity(
        normalized,
        normalizeProductIdentity(product.product_name).replace(/[^a-z0-9]/g, ''),
      ),
    }));

  for (const candidate of scored) bestScore = Math.max(bestScore, candidate.score);
  const tiedBest = distinctById(
    scored
      .filter(({ score }) => score >= minimumScore && Math.abs(score - bestScore) < Number.EPSILON)
      .map(({ product }) => product),
  );
  return tiedBest.length === 1
    ? { product: tiedBest[0], score: bestScore }
    : { product: null, score: 0 };
}
