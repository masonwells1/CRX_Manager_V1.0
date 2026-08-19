/**
 * Inventory shortage arithmetic shared by the delivery and pick-list screens.
 *
 * WHY THIS EXISTS
 * Draw-down splits a booking across price tiers, so a single product can occupy
 * several lines on the same order or delivery. Every shortage check used to walk
 * lines one at a time and compare each against the product's WHOLE net-free
 * stock, so two half-sized tier lines both looked covered while together they
 * exceeded what was on hand — the warning simply stopped appearing on exactly
 * the orders the tier split creates.
 *
 * The need has to be summed per product BEFORE it is compared to stock. This
 * lives in one function so the three screens cannot drift apart again, and so
 * the behaviour can be tested against the code the pages actually run rather
 * than a mirrored copy of it.
 */

export interface ProductLineNeed {
  /** Product the line draws from. Lines sharing this id are one demand. */
  productId: string;
  /** Display name for the warning. The first non-empty one seen wins. */
  label: string;
  /** Units this line needs. Non-positive lines are ignored. */
  quantity: number;
}

export interface AggregatedProductNeed {
  productId: string;
  label: string;
  /** Sum of every positive line for this product. */
  quantity: number;
}

/**
 * Collapse per-line demand into per-product demand, preserving first-seen order
 * so warnings stay in the order the operator sees the lines. Lines with a
 * non-positive or non-finite quantity contribute nothing and cannot, on their
 * own, conjure a product into the result.
 */
export function sumNeedByProduct(
  lines: readonly ProductLineNeed[]
): AggregatedProductNeed[] {
  const byProduct = new Map<string, AggregatedProductNeed>();
  for (const line of lines) {
    if (!line.productId) continue;
    if (!Number.isFinite(line.quantity) || line.quantity <= 0) continue;
    const existing = byProduct.get(line.productId);
    if (existing) {
      existing.quantity += line.quantity;
      if (!existing.label && line.label) existing.label = line.label;
    } else {
      byProduct.set(line.productId, {
        productId: line.productId,
        label: line.label,
        quantity: line.quantity,
      });
    }
  }
  return [...byProduct.values()];
}
