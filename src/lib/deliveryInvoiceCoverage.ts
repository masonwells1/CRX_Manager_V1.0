export interface InvoiceBillingCoverage {
  order_id: string | null;
  invoice_type: string;
  status: string;
  deleted_at: string | null;
}

export interface DeliveryInvoiceCoverage extends InvoiceBillingCoverage {
  delivery_id: string | null;
}

const NON_COVERING_STATUSES = new Set(['voided', 'cancelled']);

/**
 * A return credit changes AR; it does not prove that the sale was billed.
 * Keep every order-level billing surface on the same active-sale predicate.
 */
export function activeInvoiceCoversOrder(
  invoice: InvoiceBillingCoverage,
  orderId: string,
): boolean {
  return invoice.order_id === orderId
    && invoice.invoice_type !== 'credit_memo'
    && !NON_COVERING_STATUSES.has(invoice.status)
    && invoice.deleted_at === null;
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
