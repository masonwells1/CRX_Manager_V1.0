import { supabase } from './db';
import { chunkIds } from './dispatchDisplay';

/**
 * Client mirror of the server's ORDER_NEEDS_SPLIT_BILLING guard inside
 * `create_invoice_for_unbilled_delivery`
 * (`20260718202607_backfill_invoice_guard_durable_split_allocations.sql`,
 * re-emitted in `20260719024641_lock_backfill_split_allocation_rows.sql`).
 *
 * The server refuses a single backfilled invoice when EITHER condition holds:
 *
 *   (SELECT COALESCE(needs_split_billing, false) FROM orders WHERE id = <order>)
 *   OR EXISTS (SELECT 1 FROM order_item_field_allocations oifa
 *              JOIN order_items oi ON oi.id = oifa.order_item_id
 *              WHERE oi.order_id = <order>)
 *
 * H5: both admin surfaces used to offer a "Create invoice" button on those
 * deliveries, where it can never succeed. This module exists so the two
 * surfaces share ONE predicate instead of two conditions that can drift apart.
 *
 * Deliberately an OR of both signals, not just the flag: `needs_split_billing`
 * is a queue marker that can be cleared while allocation rows remain, and the
 * allocation rows are what actually make a mono-bill mis-attribute AR. The
 * server checks both; so do we.
 */

const SPLIT_BILLING_ORDER_ID_CHUNK_SIZE = 200;
const SPLIT_BILLING_PAGE_SIZE = 1000;

export interface OrderSplitBillingSignal {
  /** `orders.needs_split_billing` — the queue flag. */
  needs_split_billing?: boolean | null;
  /** Whether ANY `order_item_field_allocations` row exists under this order. */
  has_field_allocations?: boolean;
}

/**
 * True when the server guard would refuse to create one whole-order invoice
 * for this delivery's order.
 */
export function orderRequiresSplitBilling(
  signal: OrderSplitBillingSignal | null | undefined,
): boolean {
  if (!signal) return false;
  return signal.needs_split_billing === true || signal.has_field_allocations === true;
}

/**
 * Which of `orderIds` the server would refuse to single-invoice.
 *
 * Reads two sources and unions them, mirroring the guard's OR. Both reads are
 * chunked by order id, and the allocation read is range-paged, so neither the
 * PostgREST row cap nor a long id list can silently truncate the answer into a
 * FALSE "this order is fine".
 *
 * RLS: `oifa_select` is `is_admin() OR is_sales_rep()`. Both callers gate their
 * button on admin, so an admin caller always sees the rows that matter.
 *
 * On error this returns `{ data: null, error }` and callers FAIL OPEN — they
 * keep showing the button. That is deliberate: the server still refuses
 * correctly and (since this same change) now explains why on both surfaces, so
 * a transient read failure costs a clear error message, whereas failing closed
 * would silently remove a working action from a legitimate delivery.
 */
export async function fetchSplitBillingOrderIds(
  orderIds: string[],
): Promise<{ data: Set<string> | null; error: unknown }> {
  const flagged = new Set<string>();
  if (orderIds.length === 0) return { data: flagged, error: null };

  const uniqueOrderIds = [...new Set(orderIds)];

  for (const orderIdChunk of chunkIds(uniqueOrderIds, SPLIT_BILLING_ORDER_ID_CHUNK_SIZE)) {
    const { data: flagRows, error: flagError } = await supabase
      .from('orders')
      .select('id')
      .in('id', orderIdChunk)
      .is('needs_split_billing', true);
    if (flagError) return { data: null, error: flagError };
    for (const row of flagRows || []) flagged.add(row.id);

    for (let from = 0; ;) {
      const { data: allocRows, error: allocError } = await supabase
        .from('order_item_field_allocations')
        .select('id, order_items!inner(order_id)')
        .in('order_items.order_id', orderIdChunk)
        .order('id', { ascending: true })
        .range(from, from + SPLIT_BILLING_PAGE_SIZE - 1);
      if (allocError) return { data: null, error: allocError };

      const page = (allocRows || []) as unknown as Array<{
        id: string;
        order_items?: { order_id: string } | { order_id: string }[] | null;
      }>;
      if (page.length === 0) break;
      for (const row of page) {
        const oi = Array.isArray(row.order_items) ? row.order_items[0] : row.order_items;
        if (oi?.order_id) flagged.add(oi.order_id);
      }
      from += page.length;
    }
  }

  return { data: flagged, error: null };
}

/**
 * The single sentence both surfaces show next to a suppressed button. Kept here
 * so the two surfaces cannot drift in wording either.
 */
export const SPLIT_BILLING_BLOCK_REASON =
  'This order uses split billing (field/acre allocations). A single invoice would mono-bill it and mis-attribute AR — create the split invoices from the order instead.';
