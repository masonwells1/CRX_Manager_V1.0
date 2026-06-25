/**
 * chemicalApplicationReportData — the chemical-centric report row model for the
 * per-job Chemical Application Report (field-app parity #11).
 *
 * This is the official record of exactly what chemical went on a field — the
 * document handed to a customer or regulator. Unlike the crew-centric applicator
 * field sheet (#9), this report leads with the CHEMICAL: one row per product with
 * its rate/acre + unit, total applied + gallon/lb-equivalent, the field(s)/acres
 * it covered, and the per-product compliance details (REI, PHI, EPA registration).
 *
 * The numbers MUST match the applicator field sheet exactly, so this module is a
 * thin pure mapper over the SHARED `ApplicatorSheetData` produced by
 * `buildApplicatorSheetData` (applicatorSheetData.ts). It does NOT re-query or
 * re-compute totals/conversions — it reads what the gatherer already computed
 * (the #25 product_form-aware gal/lb fix lives there), so the Chemical Application
 * Report and the Applicator Sheet can never disagree for the same job.
 *
 * React- and jsPDF-free so the row mapping is unit-tested in isolation; the PDF
 * layout lives in chemicalApplicationReportPdf.ts.
 */
import type { ApplicatorSheetData, ApplicatorSheetField } from './applicatorSheetData';
import { fmtNum } from './applicatorSheetData';

/** One chemical line on the report — everything the regulator/customer needs per product. */
export interface ChemicalApplicationReportRow {
  product_name: string;
  /** EPA product registration number; null/blank when the product carries none (does NOT block the report). */
  epa_registration: string | null;
  /** Display rate per acre, e.g. "2 pt/ac"; "—" when no rate is set. */
  rate_per_acre_display: string;
  /** Display total applied with its measure unit, e.g. "240 pt"; "—" when not derivable. */
  total_applied_display: string;
  /** Gallon/lb-equivalent of the total, e.g. "30 gal" / "40 lb"; "—" when not convertible. */
  gl_lb_display: string;
  /** Re-entry interval, e.g. "12 hr"; "—" when unknown. */
  rei_display: string;
  /** Pre-harvest interval, e.g. "30 d"; "—" when unknown. */
  phi_display: string;
}

/** A field/location the job covered (already in route order from the gatherer). */
export interface ChemicalApplicationReportField {
  field_name: string;
  county: string | null;
  state: string | null;
  acres: number;
  crop: string | null;
  pest: string | null;
}

/** The full, chemical-centric report payload. */
export interface ChemicalApplicationReportData {
  job_number: string;
  customers: ApplicatorSheetData['customers'];
  application_date: string; // YYYY-MM-DD
  scheduled_time: string | null;
  applicator_name: string | null;
  total_acres: number;
  /** Distinct crop(s) across the job's fields, comma-joined; "" when none recorded. */
  crops_summary: string;
  /** Distinct pest(s) across the job's fields, comma-joined; "" when none recorded. */
  pests_summary: string;
  fields: ChemicalApplicationReportField[];
  chemicals: ChemicalApplicationReportRow[];
}

/**
 * Format a per-acre rate as "<n> <unit>/ac". The job_chemicals.rate_unit column is
 * inconsistent in real data — some rows store a bare unit ("pt"), others already
 * encode the per-acre suffix ("pt/ac", "oz/ac"). Only append "/ac" when the unit
 * doesn't already carry a per-acre suffix, so the customer-facing report never
 * prints "2 pt/ac/ac" (Codex P2).
 */
export function formatRatePerAcre(rate: number, unit: string | null): string {
  const u = (unit || '').trim();
  if (u === '') return `${fmtNum(rate)}/ac`;
  // Already ends in /ac or /acre (case-insensitive) → don't double-suffix.
  if (/\/\s*ac(re)?$/i.test(u)) return `${fmtNum(rate)} ${u}`.trim();
  return `${fmtNum(rate)} ${u}/ac`.trim();
}

/** Join the distinct non-blank values of a field accessor, preserving first-seen order. */
function distinctJoin(fields: ApplicatorSheetField[], pick: (f: ApplicatorSheetField) => string | null): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of fields) {
    const v = (pick(f) || '').trim();
    if (v === '' || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out.join(', ');
}

/**
 * Map the shared applicator-sheet data into the chemical-centric report model.
 * Pure: it only re-shapes what `buildApplicatorSheetData` already computed (totals,
 * gal/lb conversion, REI/PHI/EPA), so every figure equals the applicator sheet's.
 *
 * The product SET is exactly the gatherer's `products` (a resolved product with a
 * positive quantity, per the shared #9 filter) — so the report lists the SAME
 * chemical lines the applicator sheet would for this job, never a looser/different
 * set (the #10 consistency pitfall).
 */
export function buildChemicalApplicationReportData(data: ApplicatorSheetData): ChemicalApplicationReportData {
  const chemicals: ChemicalApplicationReportRow[] = data.products.map((p) => {
    const rate = p.rate_per_acre != null
      ? formatRatePerAcre(p.rate_per_acre, p.rate_unit)
      : '—';
    const total = p.total_applied != null
      ? `${fmtNum(p.total_applied)} ${p.total_unit || ''}`.trim()
      : '—';
    return {
      product_name: p.product_name,
      // EPA reg renders blank (—) when absent — criterion 4: never block/hide the report.
      epa_registration: (p.epa_registration && p.epa_registration.trim() !== '') ? p.epa_registration.trim() : null,
      rate_per_acre_display: rate,
      total_applied_display: total,
      gl_lb_display: p.total_gl_lb || '—',
      rei_display: p.rei_hours != null ? `${p.rei_hours} hr` : '—',
      phi_display: p.phi_days != null ? `${p.phi_days} d` : '—',
    };
  });

  return {
    job_number: data.job_number,
    customers: data.customers,
    application_date: data.scheduled_date,
    scheduled_time: data.scheduled_time,
    applicator_name: data.applicator_name,
    total_acres: data.total_acres,
    crops_summary: distinctJoin(data.fields, (f) => f.crop),
    pests_summary: distinctJoin(data.fields, (f) => f.pest),
    fields: data.fields.map((f) => ({
      field_name: f.field_name,
      county: f.county,
      state: f.state,
      acres: f.acres,
      crop: f.crop,
      pest: f.pest,
    })),
    chemicals,
  };
}
