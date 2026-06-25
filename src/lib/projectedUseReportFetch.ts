/**
 * projectedUseReportFetch — fetch the per-job data for the cross-job Projected Use
 * Report (field-app parity #13) and split the selected jobs into INCLUDED (in-scope,
 * not-yet-fully-applied) vs EXCLUDED (already-applied / unresolved).
 *
 * A projection's whole value is an HONEST forecast of what is NOT yet sprayed, so this
 * NEVER folds an already-applied quantity into the total and NEVER silently drops a
 * selected job. Each in-scope job is fetched through the SAME shared gatherer the
 * per-job Chemical Application Report (#11) uses — `fetchChemicalApplicationReportData`
 * — so a single job's planned figures match that job's own report exactly. The
 * projection then scales each product by the job's remaining-acres factor downstream
 * (in `buildProjectedUseReportData`).
 *
 * IN-SCOPE (the criterion-4 "distinguish projected from already-applied" gate):
 *   • status is 'scheduled' or 'in_progress' (a job that still has work to do), AND
 *   • remaining_acres > 0, where remaining = the gatherer's AUTHORITATIVE field-acre
 *     total (Σ job_fields.acres_to_treat = `data.total_acres`) MINUS applied_acres.
 * Any other selected job — completed / invoiced / cancelled / fully-applied / no-acres-
 * basis — is EXCLUDED with a plain reason and listed on the report, so the office sees it
 * was deliberately NOT projected (its product is already out, not still to buy).
 *
 * WHY NOT jobs.remaining_acres (the bug this fixes): jobs.remaining_acres is a GENERATED
 * column = GREATEST(COALESCE(total_acres,0) − COALESCE(applied_acres,0), 0). When a
 * scheduled/in_progress job has a NULL jobs.total_acres but real un-applied field work, it
 * reads 0 (never NULL), so a remaining<=0 gate would silently DROP a fresh job with the
 * FALSE reason "already applied" — the office under-orders. So we DRIVE the acre math off
 * the gatherer's field-acre total (data.total_acres) and read applied_acres to compute
 * remaining honestly. jobs.total_acres is only a last-resort fallback when the job has no
 * field acres at all.
 *
 * status / applied_acres / total_acres are read from the SAME jobs row the list already
 * carries, but we re-read them here so the scope decision and the projection basis come
 * from one authoritative fetch (not a possibly-stale in-memory row).
 *
 * N+1 is acceptable here (one fetch per in-scope job — a bounded, user-selected set);
 * we do NOT over-engineer a batch query. We just never undercount.
 */
import { supabase } from './db';
import { fetchChemicalApplicationReportData } from './chemicalApplicationReportFetch';
import { sanitizeError } from './errorSanitizer';
import type { ProjectedUseJobInput, ProjectedUseExcludedJob } from './projectedUseReportData';

/** The fetch result: the in-scope jobs to project + the jobs shown as excluded. */
export interface ProjectedUseFetchResult {
  jobs: ProjectedUseJobInput[];
  excluded: ProjectedUseExcludedJob[];
}

/** Statuses that still have un-applied work to forecast. */
const PROJECTABLE_STATUSES = new Set(['scheduled', 'in_progress']);

/** Minimal jobs-row shape we read for the scope decision + projection basis. */
interface ScopeRow {
  id: string;
  job_number: string | null;
  status: string | null;
  total_acres: number | null;
  applied_acres: number | null;
}

/**
 * Fetch every selected job for the projected-use report. Returns the IN-SCOPE jobs
 * (with their acres basis) AND the excluded jobs (with reasons). Order of `jobs`
 * follows `jobIds`.
 *
 * A job is EXCLUDED (not silently dropped) when:
 *   • its status is not scheduled/in_progress (already-applied / completed / cancelled / invoiced), or
 *   • it is genuinely fully applied (applied_acres >= the field-acre total), or
 *   • it has no acres basis at all (no field acres AND no jobs.total_acres to fall back on), or
 *   • its scope row can't be read / it no longer exists, or
 *   • its #11 fetch throws (RLS/compliance abort, label/customer unresolved), or
 *   • it has no chemicals to project (nothing to contribute — surfaced so the count is honest).
 */
export async function fetchProjectedUseData(jobIds: string[]): Promise<ProjectedUseFetchResult> {
  const uniqueIds = [...new Set(jobIds)];
  if (uniqueIds.length === 0) return { jobs: [], excluded: [] };

  // One authoritative read of the scope columns (status + applied/total acres) for the
  // selection. We DO NOT read jobs.remaining_acres: it is a generated column off
  // jobs.total_acres and reads 0 (never NULL) when total_acres is NULL, which would drop a
  // fresh NULL-total job. We compute remaining ourselves from the field-acre basis below.
  const scopeById = new Map<string, ScopeRow>();
  try {
    const { data, error } = await supabase
      .from('jobs')
      .select('id, job_number, status, total_acres, applied_acres')
      .in('id', uniqueIds);
    if (error) throw error;
    (data as ScopeRow[] | null)?.forEach((j) => scopeById.set(j.id, j));
  } catch (err) {
    // If we can't read the scope columns at all, surface EVERY selected job as excluded
    // (with the real reason) rather than projecting from possibly-wrong assumptions.
    const reason = sanitizeError(err);
    return {
      jobs: [],
      excluded: uniqueIds.map((id) => ({ job_id: id, job_number: null, reason })),
    };
  }

  const jobs: ProjectedUseJobInput[] = [];
  const excluded: ProjectedUseExcludedJob[] = [];

  for (const jobId of uniqueIds) {
    const scope = scopeById.get(jobId);
    if (!scope) {
      excluded.push({ job_id: jobId, job_number: null, reason: 'Job no longer exists' });
      continue;
    }
    const jobNumber = scope.job_number ?? null;
    const status = scope.status ?? null;
    const appliedAcres = Number.isFinite(Number(scope.applied_acres)) ? Number(scope.applied_acres) : 0;
    const jobsTotalAcres = Number.isFinite(Number(scope.total_acres)) ? Number(scope.total_acres) : 0;

    // STATUS GATE ONLY: only scheduled/in_progress jobs still have work to project. The
    // ACRE/remaining decision is made AFTER the gatherer fetch below, off the gatherer's
    // authoritative field-acre total — NOT jobs.remaining_acres (which reads 0 for a fresh
    // NULL-total job and would silently drop it as "already applied").
    if (!status || !PROJECTABLE_STATUSES.has(status)) {
      excluded.push({
        job_id: jobId,
        job_number: jobNumber,
        reason: `Already applied / not scheduled (status: ${status ?? 'unknown'}) — nothing left to project`,
      });
      continue;
    }

    try {
      const data = await fetchChemicalApplicationReportData(jobId);
      if (!data) {
        excluded.push({ job_id: jobId, job_number: jobNumber, reason: 'Job no longer exists' });
        continue;
      }

      // AUTHORITATIVE acre basis = the gatherer's field-acre total (Σ acres_to_treat).
      // Fall back to jobs.total_acres ONLY when the job has no field acres at all.
      const fieldTotal = Number.isFinite(data.total_acres) && data.total_acres > 0
        ? data.total_acres
        : jobsTotalAcres;

      if (fieldTotal <= 0) {
        // No acres basis at all — honest reason, NOT "already applied" (applied may be 0).
        excluded.push({
          job_id: jobId,
          job_number: data.job_number ?? jobNumber,
          reason: 'No acres basis to project — set the job’s field/total acres',
        });
        continue;
      }

      // Honest remaining = the field-acre total minus what has already been applied.
      const remainingAcres = Math.max(fieldTotal - appliedAcres, 0);
      if (remainingAcres <= 0) {
        // Genuinely fully applied (applied >= the field-acre total) — nothing left.
        excluded.push({
          job_id: jobId,
          job_number: data.job_number ?? jobNumber,
          reason: 'Already applied — nothing left to project',
        });
        continue;
      }

      if (data.products.length === 0) {
        excluded.push({ job_id: jobId, job_number: data.job_number ?? jobNumber, reason: 'No chemicals on this job to project' });
        continue;
      }
      jobs.push({
        job_id: jobId,
        data,
        remaining_acres: remainingAcres,
        acre_basis: fieldTotal, // the basis we derived remaining from — honored by the aggregator
        status,
      });
    } catch (err) {
      excluded.push({ job_id: jobId, job_number: jobNumber, reason: sanitizeError(err) });
    }
  }

  return { jobs, excluded };
}
