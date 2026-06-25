/**
 * loaderWorksheetFetch — fetch the full per-job data a Loader Worksheet PDF needs
 * (field-app parity #10), for the Jobs-list BULK "Loader Worksheet" action.
 *
 * The job LIST query is summary-only (it does not pull per-product quantity/unit,
 * per-field acres, or the carrier rate / capacity override). The single-job print
 * on JobDetail builds its data from in-memory form state; for the bulk action we
 * re-fetch each selected job's full mix + fields here and map it to the shared
 * LoaderWorksheetPdfData shape, so the per-load split is computed from the SAME
 * pure engine and prints identically.
 *
 * Kept out of the page so the PostgREST shape mapping is isolated. The applicator
 * NAME is resolved via profile_public_view (LEDGER lesson: never embed `profiles`
 * — the RLS hides other users' rows and the name would render "(removed)").
 *
 * Billed CUSTOMERS are resolved via the SECURITY DEFINER RPC get_job_billed_customers
 * (resolveBilledCustomers), NOT a customers embed: on a split-billed job an
 * applicator's customers_select RLS hides the CO-billed customers, so an embed would
 * silently drop them. If ANY selected job's billed-customer resolution is incomplete
 * this THROWS so the caller aborts the worksheet and never stamps printed_at — the
 * same complete-or-refused rule the #11 chemical report uses (shared resolver).
 */
import { supabase } from './db';
import { resolveBilledCustomers } from './billedCustomersResolver';
import { isGallonCapacityUnit } from './loaderWorksheet';
import type { LoaderWorksheetPdfData } from './loaderWorksheetPdf';
import type { ApplicatorSheetCustomer } from './applicatorSheetData';

/** Raw row shape from the loader-worksheet fetch (only the columns we read). */
interface LoaderJobRow {
  id: string;
  job_number: string;
  job_date: string;
  scheduled_time: string | null;
  applicator_id: string | null;
  carrier_rate_gpa: number | null;
  loader_tank_capacity: number | null;
  loader_comment: string | null;
  vehicle: { vehicle_name: string | null; capacity_gallons: number | null; capacity_unit: string | null } | null;
  job_fields: Array<{ field_id: string | null; acres_to_treat: number | null }> | null;
  job_chemicals: Array<{ quantity: number | null; unit: string | null; product: { product_name: string | null } | null }> | null;
}

/**
 * Fetch the loader-worksheet PDF data for a set of job IDs (the bulk-selected jobs).
 * Results are returned in the SAME order as `jobIds`. Jobs that no longer exist are
 * skipped. The applicator name is resolved via profile_public_view.
 */
export async function fetchLoaderWorksheetData(jobIds: string[]): Promise<LoaderWorksheetPdfData[]> {
  if (jobIds.length === 0) return [];

  const { data, error } = await supabase
    .from('jobs')
    .select(`
      id, job_number, job_date, scheduled_time, applicator_id,
      carrier_rate_gpa, loader_tank_capacity, loader_comment,
      vehicle:vehicles(vehicle_name, capacity_gallons, capacity_unit),
      job_fields(field_id, acres_to_treat),
      job_chemicals(quantity, unit, product:products(product_name))
    `)
    .in('id', jobIds);
  if (error) throw error;

  const rows = (data || []) as unknown as LoaderJobRow[];

  // Resolve applicator names via the public profile view (never a profiles embed).
  const applicatorIds = [...new Set(rows.map((r) => r.applicator_id).filter((x): x is string => !!x))];
  const nameById = new Map<string, string>();
  if (applicatorIds.length > 0) {
    const { data: profs } = await supabase
      .from('profile_public_view')
      .select('id, full_name')
      .in('id', applicatorIds);
    ((profs || []) as Array<{ id: string; full_name: string | null }>).forEach((p) => {
      if (p.full_name) nameById.set(p.id, p.full_name);
    });
  }

  // Billed customers per job via the SECURITY DEFINER RPC (saved job_field_shares →
  // field_billing_defaults → primary customer_id), which resolves the CO-billed
  // customers an applicator's customers_select RLS hides. Resolved per job (the RPC
  // self-gates each job). If ANY selected job's resolution is incomplete (a billed
  // customer with no resolvable name) ABORT — a print document is never built with a
  // silently-partial customer list (shared #11 complete-or-refused rule).
  const customersByJob = new Map<string, ApplicatorSheetCustomer[]>();
  for (const r of rows) {
    const { customers, complete } = await resolveBilledCustomers(r.id);
    if (!complete) {
      throw new Error(`Some billed customers on job ${r.job_number} could not be resolved — the loader worksheet cannot be completed.`);
    }
    customersByJob.set(r.id, customers);
  }

  const byId = new Map(rows.map((r) => [r.id, r]));
  // Preserve the caller's order; skip any id that didn't come back.
  return jobIds
    .map((jid) => byId.get(jid))
    .filter((r): r is LoaderJobRow => !!r)
    .map((r) => mapRowToPdfData(r, nameById, customersByJob.get(r.id) ?? []));
}

/** Map one fetched job row to the shared LoaderWorksheetPdfData. */
function mapRowToPdfData(
  r: LoaderJobRow,
  nameById: Map<string, string>,
  billedCustomers: ApplicatorSheetCustomer[],
): LoaderWorksheetPdfData {
  const totalAcres = (r.job_fields || []).reduce((s, f) => s + (f.acres_to_treat || 0), 0);

  // Effective capacity: the per-job override (in gallons) wins over the assigned
  // vehicle's. The vehicle capacity is only usable as a GALLON tank size when its
  // unit measures gallons — a dry spreader rated in lbs/tons can't seed gallon
  // loads, so without a gallon override the worksheet shows its "enter capacity"
  // guard rather than dividing gallons of spray by pounds (Codex).
  const override = r.loader_tank_capacity != null && r.loader_tank_capacity > 0 ? r.loader_tank_capacity : null;
  const vehicleCap = isGallonCapacityUnit(r.vehicle?.capacity_unit) ? (r.vehicle?.capacity_gallons ?? null) : null;
  const effectiveCapacity = override ?? vehicleCap;
  const capacityUnit = override != null ? 'gal' : (r.vehicle?.capacity_unit || 'gal');

  return {
    job_number: r.job_number,
    customers: billedCustomers,
    scheduled_date: r.job_date,
    scheduled_time: r.scheduled_time,
    applicator_name: r.applicator_id ? (nameById.get(r.applicator_id) ?? null) : null,
    vehicle_name: r.vehicle?.vehicle_name ?? null,
    total_acres: totalAcres,
    carrier_rate_gpa: r.carrier_rate_gpa,
    tank_capacity: effectiveCapacity,
    capacity_unit: capacityUnit,
    products: (r.job_chemicals || [])
      .filter((c) => c.product?.product_name || c.quantity != null)
      .map((c) => ({
        product_name: c.product?.product_name || 'Product',
        total_quantity: c.quantity,
        unit: c.unit,
      })),
    loader_comment: r.loader_comment,
  };
}
