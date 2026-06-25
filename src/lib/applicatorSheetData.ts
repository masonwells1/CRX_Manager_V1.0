/**
 * applicatorSheetData — the SHARED, pure data model for the three applicator
 * field-sheet formats (Original / Custom / Enhanced) — field-app parity #9.
 *
 * One gatherer assembles job + customers + fields (IN ROUTE ORDER) + chemicals +
 * applicator/vehicle/compliance into a single `ApplicatorSheetData`, so all three
 * PDF layouts read IDENTICAL source numbers (acceptance criterion: every figure
 * matches the job's saved data exactly, and the formats never disagree).
 *
 * This module is React- and jsPDF-free so the route-ordering, per-product totals,
 * gallon/lb conversion, and Custom-config parsing are unit-tested in isolation.
 * The PDF layouts live in applicatorSheetPdf.ts; JobDetail does the DB fetch and
 * hands raw rows to `buildApplicatorSheetData` here.
 *
 * ROUTE ORDER (load-bearing, LEDGER #5): job_fields.sort_order is the SINGLE
 * authoritative applicator drive order (0..n). Fields are sorted by it here and
 * numbered "Stop N" = sort_order + 1. Callers MUST NOT rely on PostgREST embed
 * order — `buildApplicatorSheetData` re-sorts defensively.
 */
import { toGallonOrLbEquivalent } from './chemCalculator';

// ── Custom-format layout config (mirrors the app_settings 'applicator_sheet_custom' key) ──

/** Which OPTIONAL columns the Custom sheet shows. Layout only — never pricing. */
export interface ApplicatorSheetColumns {
  crop: boolean;
  pest: boolean;
  rei: boolean;
  phi: boolean;
  total_applied: boolean;
  gl_lb: boolean;
}

/** The Custom applicator-sheet layout config (header/logo/footer + column toggles). */
export interface ApplicatorSheetCustomConfig {
  /** Blank => fall back to the standard CRX company name. */
  company_name: string;
  /** Blank => fall back to the standard CRX letterhead location. */
  company_address: string;
  /** Optional footer line under the standard footer rule. */
  footer_text: string;
  /** A data: URL for the header logo. Blank => no logo (standard header band). */
  logo_data_url: string;
  columns: ApplicatorSheetColumns;
}

/** All optional columns ON — the sensible default when nothing is configured. */
export const DEFAULT_SHEET_COLUMNS: ApplicatorSheetColumns = {
  crop: true,
  pest: true,
  rei: true,
  phi: true,
  total_applied: true,
  gl_lb: true,
};

/** The inert default Custom config (everything blank, all columns on). */
export const DEFAULT_CUSTOM_CONFIG: ApplicatorSheetCustomConfig = {
  company_name: '',
  company_address: '',
  footer_text: '',
  logo_data_url: '',
  columns: { ...DEFAULT_SHEET_COLUMNS },
};

/**
 * Parse the raw app_settings.setting_value string for 'applicator_sheet_custom'
 * into a fully-specified config. Blank / malformed / partial input falls back to
 * the inert default WITHOUT throwing (acceptance criterion: "when no custom config
 * is set it falls back to a sensible default without erroring"). Unknown keys are
 * ignored; only the known layout fields are read.
 */
export function parseCustomConfig(raw: string | null | undefined): ApplicatorSheetCustomConfig {
  if (!raw || typeof raw !== 'string' || raw.trim() === '') return { ...DEFAULT_CUSTOM_CONFIG, columns: { ...DEFAULT_SHEET_COLUMNS } };
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_CUSTOM_CONFIG, columns: { ...DEFAULT_SHEET_COLUMNS } };
  }
  if (!obj || typeof obj !== 'object') return { ...DEFAULT_CUSTOM_CONFIG, columns: { ...DEFAULT_SHEET_COLUMNS } };
  const o = obj as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const rawCols = (o.columns && typeof o.columns === 'object') ? (o.columns as Record<string, unknown>) : {};
  // A column toggle defaults to TRUE unless explicitly set to false (so an older
  // config missing a newer column still shows it).
  const bool = (v: unknown): boolean => v !== false;
  return {
    company_name: str(o.company_name),
    company_address: str(o.company_address),
    footer_text: str(o.footer_text),
    logo_data_url: str(o.logo_data_url),
    columns: {
      crop: bool(rawCols.crop),
      pest: bool(rawCols.pest),
      rei: bool(rawCols.rei),
      phi: bool(rawCols.phi),
      total_applied: bool(rawCols.total_applied),
      gl_lb: bool(rawCols.gl_lb),
    },
  };
}

/** Serialize a Custom config back to the app_settings JSON string. */
export function serializeCustomConfig(cfg: ApplicatorSheetCustomConfig): string {
  return JSON.stringify({
    company_name: cfg.company_name.trim(),
    company_address: cfg.company_address.trim(),
    footer_text: cfg.footer_text.trim(),
    logo_data_url: cfg.logo_data_url.trim(),
    columns: { ...cfg.columns },
  });
}

// ── The shared sheet data model ──────────────────────────────────────────────

/** One field/location on the sheet, already placed in route order. */
export interface ApplicatorSheetField {
  /** 1-based stop number = sort_order + 1. */
  stop: number;
  field_name: string;
  county: string | null;
  state: string | null;
  acres: number;
  crop: string | null;
  pest: string | null;
}

/** One product line, with the per-product total + gallon/lb conversion. */
export interface ApplicatorSheetProduct {
  product_name: string;
  rate_per_acre: number | null;
  rate_unit: string | null;
  /** Total applied across the whole job = rate × total acres (or a hand-entered total). */
  total_applied: number | null;
  /**
   * Measure unit of total_applied (e.g. "GAL" / "LB") — labels the Total Applied
   * magnitude and drives the gallon/lb conversion. This is the job's `unit`, NOT
   * the per-acre `rate_unit` (mirrors the in-page preview + loader worksheet).
   */
  total_unit: string | null;
  /** "12.5 gal" / "40 lb" gallon-or-pound equivalent of total_applied; null if not convertible. */
  total_gl_lb: string | null;
  rei_hours: number | null;
  phi_days: number | null;
  epa_registration: string | null;
}

/** A billed customer with their account ID. */
export interface ApplicatorSheetCustomer {
  customer_name: string;
  account_number: string | null;
}

/** The full, format-agnostic sheet payload. All three layouts read this. */
export interface ApplicatorSheetData {
  job_number: string;
  customers: ApplicatorSheetCustomer[];
  scheduled_date: string; // YYYY-MM-DD
  scheduled_time: string | null;
  applicator_name: string | null;
  vehicle_name: string | null;
  fields: ApplicatorSheetField[];
  products: ApplicatorSheetProduct[];
  total_acres: number;
  /** Free-text loader comment shown on the sheet (NOT internal_memo). */
  loader_comment: string | null;
}

// ── Raw input shapes (what JobDetail hands in) ───────────────────────────────

export interface RawSheetField {
  field_id: string;
  field_name: string;
  county: string | null;
  state: string | null;
  acres: number;
  crop: string | null;
  pest: string | null;
  sort_order: number;
}

export interface RawSheetProduct {
  product_name: string;
  rate_per_acre: number | null;
  /** Per-acre RATE unit (e.g. "pt/ac") — labels the Rate/Acre column ONLY. */
  rate_unit: string | null;
  /**
   * Measure unit of the Total Applied quantity (e.g. "GAL" / "LB"). This — NOT
   * rate_unit — labels the Total Applied magnitude and drives the gal/lb
   * conversion, matching the in-page preview + loader worksheet (JobDetail).
   */
  unit: string | null;
  /** Optional hand-entered total; when null we derive rate × total acres. */
  total_quantity: number | null;
  /** 'liquid' | 'dry' so the gal/lb conversion matches the server convert_to_gl_lb. */
  product_form: 'liquid' | 'dry' | null;
  rei_hours: number | null;
  phi_days: number | null;
  epa_registration: string | null;
}

export interface BuildSheetInput {
  job_number: string;
  customers: ApplicatorSheetCustomer[];
  scheduled_date: string;
  scheduled_time: string | null;
  applicator_name: string | null;
  vehicle_name: string | null;
  fields: RawSheetField[];
  products: RawSheetProduct[];
  loader_comment: string | null;
}

/**
 * Format a number for display: drop trailing zeros, keep up to 4 dp, thousands
 * separators. Returns '' for null/NaN.
 */
export function fmtNum(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '';
  return (Math.round(n * 10000) / 10000).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

/**
 * Assemble the shared sheet data from raw rows. Fields are sorted by sort_order
 * (route order) and numbered as stops; per-product totals are derived (rate ×
 * total acres) when no hand-entered total is supplied, then converted to the
 * gallon/lb equivalent. Pure + tested.
 */
export function buildApplicatorSheetData(input: BuildSheetInput): ApplicatorSheetData {
  // Route order is authoritative — sort defensively (PostgREST embed order is
  // not guaranteed). Re-number stops 1..n after sorting.
  const orderedFields = [...input.fields].sort((a, b) => a.sort_order - b.sort_order);
  const fields: ApplicatorSheetField[] = orderedFields.map((f, i) => ({
    stop: i + 1,
    field_name: f.field_name,
    county: f.county,
    state: f.state,
    acres: f.acres,
    crop: f.crop,
    pest: f.pest,
  }));

  const totalAcres = fields.reduce((s, f) => s + (Number.isFinite(f.acres) ? f.acres : 0), 0);

  const products: ApplicatorSheetProduct[] = input.products.map((p) => {
    // Total applied = the saved total quantity (job_chemicals.quantity) if present, else
    // rate × total acres. NOTE: in a saved job `quantity` IS the total — the 3-way
    // calculator (chemCalculator) keeps it = rate × acres or back-solves the rate — so
    // this normally takes the first branch and equals what the preview/loader read.
    const total = p.total_quantity != null && Number.isFinite(p.total_quantity)
      ? p.total_quantity
      : (p.rate_per_acre != null && Number.isFinite(p.rate_per_acre) ? p.rate_per_acre * totalAcres : null);
    // The Total Applied quantity is measured in p.unit (the job_chemicals.unit, e.g.
    // GAL/LB) — that is what labels the total AND drives the gal/lb conversion, NOT the
    // per-acre p.rate_unit. This MIRRORS the in-page preview (toGallonOrLbEquivalent(
    // quantity, c.unit)) and the loader worksheet, so all three operational surfaces
    // agree. (The rate/acre column keeps rate_unit — that's correct for the per-acre rate.)
    //
    // Fallback: only when a row has NO unit (legacy/blank job_chemicals.unit) do we fall
    // back to rate_unit, preserving the pre-fix output (e.g. 240 pt -> 30 gal) for those
    // rows rather than printing a dash. When unit IS set, unit always wins (the fix).
    const totalUnit = (p.unit != null && p.unit !== '') ? p.unit : p.rate_unit;
    const conv = total != null ? toGallonOrLbEquivalent(total, totalUnit, p.product_form) : null;
    return {
      product_name: p.product_name,
      rate_per_acre: p.rate_per_acre,
      rate_unit: p.rate_unit,
      total_applied: total != null ? Math.round(total * 10000) / 10000 : null,
      total_unit: totalUnit,
      total_gl_lb: conv ? `${fmtNum(conv.value)} ${conv.unit}` : null,
      rei_hours: p.rei_hours,
      phi_days: p.phi_days,
      epa_registration: p.epa_registration,
    };
  });

  return {
    job_number: input.job_number,
    customers: input.customers,
    scheduled_date: input.scheduled_date,
    scheduled_time: input.scheduled_time,
    applicator_name: input.applicator_name,
    vehicle_name: input.vehicle_name,
    fields,
    products,
    total_acres: Math.round(totalAcres * 10000) / 10000,
    loader_comment: input.loader_comment,
  };
}

/** The three named sheet formats. */
export type ApplicatorSheetFormat = 'original' | 'custom' | 'enhanced';

export const SHEET_FORMAT_LABELS: Record<ApplicatorSheetFormat, string> = {
  original: 'Original Applicator Report',
  custom: 'Custom Applicator Report',
  enhanced: 'Enhanced Applicator Report',
};
