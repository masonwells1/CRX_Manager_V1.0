/**
 * chemicalApplicationReportFetch — fetch the full per-job data the Chemical
 * Application Report PDF needs (field-app parity #11), for the Jobs-list row
 * action (and any other off-page caller).
 *
 * The job LIST query is summary-only (no per-product quantity/unit, per-field
 * acres/crop/pest, route order, or the product compliance fields). This re-fetches
 * one job's full mix + fields + product label data and feeds it through the SHARED
 * `buildApplicatorSheetData` gatherer — the SAME gatherer JobDetail's single-job
 * print uses — so the report's products, rates, totals and gal/lb conversions are
 * byte-identical to the applicator field sheet (#9) for that job.
 *
 * Kept out of the page so the PostgREST shape mapping is isolated. The applicator
 * NAME is resolved via profile_public_view (LEDGER lesson: never embed `profiles`
 * — RLS hides other users' rows and the name renders "(removed)").
 *
 * Product compliance fields (REI/PHI/EPA reg/product_form) are read from a direct
 * `products` lookup by id (NOT a job_chemicals→products embed), so a since-
 * DEACTIVATED product still contributes its label data — mirroring JobDetail's
 * label fetch and the WPS-notice path.
 *
 * Billed CUSTOMERS are resolved via the SECURITY DEFINER RPC get_job_billed_customers
 * (resolveBilledCustomers), NOT a customers embed: on a split-billed job an
 * applicator's customers_select RLS hides the CO-billed customers, so an embed would
 * silently drop them from this compliance PDF. If resolution is incomplete the fetch
 * THROWS so the caller aborts and never stamps printed_at (#11 compliance fix).
 */
import { supabase } from './db';
import { resolveBilledCustomers } from './billedCustomersResolver';
import {
  buildApplicatorSheetData,
  type ApplicatorSheetData,
  type RawSheetField,
  type RawSheetProduct,
} from './applicatorSheetData';

/** Raw row shape from the report fetch (only the columns we read). */
interface ReportJobRow {
  id: string;
  job_number: string;
  job_date: string;
  scheduled_time: string | null;
  applicator_id: string | null;
  job_fields: Array<{
    field_id: string | null;
    acres_to_treat: number | null;
    crop: string | null;
    pests: string | null;
    sort_order: number | null;
    field: { field_name: string | null; county: string | null; state: string | null; crop_type: string | null } | null;
  }> | null;
  job_chemicals: Array<{
    product_id: string | null;
    quantity: number | null;
    unit: string | null;
    rate_per_acre: number | null;
    rate_unit: string | null;
    rei_hours: number | null;
    phi_days: number | null;
    sort_order: number | null;
    product: { product_name: string | null } | null;
  }> | null;
}

/** Product label fields (compliance) resolved by a direct id lookup. */
interface ProductLabel {
  rei_hours: number | null;
  phi_days: number | null;
  epa_registration: string | null;
  product_form: 'liquid' | 'dry' | null;
}

/**
 * Fetch the Chemical Application Report data for one job and return the SHARED
 * ApplicatorSheetData (route order applied, gal/lb computed). Returns null when the
 * job no longer exists. The PDF generator / data mapper consume this directly.
 */
export async function fetchChemicalApplicationReportData(jobId: string): Promise<ApplicatorSheetData | null> {
  const { data, error } = await supabase
    .from('jobs')
    .select(`
      id, job_number, job_date, scheduled_time, applicator_id,
      job_fields(field_id, acres_to_treat, crop, pests, sort_order,
        field:fields(field_name, county, state, crop_type)),
      job_chemicals(product_id, quantity, unit, rate_per_acre, rate_unit, rei_hours, phi_days, sort_order,
        product:products(product_name))
    `)
    .eq('id', jobId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const r = data as unknown as ReportJobRow;

  // Applicator name via the public profile view (never a profiles embed).
  let applicatorName: string | null = null;
  if (r.applicator_id) {
    const { data: prof } = await supabase
      .from('profile_public_view')
      .select('id, full_name')
      .eq('id', r.applicator_id)
      .maybeSingle();
    applicatorName = (prof as { full_name?: string | null } | null)?.full_name ?? null;
  }

  // Product compliance fields by id (direct lookup — survives a deactivated product).
  // This is a COMPLIANCE report: a failed label lookup must ABORT (throw), never
  // silently print a PDF missing EPA reg / product-form gal/lb / fallback REI/PHI —
  // mirroring the JobDetail path which bails on the same failure (Codex P2).
  const pids = [...new Set((r.job_chemicals || []).map((c) => c.product_id).filter((x): x is string => !!x))];
  const labelById = new Map<string, ProductLabel>();
  if (pids.length > 0) {
    const { data: lp, error: lpErr } = await supabase
      .from('products')
      .select('id, rei_hours, phi_days, epa_registration, product_form')
      .in('id', pids);
    if (lpErr || !lp) throw (lpErr ?? new Error('Failed to load product label data for the chemical report'));
    (lp as Array<{ id: string; rei_hours: number | null; phi_days: number | null; epa_registration: string | null; product_form: string | null }>)
      .forEach((p) => {
        const form = p.product_form === 'liquid' || p.product_form === 'dry' ? p.product_form : null;
        labelById.set(p.id, { rei_hours: p.rei_hours, phi_days: p.phi_days, epa_registration: p.epa_registration, product_form: form });
      });
    // A short array (RLS-hidden / deleted product) returns NO error — but a missing
    // label row would silently blank that product's EPA reg / gal/lb / REI / PHI on a
    // compliance PDF. Abort if any requested product didn't come back (Codex P2).
    const missingLabel = pids.filter((pid) => !labelById.has(pid));
    if (missingLabel.length > 0) throw new Error('Some products on this job have no label data on file — the chemical report cannot be completed.');
  }

  // Billed customers via the SECURITY DEFINER RPC (saved job_field_shares →
  // field_billing_defaults → primary customer_id), which resolves the CO-billed
  // customers an applicator's customers_select RLS hides. If resolution is incomplete
  // (a billed customer with no resolvable name) this is a COMPLIANCE document — ABORT
  // (throw) so the caller never prints a silently-partial PDF or stamps printed_at.
  const { customers: billedCustomers, complete } = await resolveBilledCustomers(jobId);
  if (!complete) {
    throw new Error('Some billed customers on this job could not be resolved — the chemical report cannot be completed.');
  }

  const fields: RawSheetField[] = (r.job_fields || [])
    .filter((f) => f.field_id)
    .map((f) => ({
      field_id: f.field_id as string,
      field_name: f.field?.field_name || 'Field',
      county: f.field?.county ?? null,
      state: f.field?.state ?? null,
      acres: f.acres_to_treat || 0,
      crop: f.crop || f.field?.crop_type || null,
      pest: f.pests || null,
      sort_order: f.sort_order ?? 0,
    }));

  // Sort chemicals by their saved sort_order so the report's product order is stable
  // and matches the job's lines (PostgREST embed order is not guaranteed).
  const products: RawSheetProduct[] = (r.job_chemicals || [])
    .filter((c) => c.product_id && (c.product?.product_name || c.quantity != null))
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((c) => {
      const lbl = c.product_id ? labelById.get(c.product_id) : undefined;
      return {
        product_name: c.product?.product_name || 'Product',
        rate_per_acre: c.rate_per_acre,
        rate_unit: c.rate_unit,
        unit: c.unit,
        total_quantity: c.quantity,
        product_form: lbl?.product_form ?? null,
        // Prefer the per-job_chemicals override; else the product label.
        rei_hours: c.rei_hours ?? lbl?.rei_hours ?? null,
        phi_days: c.phi_days ?? lbl?.phi_days ?? null,
        epa_registration: lbl?.epa_registration ?? null,
      };
    });

  return buildApplicatorSheetData({
    job_number: r.job_number,
    customers: billedCustomers,
    scheduled_date: r.job_date,
    scheduled_time: r.scheduled_time,
    applicator_name: applicatorName,
    vehicle_name: null, // not shown on the chemical report
    fields,
    products,
    loader_comment: null,
  });
}
