import { supabase } from './db';

export type InvoiceSendDisposition = 'sendable' | 'suppressed_zero_total';
const NON_SENDABLE_STATUSES = new Set(['voided', 'cancelled']);

export function assertInvoiceSendDisposition(
  value: unknown,
  status?: unknown,
  deletedAt?: unknown,
): asserts value is InvoiceSendDisposition {
  if (deletedAt != null || NON_SENDABLE_STATUSES.has(String(status))) {
    throw new Error('A voided, cancelled, or deleted invoice must not be emailed.');
  }
  if (value === 'suppressed_zero_total') {
    throw new Error('This $0 split invoice is suppressed and must not be emailed.');
  }
  if (value !== 'sendable') {
    throw new Error('Invoice send status is unavailable. Reload before emailing.');
  }
}

/** Re-read the server-owned gate immediately before every invoice email send. */
export async function assertInvoiceSendable(invoiceId: string): Promise<void> {
  const { data, error } = await supabase
    .from('invoices')
    .select('send_disposition,status,deleted_at')
    .eq('id', invoiceId)
    .maybeSingle();
  if (error) throw error;
  const row = data as { send_disposition?: unknown; status?: unknown; deleted_at?: unknown } | null;
  assertInvoiceSendDisposition(row?.send_disposition, row?.status, row?.deleted_at);
}
