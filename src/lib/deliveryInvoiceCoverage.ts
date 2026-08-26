export interface DeliveryInvoiceCoverage {
  order_id: string;
  delivery_id: string | null;
  invoice_type: string;
  status: string;
  deleted_at: string | null;
}

const NON_COVERING_STATUSES = new Set(['voided', 'cancelled']);

/**
 * Mirrors the server-side delivery invoice guards. Credit memos reverse a sale;
 * they never prove that a delivery was billed.
 */
export function activeInvoiceCoversDelivery(
  invoice: DeliveryInvoiceCoverage,
  deliveryId: string,
  orderId: string,
): boolean {
  return invoice.order_id === orderId
    && invoice.invoice_type !== 'credit_memo'
    && !NON_COVERING_STATUSES.has(invoice.status)
    && invoice.deleted_at === null
    && (invoice.delivery_id === deliveryId || invoice.delivery_id === null);
}
