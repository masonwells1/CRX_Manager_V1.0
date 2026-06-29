/**
 * projectedUseReportData — the CROSS-JOB PROJECTED chemical-usage aggregator for the
 * Projected Use Report (field-app parity #13).
 *
 * ChemMan's "Projected Use Report" (under the job-list MORE REPORT OPTIONS) forecasts
 * how much of each chemical the office will STILL need for the upcoming/in-flight
 * jobs, so product can be ordered ahead and you don't run out mid-season. Unlike the
 * Chemical Summary Report (#12), which sums what was ALREADY applied, this is a
 * FORECAST of what is NOT yet applied.
 *
 * THE PROJECTION RULE (load-bearing — read carefully):
 *   projected_qty(product) = Σ over in-scope, NOT-FULLY-APPLIED jobs of
 *                              [ planned rate-per-acre × the job's NOT-YET-APPLIED acres ]
 *
 *   • The per-job gatherer (#11 `buildApplicatorSheetData`) already computes, per
 *     product, `total_applied` = planned rate × the job's FULL FIELD acres (= Σ
 *     job_fields.acres_to_treat, exposed as `data.total_acres`). To turn that into the
 *     NOT-YET-APPLIED forecast we SCALE it by the job's remaining-acres FACTOR whose
 *     denominator MUST be that SAME field-acre total so it cancels exactly:
 *         factor = remaining_acres / field_acre_total
 *         projected_for_job = total_applied × factor
 *                           = (rate × field_acre_total) × (remaining / field_acre_total)
 *                           = rate × remaining_acres            ✓ (the rule above)
 *     The field-acre total is the gatherer's `data.total_acres` (Σ acres_to_treat) — the
 *     AUTHORITATIVE acre basis the per-product `total_applied` was computed over. It is
 *     NOT `jobs.total_acres`, which can DIVERGE (legacy/imported/quote/blend jobs) and
 *     would make the factor's denominator not match the quantity's acre basis (the MED
 *     defect: jobs.total_acres=80 but field acres=100, qty=200 @ remaining=60 → using 80
 *     gives 150 pt; using the field-acre 100 gives the true 120 pt).
 *     For a pure `scheduled` job nothing is applied so remaining == field total → factor
 *     1 → projected == planned (full scheduled acres). For an `in_progress` job partly
 *     done (e.g. 100 field ac, 40 applied → 60 remaining) the factor is 0.6 and the
 *     projection is the UN-sprayed 60-acre portion — exactly the forecast the office buys.
 *   • The caller (`projectedUseReportFetch`) is responsible for restricting the input to
 *     IN-SCOPE jobs (status scheduled/in_progress AND a positive acre basis with
 *     remaining > 0) and for supplying each job's honest remaining_acres
 *     (= field_acre_total − applied_acres) so this pure module can compute the factor.
 *     The denominator is read here straight from `data.total_acres` (the field-acre
 *     total), NOT from a separate caller-supplied total — one authoritative basis.
 *     Already-applied/completed/invoiced/cancelled/zero-remaining/no-basis jobs are
 *     EXCLUDED upstream and listed here — NEVER folded into the projection (criterion 4:
 *     distinguish projected from already-applied; never double-count a sprayed quantity).
 *
 * AGGREGATION (kept IDENTICAL to #12 so the two documents never disagree):
 *   • Sum each product's projected quantity keyed by PRODUCT NAME + measure UNIT. A
 *     product measured in two different units across jobs stays on separate lines.
 *   • The gallon/lb-equivalent of the AGGREGATE is RE-DERIVED from the SUMMED projected
 *     quantity via `toGallonOrLbEquivalent(sum, unit, product_form)` — NOT by adding
 *     per-job gal/lb display strings.
 *   • A product line whose contributing rows DISAGREE on product_form (incl. null-vs-
 *     known) is flagged and its gal/lb omitted (—) rather than guessed — the exact #12
 *     form-conflict guard, treating `null` as a distinct value.
 *
 * NEVER SILENTLY UNDERCOUNT: the caller records INCLUDED and EXCLUDED job lists so the
 * report (and a toast) state exactly which jobs the projection covers. An excluded job
 * is never folded into the totals.
 *
 * React- and jsPDF-free so the projection math is unit-tested in isolation; the PDF
 * layout lives in projectedUseReportPdf.ts.
 */
import type { ApplicatorSheetData } from './applicatorSheetData';
import { fmtNum } from './applicatorSheetData';
import { toGallonOrLbEquivalent } from './chemCalculator';

/** One aggregated PROJECTED product line: a product+unit forecast summed across in-scope jobs. */
export interface ProjectedUseRow {
  product_name: string;
  /** The measure unit this projected total is expressed in (e.g. "pt", "gal", "lb"). */
  unit: string;
  /** Summed PROJECTED quantity across all included jobs for this product+unit (rounded 4dp). */
  projected_quantity: number;
  /** Display of the projected quantity with its unit, e.g. "300 pt". */
  projected_quantity_display: string;
  /**
   * Gallon/lb-equivalent of the SUMMED projected quantity, e.g. "37.5 gal" / "120 lb";
   * "—" when not convertible (unknown/blank unit, or a conflicting product_form across jobs).
   */
  gl_lb_display: string;
  /** How many of the included jobs contributed to this product+unit projection. */
  job_count: number;
}

/** A job INCLUDED in the projection, with the acres basis that drove its forecast. */
export interface ProjectedUseJobRef {
  job_id: string;
  /** Job number when known; the id is the fallback identity for an unfetched job. */
  job_number: string | null;
  /** Primary/billed customer label for the included-jobs list (best-effort; may be ''). */
  customer_label: string;
  /** Job status (scheduled / in_progress) — shown so the basis is transparent. */
  status: string;
  /** Acres NOT yet applied that the projection used for this job (the forecast acres). */
  remaining_acres: number;
  /** The job's full FIELD acres (Σ acres_to_treat — the projection basis) — remaining vs total at a glance. */
  total_acres: number;
}

/** A selected job that was NOT included in the projection, with a plain-English reason. */
export interface ProjectedUseExcludedJob {
  job_id: string;
  job_number: string | null;
  reason: string;
}

/** One in-scope job handed to the aggregator: its sheet data + its acres basis. */
export interface ProjectedUseJobInput {
  job_id: string;
  data: ApplicatorSheetData;
  /**
   * Acres NOT yet applied — the forecast acres for this job. The caller computes this
   * HONESTLY as `acre_basis − applied_acres` (NOT jobs.remaining_acres, which is a
   * generated column off jobs.total_acres and reads 0 when total_acres is NULL).
   */
  remaining_acres: number;
  /**
   * The acre BASIS the projection scales against (the scale-factor denominator) — the SAME
   * basis the caller used to derive remaining_acres. Normally the gatherer's field-acre
   * total (data.total_acres = Σ acres_to_treat); the caller falls back to jobs.total_acres
   * ONLY when the job has no field acres. The aggregator uses THIS, not a re-derived
   * data.total_acres, so the fetch's basis decision is honored end-to-end (a no-field
   * fallback job is NOT silently zeroed out). Must equal data.total_acres for a normal job.
   */
  acre_basis: number;
  /** Job status (scheduled / in_progress) for the included-jobs basis display. */
  status: string;
}

/** The full cross-job projection payload the PDF/CSV render. */
export interface ProjectedUseReportData {
  /** Aggregated projected product lines, sorted by product name then unit. */
  rows: ProjectedUseRow[];
  /** The jobs whose NOT-YET-APPLIED chemicals ARE projected into `rows`. */
  included_jobs: ProjectedUseJobRef[];
  /** Selected jobs that were NOT included (already-applied / unresolved) — NOT in the totals. */
  excluded_jobs: ProjectedUseExcludedJob[];
  /** Grand total = number of distinct product+unit lines. */
  distinct_product_lines: number;
  /** Total NOT-YET-APPLIED acres across the included jobs (the acres the projection covers). */
  projected_acres: number;
  /** Earliest job_date across the included jobs (YYYY-MM-DD), or null when none. */
  date_from: string | null;
  /** Latest job_date across the included jobs (YYYY-MM-DD), or null when none. */
  date_to: string | null;
}

/**
 * Build the cross-job PROJECTED chemical usage from the in-scope jobs (already filtered
 * + acres-annotated by the caller) plus the excluded jobs (so the caller never has to
 * drop a selected job silently). Each job's products are scaled to their NOT-YET-APPLIED
 * portion (remaining/total) before summing. Pure + tested.
 *
 * @param jobs     in-scope jobs (each with its shared ApplicatorSheetData + acres basis)
 * @param excluded selected jobs that were not included (already-applied / unresolved)
 */
export function buildProjectedUseReportData(
  jobs: ProjectedUseJobInput[],
  excluded: ProjectedUseExcludedJob[] = [],
): ProjectedUseReportData {
  // Accumulator keyed by product name + unit (a different unit is a different line) —
  // identical shape/semantics to the #12 Chemical Summary so the two never disagree.
  interface Acc {
    product_name: string;
    unit: string;
    total: number;
    job_ids: Set<string>;
    /** product_form of the FIRST contributing row; `null` is a REAL value (a no-form row). */
    form: 'liquid' | 'dry' | null;
    /** True once any later row carries a DIFFERENT form (null counts as distinct) → gal/lb '—'. */
    form_conflict: boolean;
  }
  const acc = new Map<string, Acc>();

  const included_jobs: ProjectedUseJobRef[] = [];
  let projected_acres = 0;
  let date_from: string | null = null;
  let date_to: string | null = null;

  for (const { job_id, data, remaining_acres, acre_basis, status } of jobs) {
    // The scale factor turns the gatherer's "planned rate × FULL acres" into "planned rate
    // × NOT-YET-APPLIED acres". The denominator is the caller-supplied `acre_basis` — the
    // SAME basis the caller derived remaining_acres from, and the SAME acre count the
    // per-product `total_applied` was computed over (normally data.total_acres = Σ
    // acres_to_treat; a no-field fallback job carries jobs.total_acres). Using the caller's
    // basis (not a re-derived data.total_acres) keeps the decision in ONE place — so a
    // divergent jobs.total_acres can't mis-scale (the MED defect) AND a no-field fallback
    // job isn't silently zeroed (the Codex P2 follow-up). Guard: no positive basis → no
    // derivable per-acre rate, so it contributes 0 (excluded upstream, but never ÷0).
    const basis = Number.isFinite(acre_basis) && acre_basis > 0 ? acre_basis : 0;
    const remaining = Number.isFinite(remaining_acres) && remaining_acres > 0 ? remaining_acres : 0;
    const factor = basis > 0 ? remaining / basis : 0;

    projected_acres = round4(projected_acres + remaining);
    included_jobs.push({
      job_id,
      job_number: data.job_number,
      customer_label: data.customers.length > 0
        ? data.customers.map((c) => c.customer_name).join(', ')
        : '',
      status,
      remaining_acres: remaining,
      total_acres: basis,
    });

    // Track the date range the projection is based on (criterion 3).
    const d = data.scheduled_date;
    if (d) {
      if (date_from === null || d < date_from) date_from = d;
      if (date_to === null || d > date_to) date_to = d;
    }

    for (const p of data.products) {
      // Nothing to project from a quantity-less line (the gatherer's product SET is
      // verbatim — no extra filter — but a null planned total has nothing to scale).
      if (p.total_applied == null || !Number.isFinite(p.total_applied)) continue;
      // PROJECT: scale the planned (full-acres) total down to the not-yet-applied
      // portion. This equals planned rate × remaining_acres (see the module header).
      const projected = round4(p.total_applied * factor);
      if (projected === 0) continue; // factor 0 (no remaining) adds nothing
      const unit = (p.total_unit ?? '').trim();
      const key = `${p.product_name}\u0000${unit.toLowerCase()}`;
      const existing = acc.get(key);
      if (existing) {
        existing.total = round4(existing.total + projected);
        existing.job_ids.add(job_id);
        // Flag a product_form conflict (null treated as distinct) so gal/lb renders '—'
        // rather than guessing a gallon-vs-lb branch — the exact #12 guard.
        if (existing.form !== p.product_form) existing.form_conflict = true;
      } else {
        acc.set(key, {
          product_name: p.product_name,
          unit,
          total: projected,
          job_ids: new Set([job_id]),
          form: p.product_form,
          form_conflict: false,
        });
      }
    }
  }

  const rows: ProjectedUseRow[] = [...acc.values()]
    .map((a) => {
      // RE-DERIVE the gal/lb equivalent from the SUMMED PROJECTED quantity (not by adding
      // display strings). Omit it on a product_form conflict — never guess a wrong branch.
      const conv = a.form_conflict ? null : toGallonOrLbEquivalent(a.total, a.unit, a.form);
      return {
        product_name: a.product_name,
        unit: a.unit,
        projected_quantity: a.total,
        projected_quantity_display: `${fmtNum(a.total)} ${a.unit}`.trim(),
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
    projected_acres,
    date_from,
    date_to,
  };
}

/** 4-dp rounding — matches the server/gatherer ROUND(..., 4) so sums stay exact. */
function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

/** A flat CSV row for the per-product projected-use export. */
export interface ProjectedUseCsvRow extends Record<string, unknown> {
  product_name: string;
  unit: string;
  projected_quantity: string;
  gl_lb_equiv: string;
  job_count: number;
}

/**
 * Flatten the aggregated projected rows into CSV-ready records (criterion 5: CSV too).
 * One row per product+unit projected line.
 *
 * NEVER a SILENTLY-PARTIAL forecast (Codex P2): when any selected job was EXCLUDED, the
 * CSV — which can be carried off on its own to drive product ordering — would otherwise
 * give no hint that jobs were dropped, risking UNDER-ordering. So we append a clearly-
 * labelled "EXCLUDED (not projected)" marker block listing each excluded job + reason in
 * the SAME columns (product_name = the marker, unit = the job #, gl_lb_equiv = the
 * reason). The standalone CSV then carries the same honesty as the PDF/toast.
 */
export function projectedUseCsvRows(data: ProjectedUseReportData): ProjectedUseCsvRow[] {
  const rows: ProjectedUseCsvRow[] = data.rows.map((r) => ({
    product_name: r.product_name,
    unit: r.unit,
    projected_quantity: fmtNum(r.projected_quantity),
    gl_lb_equiv: r.gl_lb_display,
    job_count: r.job_count,
  }));

  if (data.excluded_jobs.length > 0) {
    // A header marker so the excluded block is unmistakable in the flat CSV.
    rows.push({
      product_name: `EXCLUDED — NOT projected (${data.excluded_jobs.length} job(s); product NOT counted above)`,
      unit: '',
      projected_quantity: '',
      gl_lb_equiv: '',
      job_count: 0,
    });
    for (const j of data.excluded_jobs) {
      rows.push({
        product_name: 'EXCLUDED job',
        unit: j.job_number || j.job_id,
        projected_quantity: '',
        gl_lb_equiv: j.reason,
        job_count: 0,
      });
    }
  }

  return rows;
}
