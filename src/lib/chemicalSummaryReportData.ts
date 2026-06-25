/**
 * chemicalSummaryReportData — the CROSS-JOB chemical usage aggregator for the
 * Chemical Summary Report (field-app parity #12).
 *
 * ChemMan's "Chemical Summary Report" runs across the checkbox-SELECTED jobs and
 * answers ONE question for the office: how much of each chemical did we put out in
 * total across this batch of jobs, without opening each job? This module is the
 * pure aggregation behind that report.
 *
 * It takes the SAME per-job `ApplicatorSheetData` the per-job Chemical Application
 * Report (#11) and Applicator Sheet (#9) read — built by the shared
 * `buildApplicatorSheetData` gatherer — so a single selected job's figures here are
 * byte-identical to that job's own report (criterion 4: select one job → that job's
 * totals). Across many jobs it SUMS them.
 *
 * AGGREGATION RULE (load-bearing):
 *   • Sum each product's `total_applied` keyed by PRODUCT NAME + measure UNIT. A
 *     product measured in two different units across jobs (e.g. some jobs in "pt",
 *     others in "gal") must NOT be summed across units — they stay separate lines,
 *     each labelled with its own unit. (Same product+unit on two jobs DOES sum.)
 *   • The gallon/lb-equivalent of the AGGREGATE is RE-DERIVED from the SUMMED
 *     quantity via `toGallonOrLbEquivalent(summedQty, unit, product_form)` — NOT by
 *     adding the per-job gal/lb display strings (which would lose precision and
 *     can't be re-summed as text). product_form drives gal-vs-lb to match the server
 *     convert_to_gl_lb (the #25 fix), carried through ApplicatorSheetProduct.
 *   • A product line whose contributing rows DISAGREE on product_form (a data
 *     anomaly — `products` has no unique-name constraint, so same-name rows can hold
 *     divergent forms, including one row `liquid` and another `null`) is flagged and
 *     its gal/lb is omitted (—) rather than guessed. `null` is treated as a DISTINCT
 *     form value here, so null-vs-'liquid' IS a conflict; all-null (or all-'liquid')
 *     is NOT — that line converts exactly as each job's own #11 report would.
 *
 * NEVER SILENTLY UNDERCOUNT: a summary's whole value is a correct total. The CALLER
 * fetches each job and reports per job whether it resolved; this module records the
 * INCLUDED and EXCLUDED job lists so the report and a toast can state exactly which
 * jobs the grand total covers. An excluded job is never folded into the totals.
 *
 * React- and jsPDF-free so the aggregation is unit-tested in isolation; the PDF
 * layout lives in chemicalSummaryReportPdf.ts.
 */
import type { ApplicatorSheetData } from './applicatorSheetData';
import { fmtNum } from './applicatorSheetData';
import { toGallonOrLbEquivalent } from './chemCalculator';

/** One aggregated product line: a product+unit total summed across the included jobs. */
export interface ChemicalSummaryRow {
  product_name: string;
  /** The measure unit this total is expressed in (e.g. "pt", "gal", "lb"). */
  unit: string;
  /** Summed applied quantity across all included jobs for this product+unit (rounded 4dp). */
  total_quantity: number;
  /** Display of the summed quantity with its unit, e.g. "440 pt". */
  total_quantity_display: string;
  /**
   * Gallon/lb-equivalent of the SUMMED quantity, e.g. "55 gal" / "120 lb"; "—" when
   * not convertible (unknown/blank unit, or a conflicting product_form across jobs).
   */
  gl_lb_display: string;
  /** How many of the included jobs contributed to this product+unit line. */
  job_count: number;
}

/** A job that was included in (or excluded from) the summary totals. */
export interface ChemicalSummaryJobRef {
  job_id: string;
  /** Job number when known; the id is the fallback identity for an unfetched job. */
  job_number: string | null;
  /** Primary/billed customer label for the included-jobs list (best-effort; may be ''). */
  customer_label: string;
}

/** A selected job that could NOT be included, with a plain-English reason. */
export interface ChemicalSummaryExcludedJob {
  job_id: string;
  job_number: string | null;
  reason: string;
}

/** The full cross-job summary payload the PDF/CSV render. */
export interface ChemicalSummaryReportData {
  /** Aggregated product lines, sorted by product name then unit. */
  rows: ChemicalSummaryRow[];
  /** The jobs whose chemicals ARE summed into `rows`. */
  included_jobs: ChemicalSummaryJobRef[];
  /** Selected jobs that could NOT be fetched/resolved — NOT in the totals (never silent). */
  excluded_jobs: ChemicalSummaryExcludedJob[];
  /** Grand total = number of distinct product+unit lines. */
  distinct_product_lines: number;
  /** Total acres across the included jobs (informational; acres don't sum to a "grand total"). */
  total_acres: number;
}

/** One successfully-fetched job handed to the aggregator. */
export interface ChemicalSummaryJobInput {
  job_id: string;
  data: ApplicatorSheetData;
}

/**
 * Build the cross-job chemical summary from the per-job gatherer data of the jobs
 * that fetched successfully, plus the list of jobs that were excluded (so the caller
 * never has to drop an unfetched job silently). Pure + tested.
 *
 * @param jobs     successfully-fetched jobs (each with its shared ApplicatorSheetData)
 * @param excluded selected jobs that could not be fetched/resolved (with a reason)
 */
export function buildChemicalSummaryReportData(
  jobs: ChemicalSummaryJobInput[],
  excluded: ChemicalSummaryExcludedJob[] = [],
): ChemicalSummaryReportData {
  // Accumulator keyed by product name + unit (a different unit is a different line).
  interface Acc {
    product_name: string;
    unit: string;
    total: number;
    job_ids: Set<string>;
    /**
     * The product_form of the FIRST contributing row for this product+unit. Held as
     * the line's canonical form. `null` is a REAL value here (a no-form row), NOT
     * "unset" — so null-vs-'liquid' is treated as a conflict (see form_conflict).
     */
    form: 'liquid' | 'dry' | null;
    /**
     * True once any later contributing row carries a DIFFERENT product_form than the
     * first one — treating `null` as distinct from a known form. So null-vs-'liquid'
     * IS a conflict, but all-null or all-'liquid' is NOT. When true, gal/lb is unsafe
     * to compute (we'd have to guess a branch) so it renders as '—'.
     */
    form_conflict: boolean;
  }
  const acc = new Map<string, Acc>();

  const included_jobs: ChemicalSummaryJobRef[] = [];
  let total_acres = 0;

  for (const { job_id, data } of jobs) {
    total_acres = round4(total_acres + (Number.isFinite(data.total_acres) ? data.total_acres : 0));
    included_jobs.push({
      job_id,
      job_number: data.job_number,
      customer_label: data.customers.length > 0
        ? data.customers.map((c) => c.customer_name).join(', ')
        : '',
    });

    for (const p of data.products) {
      // Skip a line we can't total: no quantity to sum (a bare/flat line). The product
      // SET is the gatherer's products verbatim (#9/#11 convention — no extra quantity
      // filter), but a null total simply has nothing to add to a usage SUM.
      if (p.total_applied == null || !Number.isFinite(p.total_applied)) continue;
      const unit = (p.total_unit ?? '').trim();
      // Key on name + a case-folded unit so "PT" and "pt" sum together, but keep the
      // first-seen original unit casing for display.
      const key = `${p.product_name} ${unit.toLowerCase()}`;
      const existing = acc.get(key);
      if (existing) {
        existing.total = round4(existing.total + p.total_applied);
        existing.job_ids.add(job_id);
        // Compare THIS row's form against the line's first-seen canonical form,
        // treating `null` as a distinct value (a no-form row is NOT the same as a
        // 'liquid' row). Any difference flags a conflict so gal/lb renders '—'
        // rather than guessing a gallon-vs-lb branch the divergent row never had.
        // We DON'T adopt the later form — the first row's form stays canonical for
        // the all-same case; on a conflict the form is irrelevant (we emit '—').
        if (existing.form !== p.product_form) existing.form_conflict = true;
      } else {
        acc.set(key, {
          product_name: p.product_name,
          unit,
          total: round4(p.total_applied),
          job_ids: new Set([job_id]),
          form: p.product_form,
          form_conflict: false,
        });
      }
    }
  }

  const rows: ChemicalSummaryRow[] = [...acc.values()]
    .map((a) => {
      // RE-DERIVE the gal/lb equivalent from the SUMMED quantity (not by adding display
      // strings). Omit it on a product_form conflict — never guess a wrong branch.
      const conv = a.form_conflict ? null : toGallonOrLbEquivalent(a.total, a.unit, a.form);
      return {
        product_name: a.product_name,
        unit: a.unit,
        total_quantity: a.total,
        total_quantity_display: `${fmtNum(a.total)} ${a.unit}`.trim(),
        gl_lb_display: conv ? `${fmtNum(conv.value)} ${conv.unit}` : '—',
        job_count: a.job_ids.size,
      };
    })
    .sort((x, y) =>
      x.product_name.localeCompare(y.product_name) || x.unit.localeCompare(y.unit),
    );

  return {
    rows,
    included_jobs,
    excluded_jobs: excluded,
    distinct_product_lines: rows.length,
    total_acres,
  };
}

/** 4-dp rounding — matches the server/gatherer ROUND(..., 4) so sums stay exact. */
function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

/** A flat CSV row for the per-product summary export. */
export interface ChemicalSummaryCsvRow extends Record<string, unknown> {
  product_name: string;
  unit: string;
  total_quantity: string;
  gl_lb_equiv: string;
  job_count: number;
}

/**
 * Flatten the aggregated rows into CSV-ready records (criterion 3: "ideally a CSV
 * export too"). One row per product+unit line; the included/excluded job accounting
 * is conveyed by the report header/toast, not the per-product CSV.
 */
export function chemicalSummaryCsvRows(data: ChemicalSummaryReportData): ChemicalSummaryCsvRow[] {
  return data.rows.map((r) => ({
    product_name: r.product_name,
    unit: r.unit,
    total_quantity: fmtNum(r.total_quantity),
    gl_lb_equiv: r.gl_lb_display,
    job_count: r.job_count,
  }));
}
