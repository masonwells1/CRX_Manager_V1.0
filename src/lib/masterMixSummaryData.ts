/**
 * masterMixSummaryData — the CROSS-JOB MASTER MIX aggregator for the Master Mix
 * Summary (field-app parity #14).
 *
 * ChemMan's "Master Mix Summary" (under the job-list MORE REPORT OPTIONS) answers a
 * loader's question for a BATCH of jobs: if I prepare the whole batch at once, how
 * much of EACH product do I need to mix in total, and how many tank loads does that
 * batch break into? It is the consolidated mix sheet so one big batch can be prepared
 * from a single document.
 *
 * TWO things this module combines across the selected jobs:
 *
 *   1) COMBINED PER-PRODUCT MIX (criterion 2) — the SUM, across all included jobs, of
 *      each product's full to-be-mixed quantity, keyed by PRODUCT NAME + measure UNIT.
 *      This is the SAME per-product total the Chemical Summary (#12) / Applicator Sheet
 *      (#9) show (the gatherer's `total_applied` = planned rate × the job's field-acre
 *      total). Master Mix prepares the WHOLE planned batch, so we sum the FULL planned
 *      quantities directly — NOT a remaining-only forecast like #13. The aggregation
 *      reuses #12's rules EXACTLY: a product measured in two different units stays on
 *      separate lines; the gal/lb-equivalent is RE-DERIVED from the SUMMED quantity via
 *      `toGallonOrLbEquivalent(sum, unit, form)`; a product line whose contributing rows
 *      DISAGREE on product_form (treating `null` as distinct from a known form) is
 *      flagged and its gal/lb omitted (—) rather than guessed.
 *
 *   2) PER-CAPACITY LOADS PICTURE (criterion 3 + 6 — the genuinely new wrinkle) — the
 *      loads count + per-load split for the batch, REUSING #10's pure
 *      `computeLoaderWorksheet`. Loads depend on the tank CAPACITY and the per-acre
 *      CARRIER rate, both of which are PER JOB. Combining loads across jobs with
 *      DIFFERENT tank capacities (or carrier rates) without lying is impossible — a
 *      1,000-gal sprayer and a 500-gal sprayer don't share a load plan. So instead of
 *      silently averaging capacities into one fake figure, we GROUP the jobs by their
 *      (capacity, carrier-rate) and compute ONE combined loads block per group, each
 *      block stating exactly which jobs it covers. Jobs that share a capacity+rate share
 *      a combined loads block (criterion 3); jobs with a different capacity get their own
 *      block (criterion 6). Jobs MISSING a capacity (or carrier rate) cannot produce a
 *      loads plan at all — their mix is still summed into the combined totals, but they
 *      are collected into a single "loads need a capacity" note group (mirroring #10's
 *      "enter capacity" guard), never folded into another group's load count.
 *
 * NEVER SILENTLY UNDERCOUNT: the caller records INCLUDED and EXCLUDED job lists so the
 * report (and a toast) state exactly which jobs the combined mix covers. An excluded job
 * is never folded into the totals.
 *
 * React- and jsPDF-free so the aggregation + grouping are unit-tested in isolation; the
 * PDF layout lives in masterMixSummaryPdf.ts.
 */
import type { ApplicatorSheetData } from './applicatorSheetData';
import { fmtNum } from './applicatorSheetData';
import { toGallonOrLbEquivalent } from './chemCalculator';
import {
  computeLoaderWorksheet,
  type LoaderProductInput,
  type LoaderWorksheet,
} from './loaderWorksheet';

/** One combined product line: a product+unit total summed across the included jobs. */
export interface MasterMixRow {
  product_name: string;
  /** The measure unit this total is expressed in (e.g. "pt", "gal", "lb"). */
  unit: string;
  /** Summed to-be-mixed quantity across all included jobs for this product+unit (rounded 4dp). */
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

/** A job whose loads share one tank capacity + carrier rate — one combined loads block. */
export interface MasterMixLoadGroup {
  /** Effective tank capacity (gallons) shared by every job in this group. */
  tank_capacity: number;
  /** Per-acre carrier rate (gal/ac) shared by every job in this group. */
  carrier_rate_gpa: number;
  /** A human label for the capacity source(s), e.g. "1,000 gal" plus the vehicle/override note. */
  capacity_label: string;
  /** The job numbers (or ids) this combined loads block covers — stated on the report. */
  job_numbers: string[];
  /** Combined field acres across the group's jobs (the loads basis). */
  total_acres: number;
  /** The computed combined loader worksheet for this group (loads + per-load split). */
  worksheet: LoaderWorksheet;
}

/** A job whose loads could NOT be planned (no capacity or no carrier rate) — mix still counted. */
export interface MasterMixNoLoadJob {
  job_id: string;
  job_number: string | null;
  /** Plain-English reason loads can't be planned (mirrors #10's guard messages). */
  reason: string;
}

/** A job that was included in (or excluded from) the combined mix. */
export interface MasterMixJobRef {
  job_id: string;
  job_number: string | null;
  /** Primary/billed customer label for the included-jobs list (best-effort; may be ''). */
  customer_label: string;
}

/** A selected job that could NOT be included, with a plain-English reason. */
export interface MasterMixExcludedJob {
  job_id: string;
  job_number: string | null;
  reason: string;
}

/** One successfully-fetched job handed to the aggregator: its mix + its loads inputs. */
export interface MasterMixJobInput {
  job_id: string;
  /** The shared per-job gatherer data — the SAME #11 data the Chemical Summary reads. */
  data: ApplicatorSheetData;
  /**
   * Effective tank capacity in GALLONS for this job (the per-job override, else the
   * vehicle's gallon capacity). NULL when no gallon capacity is known — the mix is still
   * summed but the job lands in the "loads need a capacity" note group.
   */
  tank_capacity: number | null;
  /** Display unit for the capacity (e.g. "gal"). */
  capacity_unit: string | null;
  /** Per-acre carrier (water/spray) rate. NULL/0 → loads can't be planned for this job. */
  carrier_rate_gpa: number | null;
  /** A short source note for the capacity (vehicle name or "per-job override"). */
  capacity_source: string | null;
  /**
   * True when the job's capacity/rate could NOT be READ (a Supabase query error), as
   * opposed to genuinely not being set. The mix is still summed, but the loads "no
   * capacity" note must say "could not read" — NOT the misleading "enter capacity"
   * guidance — so a transient/RLS/missing-column fetch failure isn't reported as the
   * user having left the capacity blank (Codex P2). Defaults to false (capacity simply
   * unset).
   */
  loads_unreadable?: boolean;
}

/** The full cross-job master-mix payload the PDF renders. */
export interface MasterMixSummaryData {
  /** Combined product lines, sorted by product name then unit. */
  rows: MasterMixRow[];
  /** Per-capacity (per tank+rate) combined loads blocks — same-capacity jobs combine. */
  load_groups: MasterMixLoadGroup[];
  /** Jobs whose mix is summed but whose loads can't be planned (no capacity/rate). */
  no_load_jobs: MasterMixNoLoadJob[];
  /** The jobs whose mix IS summed into `rows`. */
  included_jobs: MasterMixJobRef[];
  /** Selected jobs that could NOT be fetched/resolved — NOT in the totals (never silent). */
  excluded_jobs: MasterMixExcludedJob[];
  /** Number of distinct product+unit lines in the combined mix. */
  distinct_product_lines: number;
  /** Total field acres across the included jobs (the batch acreage). */
  total_acres: number;
  /**
   * True when the loads break into MORE THAN ONE group — i.e. the selected jobs differ in
   * tank capacity, carrier rate, OR tank recipe, so loads are shown per group rather than
   * as one combined plan (criterion 6 note; also covers the Codex P1 recipe split).
   */
  mixed_capacities: boolean;
}

/** 4-dp rounding — matches the server/gatherer ROUND(..., 4) so sums stay exact. */
function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

/**
 * A collision-proof accumulator key for a product+unit line. We join the name and unit
 * with a NUL character (\u0000) instead of a space: a space-joined key would conflate
 * genuinely-distinct lines when a name or unit itself contains a space -- e.g.
 * `"Roundup fl" + "oz"` and `"Roundup" + "fl oz"` (and "fl oz" is a real unit) would
 * collapse, silently summing different products (Codex P2). NUL never appears in a product
 * name or measure unit, so two keys match only when both the name and the case-folded unit
 * truly match. Unit is case-folded so "PT" and "pt" sum together (display keeps the
 * first-seen casing).
 */
function productUnitKey(productName: string, unit: string): string {
  return `${productName}\u0000${unit.toLowerCase()}`;
}

/**
 * An order-independent signature of a job's TANK RECIPE — the set of (product, unit,
 * EFFECTIVE per-acre concentration) it mixes. Two jobs with the SAME signature have an
 * identical tank mix, so combining their loads into one scaled-up batch is exact; a
 * different signature means a different mix that must NOT be folded into the same per-load
 * split (Codex P1).
 *
 * The concentration is the EFFECTIVE rate = total_applied / total_acres, NOT the stored
 * `rate_per_acre` (Codex P2): a chemical line can be QUANTITY-ONLY (rate_per_acre null, a
 * hand-entered total) or carry a stale rate, and #10's per-load split actually divides the
 * SUMMED total across loads by VOLUME (≈ by acres) — so the quantity-per-acre is what
 * determines whether two jobs truly share a mix. Deriving it from total_applied/total_acres
 * (the very inputs the split uses) means 100 ac needing 100 pt and 100 ac needing 200 pt
 * get DIFFERENT signatures (1 pt/ac vs 2 pt/ac) and stay in separate load groups, instead
 * of both collapsing to a null-rate `na` and printing smeared 150-pt loads. A job with no
 * acre basis (total_acres ≤ 0) can't derive a per-acre rate — those jobs never reach here
 * (the capacity/rate guards above exclude a zero-acre job's loads), but we still emit a
 * stable 'na' so two such recipes only merge when their raw totals match too.
 */
function recipeSignature(products: ApplicatorSheetData['products'], totalAcres: number): string {
  const acres = Number.isFinite(totalAcres) && totalAcres > 0 ? totalAcres : 0;
  return products
    .filter((p) => p.total_applied != null && Number.isFinite(p.total_applied))
    .map((p) => {
      const unit = (p.total_unit ?? '').trim().toLowerCase();
      // Effective per-acre concentration drives the load split — derive it from the total
      // and the acre basis, falling back to the raw total when there is no acre basis.
      const effRate = acres > 0 ? round4((p.total_applied as number) / acres) : `q${round4(p.total_applied as number)}`;
      // NUL-delimited (not "|"): a product name could in principle contain a pipe, which
      // would let two distinct recipes collide into one signature (Codex P2 sibling case).
      return `${p.product_name}\u0000${unit}\u0000${effRate}`;
    })
    .sort()
    .join('::');
}

/**
 * Build the cross-job Master Mix Summary from the successfully-fetched jobs plus the
 * list of excluded jobs (so the caller never has to drop an unfetched job silently).
 *
 *  • The combined per-product mix sums each job's full to-be-mixed quantity, keyed by
 *    product name + unit, with the #12 form-conflict guard and gal/lb re-derivation.
 *  • The loads picture groups jobs by (capacity, carrier-rate) and computes ONE combined
 *    loader worksheet per group via #10's pure engine; jobs missing a capacity/rate are
 *    listed separately (mix still counted, loads not planned) — capacities are NEVER
 *    averaged across groups.
 *
 * Pure + tested.
 *
 * @param jobs     successfully-fetched jobs (each with its shared ApplicatorSheetData + loads inputs)
 * @param excluded selected jobs that could not be fetched/resolved (with a reason)
 */
export function buildMasterMixSummaryData(
  jobs: MasterMixJobInput[],
  excluded: MasterMixExcludedJob[] = [],
): MasterMixSummaryData {
  // ── 1) Combined per-product mix (the #12 aggregation, verbatim semantics) ──────
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

  const included_jobs: MasterMixJobRef[] = [];
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
      // Skip a line with no quantity to sum (a bare/flat line) — nothing to mix.
      if (p.total_applied == null || !Number.isFinite(p.total_applied)) continue;
      const unit = (p.total_unit ?? '').trim();
      // Key on name + a case-folded unit so "PT" and "pt" sum together; keep the
      // first-seen original unit casing for display.
      const key = productUnitKey(p.product_name, unit);
      const existing = acc.get(key);
      if (existing) {
        existing.total = round4(existing.total + p.total_applied);
        existing.job_ids.add(job_id);
        // Flag a product_form conflict (null treated as distinct) so gal/lb renders '—'
        // rather than guessing a gallon-vs-lb branch — the exact #12 guard.
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

  const rows: MasterMixRow[] = [...acc.values()]
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

  // ── 2) Per-capacity loads picture (group by capacity+rate; never average) ──────
  const { load_groups, no_load_jobs } = buildLoadGroups(jobs);

  return {
    rows,
    load_groups,
    no_load_jobs,
    included_jobs,
    excluded_jobs: excluded,
    distinct_product_lines: rows.length,
    total_acres,
    mixed_capacities: load_groups.length > 1,
  };
}

/**
 * Group the included jobs by their (effective capacity, carrier rate) and compute ONE
 * combined loader worksheet per group via #10's pure engine. Same-capacity+rate jobs
 * combine (criterion 3); different-capacity jobs land in separate groups (criterion 6);
 * jobs with no capacity OR no carrier rate cannot make a loads plan and are listed
 * separately (mix still summed elsewhere). Capacities are NEVER averaged.
 */
function buildLoadGroups(jobs: MasterMixJobInput[]): {
  load_groups: MasterMixLoadGroup[];
  no_load_jobs: MasterMixNoLoadJob[];
} {
  interface GroupAcc {
    tank_capacity: number;
    carrier_rate_gpa: number;
    job_numbers: string[];
    capacity_sources: Set<string>;
    total_acres: number;
    /** Combined products keyed by product name + unit (summed across the group's jobs). */
    products: Map<string, LoaderProductInput & { _key: string }>;
  }
  const groups = new Map<string, GroupAcc>();
  const no_load_jobs: MasterMixNoLoadJob[] = [];

  for (const j of jobs) {
    const capacity = j.tank_capacity != null && Number.isFinite(j.tank_capacity) && j.tank_capacity > 0
      ? round4(j.tank_capacity)
      : 0;
    const carrier = j.carrier_rate_gpa != null && Number.isFinite(j.carrier_rate_gpa) && j.carrier_rate_gpa > 0
      ? round4(j.carrier_rate_gpa)
      : 0;
    const jobLabel = j.data.job_number || j.job_id;

    // When the capacity/rate could NOT be READ (a query error upstream), say so plainly
    // rather than implying the user left it blank — the mix is still summed (Codex P2).
    if (j.loads_unreadable) {
      no_load_jobs.push({
        job_id: j.job_id,
        job_number: j.data.job_number,
        reason: 'Could not read this job’s tank capacity / carrier rate — loads not planned. The combined mix above still counts it.',
      });
      continue;
    }

    // A job can't be planned into loads without BOTH a gallon capacity and a carrier
    // rate. Mirror #10's guard wording so the report reads consistently. The mix for
    // these jobs is STILL summed into the combined totals — only the loads are deferred.
    if (capacity <= 0) {
      no_load_jobs.push({
        job_id: j.job_id,
        job_number: j.data.job_number,
        reason: 'Enter the sprayer tank capacity (gallons) on the job to plan loads.',
      });
      continue;
    }
    if (carrier <= 0) {
      no_load_jobs.push({
        job_id: j.job_id,
        job_number: j.data.job_number,
        reason: 'Enter a carrier rate (gallons per acre) on the job to plan loads.',
      });
      continue;
    }

    // Group key = capacity + carrier rate + RECIPE SIGNATURE. Capacity/rate alone is NOT
    // enough: two jobs that share a tank size but carry DIFFERENT products (or the same
    // product at a different per-acre rate) do NOT share one tank mix. #10's per-load split
    // divides each summed product across the loads by VOLUME (≈ by acres), which only
    // matches reality when every grouped job has the IDENTICAL recipe AND rates — otherwise
    // the combined per-load sheet would tell the loader to put job A's product into a load
    // covering job B's field (Codex P1). So we fold the recipe (product name + unit +
    // per-acre rate, order-independent) into the key: a group only ever contains jobs whose
    // tank mix is genuinely identical, for which scaling up to one combined batch is exact.
    // Jobs that differ in recipe/rate land in SEPARATE groups, each with its own correct
    // per-load split — never averaged, never cross-contaminated.
    const recipe = recipeSignature(j.data.products, j.data.total_acres);
    const key = `${capacity}|${carrier}|${recipe}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        tank_capacity: capacity,
        carrier_rate_gpa: carrier,
        job_numbers: [],
        capacity_sources: new Set<string>(),
        total_acres: 0,
        products: new Map(),
      };
      groups.set(key, g);
    }
    g.job_numbers.push(jobLabel);
    if (j.capacity_source) g.capacity_sources.add(j.capacity_source);
    g.total_acres = round4(g.total_acres + (Number.isFinite(j.data.total_acres) ? j.data.total_acres : 0));

    // Sum the group's products by name + unit so the combined per-load split is over the
    // batch's full mix (the same name+unit keying the combined-mix table uses).
    for (const p of j.data.products) {
      if (p.total_applied == null || !Number.isFinite(p.total_applied)) continue;
      const unit = (p.total_unit ?? '').trim();
      const pk = productUnitKey(p.product_name, unit);
      const existing = g.products.get(pk);
      if (existing) {
        existing.total_quantity = round4((existing.total_quantity ?? 0) + p.total_applied);
      } else {
        g.products.set(pk, { _key: pk, product_name: p.product_name, total_quantity: round4(p.total_applied), unit: unit || null });
      }
    }
  }

  const load_groups: MasterMixLoadGroup[] = [...groups.values()]
    .map((g) => {
      const products: LoaderProductInput[] = [...g.products.values()]
        .map((p) => ({ product_name: p.product_name, total_quantity: p.total_quantity, unit: p.unit }))
        .sort((a, b) =>
          a.product_name.localeCompare(b.product_name) || (a.unit ?? '').localeCompare(b.unit ?? ''),
        );
      const worksheet = computeLoaderWorksheet({
        total_acres: g.total_acres,
        carrier_rate_gpa: g.carrier_rate_gpa,
        tank_capacity: g.tank_capacity,
        products,
      });
      const sources = [...g.capacity_sources];
      const capacity_label = `${fmtNum(g.tank_capacity)} gal @ ${fmtNum(g.carrier_rate_gpa)} gal/ac`
        + (sources.length > 0 ? ` (${sources.join(', ')})` : '');
      return {
        tank_capacity: g.tank_capacity,
        carrier_rate_gpa: g.carrier_rate_gpa,
        capacity_label,
        job_numbers: g.job_numbers,
        total_acres: g.total_acres,
        worksheet,
      };
    })
    // Largest capacity first, then by rate — a stable, human-friendly order.
    .sort((a, b) => b.tank_capacity - a.tank_capacity || b.carrier_rate_gpa - a.carrier_rate_gpa);

  return { load_groups, no_load_jobs };
}
