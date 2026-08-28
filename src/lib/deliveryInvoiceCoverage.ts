import { supabase } from './db';
import { chunkIds } from './dispatchDisplay';

export interface InvoiceBillingCoverage {
  order_id: string | null;
  invoice_type: string;
  status: string;
  deleted_at: string | null;
}

export interface DeliveryInvoiceCoverage extends InvoiceBillingCoverage {
  delivery_id: string | null;
}

export interface ActiveInvoiceCoverageRow extends DeliveryInvoiceCoverage {
  id: string;
  total_amount_cents: number;
}

const INVOICE_COVERAGE_PAGE_SIZE = 1000;
const INVOICE_COVERAGE_ID_CHUNK_SIZE = 200;

/**
 * Fetch every active invoice row for a set of orders without trusting the
 * gateway URL limit or PostgREST server row cap. Order ids are de-duplicated
 * and chunked before each paginated query. Advancing by the rows actually
 * returned also keeps the loop complete when a deployment uses a cap below
 * our requested size.
 */
export async function fetchActiveInvoiceCoveragePages(orderIds: string[]) {
  const rows: ActiveInvoiceCoverageRow[] = [];
  if (orderIds.length === 0) return { data: rows, error: null };

  const uniqueOrderIds = [...new Set(orderIds)];
  for (const orderIdChunk of chunkIds(uniqueOrderIds, INVOICE_COVERAGE_ID_CHUNK_SIZE)) {
    for (let from = 0; ;) {
      const { data, error } = await supabase
        .from('invoices')
        .select('id, order_id, delivery_id, total_amount_cents, invoice_type, status, deleted_at')
        .in('order_id', orderIdChunk)
        .not('status', 'in', '("voided","cancelled")')
        .is('deleted_at', null)
        .order('id', { ascending: true })
        .range(from, from + INVOICE_COVERAGE_PAGE_SIZE - 1);

      if (error) return { data: null, error };
      const page = (data || []) as ActiveInvoiceCoverageRow[];
      if (page.length === 0) break;
      rows.push(...page);
      from += page.length;
    }
  }

  return { data: rows, error: null };
}

const NON_COVERING_STATUSES = new Set(['voided', 'cancelled']);

export function activeInvoiceCountsTowardBilling(
  invoice: InvoiceBillingCoverage,
): boolean {
  return invoice.invoice_type !== 'credit_memo'
    && !NON_COVERING_STATUSES.has(invoice.status)
    && invoice.deleted_at === null;
}

/**
 * A return credit changes AR; it does not prove that the sale was billed.
 * Keep every order-level billing surface on the same active-sale predicate.
 */
export function activeInvoiceCoversOrder(
  invoice: InvoiceBillingCoverage,
  orderId: string,
): boolean {
  return invoice.order_id === orderId
    && activeInvoiceCountsTowardBilling(invoice);
}

/**
 * Mirrors the server-side delivery invoice guards. Credit memos reverse a sale;
 * they never prove that a delivery was billed.
 */
export function activeInvoiceCoversDelivery(
  invoice: DeliveryInvoiceCoverage,
  deliveryId: string,
  orderId: string,
): boolean {
  return activeInvoiceCoversOrder(invoice, orderId)
    && (invoice.delivery_id === deliveryId || invoice.delivery_id === null);
}
