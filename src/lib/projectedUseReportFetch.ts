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
 *   • remaining_acres > 0 (there is an un-sprayed portion to forecast).
 * Any other selected job — completed / invoiced / cancelled / 0 remaining — is EXCLUDED
 * with a plain reason and listed on the report, so the office sees it was deliberately
 * NOT projected (its product is already out, not still to buy).
 *
 * remaining_acres / total_acres / status are read from the SAME jobs row the list
 * already carries, but we re-read them here so the scope decision and the projection
 * basis come from one authoritative fetch (not a possibly-stale in-memory row).
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
  remaining_acres: number | null;
}

/** A short, plain-English reason a job is not projected. */
function excludeReason(status: string | null, remaining: number): string {
  if (status && !PROJECTABLE_STATUSES.has(status)) {
    return `Already applied / not scheduled (status: ${status}) — nothing left to project`;
  }
  if (remaining <= 0) return 'No remaining acres — all planned acres already applied';
  return 'Not eligible for projection';
}

/**
 * Fetch every selected job for the projected-use report. Returns the IN-SCOPE jobs
 * (with their acres basis) AND the excluded jobs (with reasons). Order of `jobs`
 * follows `jobIds`.
 *
 * A job is EXCLUDED (not silently dropped) when:
 *   • its status is not scheduled/in_progress (already-applied / completed / cancelled / invoiced), or
 *   • it has 0 remaining acres (all planned acres already sprayed), or
 *   • its scope row can't be read / it no longer exists, or
 *   • its #11 fetch throws (RLS/compliance abort, label/customer unresolved), or
 *   • it has no chemicals to project (nothing to contribute — surfaced so the count is honest).
 */
export async function fetchProjectedUseData(jobIds: string[]): Promise<ProjectedUseFetchResult> {
  const uniqueIds = [...new Set(jobIds)];
  if (uniqueIds.length === 0) return { jobs: [], excluded: [] };

  // One authoritative read of the scope columns (status + acres) for the selection.
  const scopeById = new Map<string, ScopeRow>();
  try {
    const { data, error } = await supabase
      .from('jobs')
      .select('id, job_number, status, total_acres, remaining_acres')
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
    const totalAcres = Number(scope.total_acres) || 0;
    const remainingAcres = Number(scope.remaining_acres ?? scope.total_acres) || 0;

    // SCOPE GATE: only scheduled/in_progress jobs with un-applied acres are projected.
    if (!status || !PROJECTABLE_STATUSES.has(status) || remainingAcres <= 0) {
      excluded.push({ job_id: jobId, job_number: jobNumber, reason: excludeReason(status, remainingAcres) });
      continue;
    }

    try {
      const data = await fetchChemicalApplicationReportData(jobId);
      if (!data) {
        excluded.push({ job_id: jobId, job_number: jobNumber, reason: 'Job no longer exists' });
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
        total_acres: totalAcres,
        status,
      });
    } catch (err) {
      excluded.push({ job_id: jobId, job_number: jobNumber, reason: sanitizeError(err) });
    }
  }

  return { jobs, excluded };
}
