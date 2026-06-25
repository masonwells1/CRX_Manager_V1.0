/**
 * billedCustomersResolver — the ONE safe way to resolve a job's billed customers
 * for a compliance/operational PDF (Chemical Application Report #11, Loader
 * Worksheet #10), shared by every entry point.
 *
 * WHY THIS EXISTS (the #11 compliance bug): on a SPLIT-BILLED job, an APPLICATOR's
 * `customers_select` RLS only exposes the job's PRIMARY customer — it has NO path
 * to the CO-billed customers in job_field_shares / field_billing_defaults. A direct
 * customers embed/lookup therefore returns NULL names for those co-billed customers
 * and the report code silently DROPS them, producing an incomplete compliance PDF
 * (while still stamping printed_at). This resolver calls the SECURITY DEFINER RPC
 * `get_job_billed_customers`, which resolves those names with definer privileges
 * (saved shares → field_billing_defaults → primary customer_id) WITHOUT widening
 * who can see the job (it self-gates on the same applicator predicate as
 * jobs_select). See migration 20260625180000_get_job_billed_customers.sql.
 *
 * DEFENSE-IN-DEPTH: even with the RPC, if ANY resolved billed customer still has a
 * blank name, `complete` is false — the caller MUST abort the PDF (and the
 * printed_at stamp). A compliance document is complete-or-refused, never silently
 * partial.
 */
import { supabase, assertRpcResult } from './db';
import type { ApplicatorSheetCustomer } from './applicatorSheetData';

/** One billed-customer row as returned by the get_job_billed_customers RPC. */
interface BilledCustomerRpcRow {
  customer_id: string;
  farm_name: string | null;
  account_number: string | null;
  is_primary: boolean;
}

/** The resolver result: the deduped customer list + whether resolution was complete. */
export interface ResolvedBilledCustomers {
  /** Deduped billed customers (name+account), in the RPC's order (primary first). */
  customers: ApplicatorSheetCustomer[];
  /**
   * False when the RPC returned at least one billed customer whose name failed to
   * resolve (blank farm_name) — i.e. the customer set is INCOMPLETE. The caller must
   * ABORT the PDF and NOT stamp printed_at when this is false. Also false when the
   * RPC returned NO rows for a job (a real job always has at least its primary
   * customer, so an empty result means something is wrong).
   */
  complete: boolean;
}

/**
 * Resolve a job's billed customers via the SECURITY DEFINER RPC. Returns the deduped
 * customer list AND a `complete` flag the caller uses to refuse an incomplete
 * compliance document.
 *
 * Throws if the RPC errors (e.g. the caller is not authorized to view the job) — the
 * caller's existing try/catch surfaces that as a toast, never a silent partial PDF.
 */
export async function resolveBilledCustomers(jobId: string): Promise<ResolvedBilledCustomers> {
  const { data, error } = await supabase.rpc('get_job_billed_customers', { p_job_id: jobId });
  if (error) throw error;
  const rows = assertRpcResult<BilledCustomerRpcRow[]>(data, 'get_job_billed_customers');

  // Dedup by customer_id (the RPC's stable identity), preserving the RPC's order.
  // NOTE: do NOT dedup by name+account — two DISTINCT co-billed customers that happen
  // to share a farm_name+account_number would collapse to one line and silently drop a
  // billed party (Codex MED). The RPC already returns distinct customer_ids, so this
  // dedup is just a belt-and-suspenders guard keyed on the real identity.
  const seen = new Set<string>();
  const customers: ApplicatorSheetCustomer[] = [];
  let complete = rows.length > 0;
  for (const r of rows) {
    const name = (r.farm_name ?? '').trim();
    if (name === '') {
      // A billed customer the RPC could not resolve to a name → INCOMPLETE.
      complete = false;
      continue;
    }
    if (seen.has(r.customer_id)) continue;
    seen.add(r.customer_id);
    customers.push({ customer_name: name, account_number: r.account_number ?? null });
  }
  return { customers, complete };
}
