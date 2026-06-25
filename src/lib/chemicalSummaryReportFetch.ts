/**
 * chemicalSummaryReportFetch — fetch the per-job data for the cross-job Chemical
 * Summary Report (field-app parity #12) and split the selected jobs into INCLUDED
 * (successfully fetched) vs EXCLUDED (could not be fetched/resolved).
 *
 * The summary's whole value is a correct grand total, so this NEVER silently drops a
 * selected job. Each job is fetched through the SAME shared gatherer the per-job
 * Chemical Application Report (#11) uses — `fetchChemicalApplicationReportData` —
 * so a single selected job's figures match that job's own report exactly. A job that
 * throws (e.g. a billed customer or product label could not be resolved — the #11
 * compliance ABORT) or returns null (deleted) is recorded as EXCLUDED with a plain
 * reason, so the caller can list it on the report and in a toast. The grand total is
 * therefore never quietly wrong.
 *
 * Job numbers for the excluded list are pre-fetched once (a single jobs query over
 * the selected ids) so an excluded job still shows a human-readable label even when
 * its full fetch failed.
 *
 * N+1 is acceptable here (one fetch per user-selected job — a bounded set); we do NOT
 * over-engineer a batch query. We just never undercount.
 */
import { supabase } from './db';
import { fetchChemicalApplicationReportData } from './chemicalApplicationReportFetch';
import { sanitizeError } from './errorSanitizer';
import type { ChemicalSummaryJobInput, ChemicalSummaryExcludedJob } from './chemicalSummaryReportData';

/** The fetch result: the jobs to sum + the jobs that must be shown as excluded. */
export interface ChemicalSummaryFetchResult {
  jobs: ChemicalSummaryJobInput[];
  excluded: ChemicalSummaryExcludedJob[];
}

/**
 * Fetch every selected job for the chemical summary. Returns the successfully-fetched
 * jobs AND the excluded jobs (with reasons). Order of `jobs` follows `jobIds`.
 *
 * A job is EXCLUDED (not silently dropped) when:
 *   • its fetch throws (RLS/compliance abort, network, label/customer unresolved), or
 *   • it returns null (job no longer exists), or
 *   • it has no chemicals to total (nothing to contribute — surfaced so the count is honest).
 */
export async function fetchChemicalSummaryData(jobIds: string[]): Promise<ChemicalSummaryFetchResult> {
  const uniqueIds = [...new Set(jobIds)];
  if (uniqueIds.length === 0) return { jobs: [], excluded: [] };

  // Pre-fetch job numbers once so an EXCLUDED job (whose full fetch failed) still shows a
  // readable label. A failure here is non-fatal — fall back to the id as the label.
  const numberById = new Map<string, string>();
  try {
    const { data } = await supabase.from('jobs').select('id, job_number').in('id', uniqueIds);
    (data as Array<{ id: string; job_number: string }> | null)?.forEach((j) => numberById.set(j.id, j.job_number));
  } catch { /* labels are best-effort */ }

  const jobs: ChemicalSummaryJobInput[] = [];
  const excluded: ChemicalSummaryExcludedJob[] = [];

  for (const jobId of uniqueIds) {
    const jobNumber = numberById.get(jobId) ?? null;
    try {
      const data = await fetchChemicalApplicationReportData(jobId);
      if (!data) {
        excluded.push({ job_id: jobId, job_number: jobNumber, reason: 'Job no longer exists' });
        continue;
      }
      // A job with no chemicals contributes nothing to the totals — list it as excluded so
      // the included-jobs count honestly reflects what was summed (rather than padding the
      // count with a job that added zero product lines).
      if (data.products.length === 0) {
        excluded.push({ job_id: jobId, job_number: data.job_number ?? jobNumber, reason: 'No chemicals on this job' });
        continue;
      }
      jobs.push({ job_id: jobId, data });
    } catch (err) {
      excluded.push({ job_id: jobId, job_number: jobNumber, reason: sanitizeError(err) });
    }
  }

  return { jobs, excluded };
}
