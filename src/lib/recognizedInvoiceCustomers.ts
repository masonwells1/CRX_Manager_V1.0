import { supabase } from './db';

const PAGE_SIZE = 1000;

export interface RecognizedInvoiceCustomerRow {
  id: string;
  customer_id: string | null;
}

type FetchRecognizedInvoicePage = (
  from: number,
  to: number,
) => Promise<RecognizedInvoiceCustomerRow[]>;

export async function collectRecognizedInvoiceCustomerIds(
  fetchPage: FetchRecognizedInvoicePage,
): Promise<string[]> {
  const customerIds = new Set<string>();

  for (let from = 0; ; from += PAGE_SIZE) {
    const rows = await fetchPage(from, from + PAGE_SIZE - 1);
    for (const row of rows) {
      if (row.customer_id) customerIds.add(row.customer_id);
    }
    if (rows.length < PAGE_SIZE) break;
  }

  return [...customerIds];
}

export async function getRecognizedInvoiceCustomerIds(season: number): Promise<string[]> {
  return collectRecognizedInvoiceCustomerIds(async (from, to) => {
    const { data, error } = await supabase
      .from('invoices')
      .select('id, customer_id')
      .eq('season', season)
      .in('status', ['posted', 'overdue', 'paid'])
      .is('deleted_at', null)
      .order('id', { ascending: true })
      .range(from, to);
    if (error) throw error;
    return data || [];
  });
}
