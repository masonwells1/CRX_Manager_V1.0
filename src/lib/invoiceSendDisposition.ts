import { supabase } from './db';

export type InvoiceSendDisposition = 'sendable' | 'suppressed_zero_total';

export function assertInvoiceSendDisposition(value: unknown): asserts value is InvoiceSendDisposition {
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
    .select('send_disposition')
    .eq('id', invoiceId)
    .maybeSingle();
  if (error) throw error;
  assertInvoiceSendDisposition((data as { send_disposition?: unknown } | null)?.send_disposition);
}
