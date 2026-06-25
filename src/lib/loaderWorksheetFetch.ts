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
 */
import { supabase } from './db';
import { isGallonCapacityUnit } from './loaderWorksheet';
import type { LoaderWorksheetPdfData } from './loaderWorksheetPdf';

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
  customer: { farm_name: string | null; account_number: string | null } | null;
  vehicle: { vehicle_name: string | null; capacity_gallons: number | null; capacity_unit: string | null } | null;
  job_fields: Array<{ field_id: string | null; acres_to_treat: number | null }> | null;
  job_chemicals: Array<{ quantity: number | null; unit: string | null; product: { product_name: string | null } | null }> | null;
  job_field_shares: Array<{ field_id: string; customer: { farm_name: string | null; account_number: string | null } | null }> | null;
}

/** A resolved billing-default share (field → customer name/account). */
interface DefaultShare {
  field_id: string;
  farm_name: string | null;
  account_number: string | null;
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
      customer:customers(farm_name, account_number),
      vehicle:vehicles(vehicle_name, capacity_gallons, capacity_unit),
      job_fields(field_id, acres_to_treat),
      job_chemicals(quantity, unit, product:products(product_name)),
      job_field_shares(field_id, customer:customers(farm_name, account_number))
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

  // Field-billing-default shares (mirrors the JobDetail single-job print): for any
  // field on a job that has NO saved job_field_shares row yet, the customer list
  // comes from field_billing_defaults — so the bulk PDF shows the same customer(s)
  // as the single-job print, not just the primary job customer. Resolve them in one
  // batched query keyed by field_id.
  const fieldsNeedingDefaults = new Set<string>();
  rows.forEach((r) => {
    const withShares = new Set((r.job_field_shares || []).map((s) => s.field_id));
    (r.job_fields || []).forEach((f) => {
      if (f.field_id && !withShares.has(f.field_id)) fieldsNeedingDefaults.add(f.field_id);
    });
  });
  const defaultsByField = new Map<string, DefaultShare[]>();
  if (fieldsNeedingDefaults.size > 0) {
    const { data: fbd } = await supabase
      .from('field_billing_defaults')
      .select('field_id, customer:customers(farm_name, account_number)')
      .in('field_id', [...fieldsNeedingDefaults]);
    ((fbd || []) as Array<{ field_id: string; customer: { farm_name: string | null; account_number: string | null } | null }>).forEach((d) => {
      if (!d.customer) return;
      const list = defaultsByField.get(d.field_id) ?? [];
      list.push({ field_id: d.field_id, farm_name: d.customer.farm_name, account_number: d.customer.account_number });
      defaultsByField.set(d.field_id, list);
    });
  }

  const byId = new Map(rows.map((r) => [r.id, r]));
  // Preserve the caller's order; skip any id that didn't come back.
  return jobIds
    .map((jid) => byId.get(jid))
    .filter((r): r is LoaderJobRow => !!r)
    .map((r) => mapRowToPdfData(r, nameById, defaultsByField));
}

/** Map one fetched job row to the shared LoaderWorksheetPdfData. */
function mapRowToPdfData(
  r: LoaderJobRow,
  nameById: Map<string, string>,
  defaultsByField: Map<string, DefaultShare[]>,
): LoaderWorksheetPdfData {
  const totalAcres = (r.job_fields || []).reduce((s, f) => s + (f.acres_to_treat || 0), 0);

  // Billed customers (mirrors JobDetail's seed order): saved job_field_shares, then
  // field_billing_defaults for fields without a saved share, then the primary job
  // customer only when a field has neither. Dedup by name+account.
  const custMap = new Map<string, { customer_name: string; account_number: string | null }>();
  const add = (name: string | null, account: string | null) => {
    if (!name) return;
    custMap.set(`${name}|${account ?? ''}`, { customer_name: name, account_number: account ?? null });
  };
  const fieldsWithShares = new Set((r.job_field_shares || []).map((s) => s.field_id));
  (r.job_field_shares || []).forEach((s) => add(s.customer?.farm_name ?? null, s.customer?.account_number ?? null));
  // Default-share customers for fields lacking a saved share; primary fallback when
  // a field has no default either.
  (r.job_fields || []).forEach((f) => {
    if (!f.field_id || fieldsWithShares.has(f.field_id)) return;
    const defs = defaultsByField.get(f.field_id);
    if (defs && defs.length > 0) {
      defs.forEach((d) => add(d.farm_name, d.account_number));
    } else {
      add(r.customer?.farm_name ?? null, r.customer?.account_number ?? null);
    }
  });
  if (custMap.size === 0 && r.customer?.farm_name) {
    custMap.set(`${r.customer.farm_name}|${r.customer.account_number ?? ''}`, {
      customer_name: r.customer.farm_name,
      account_number: r.customer.account_number ?? null,
    });
  }

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
    customers: [...custMap.values()],
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
