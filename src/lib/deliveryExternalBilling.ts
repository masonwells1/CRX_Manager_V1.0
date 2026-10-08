import { supabaseUntyped } from './db';

const PAGE_SIZE = 1000;

/**
 * Every delivery recorded in delivery_external_billings — billed outside CRX
 * (e.g. in Chem Man), so CRX must neither list it as unbilled nor invoice it.
 * Readable by admins and sales reps (RLS); other roles get an empty set.
 *
 * Pages through the table instead of trusting one request: past the PostgREST
 * row cap a single select would silently drop records and those deliveries
 * would reappear as "delivered, not invoiced". Advancing by the rows actually
 * returned keeps the loop complete under a lower server cap too.
 * (delivery_external_billings is not yet in the generated types.)
 */
export async function fetchBilledOutsideCrxDeliveryIds() {
  const ids = new Set<string>();
  for (let from = 0; ;) {
    const { data, error } = await supabaseUntyped
      .from('delivery_external_billings')
      .select('delivery_id')
      .order('delivery_id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) return { data: null, error };
    const page = (data ?? []) as Array<{ delivery_id: string }>;
    if (page.length === 0) break;
    for (const row of page) ids.add(row.delivery_id);
    from += page.length;
  }
  return { data: ids, error: null };
}
