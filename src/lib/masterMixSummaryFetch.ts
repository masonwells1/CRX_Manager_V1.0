/**
 * masterMixSummaryFetch — fetch the per-job data for the cross-job Master Mix Summary
 * (field-app parity #14) and split the selected jobs into INCLUDED (successfully
 * fetched) vs EXCLUDED (could not be fetched/resolved).
 *
 * The master mix's whole value is a correct combined total, so this NEVER silently
 * drops a selected job. Each job's MIX is fetched through the SAME shared gatherer the
 * per-job Chemical Application Report (#11) uses — `fetchChemicalApplicationReportData`
 * — so a single selected job's per-product figures match that job's own report exactly,
 * and the combined total is the byte-honest sum.
 *
 * On TOP of the mix, the loads picture needs each job's tank CAPACITY + carrier RATE
 * (the #10 loader inputs), which the #11 gatherer does NOT carry. So we ALSO read, in
 * one batched jobs query (the loaderWorksheetFetch convention), each job's
 * loader_tank_capacity / carrier_rate_gpa and the assigned vehicle's gallon capacity,
 * and derive the EFFECTIVE gallon capacity exactly as #10 does (per-job override wins;
 * a vehicle capacity is only usable when its unit measures gallons). A job with no
 * gallon capacity / rate is still INCLUDED (its mix counts) — the aggregator lists it
 * under "loads need a capacity" rather than dropping it.
 *
 * A job whose #11 fetch throws (RLS/compliance abort, billed-customer or product label
 * unresolved) or returns null is recorded as EXCLUDED with a plain reason, so the caller
 * can list it on the report and in a toast. The combined total is therefore never
 * quietly wrong.
 *
 * N+1 is acceptable here (one #11 fetch per user-selected job — a bounded set); the
 * capacity/rate read is a SINGLE batched query over the selection.
 */
import { supabase } from './db';
import { fetchChemicalApplicationReportData } from './chemicalApplicationReportFetch';
import { isGallonCapacityUnit } from './loaderWorksheet';
import { sanitizeError } from './errorSanitizer';
import type { MasterMixJobInput, MasterMixExcludedJob } from './masterMixSummaryData';

/** The fetch result: the jobs to combine + the jobs that must be shown as excluded. */
export interface MasterMixFetchResult {
  jobs: MasterMixJobInput[];
  excluded: MasterMixExcludedJob[];
}

/** The loads-input columns we read per job (capacity/rate + vehicle gallon capacity). */
interface LoadsRow {
  id: string;
  job_number: string | null;
  carrier_rate_gpa: number | null;
  loader_tank_capacity: number | null;
  vehicle: { vehicle_name: string | null; capacity_gallons: number | null; capacity_unit: string | null } | null;
}

/** The derived loads inputs for one job (effective gallon capacity + its source). */
interface LoadsInputs {
  tank_capacity: number | null;
  capacity_unit: string | null;
  carrier_rate_gpa: number | null;
  capacity_source: string | null;
}

/**
 * Fetch every selected job for the master mix summary. Returns the successfully-fetched
 * jobs (each with its mix data + derived loads inputs) AND the excluded jobs (with
 * reasons). Order of `jobs` follows `jobIds`.
 *
 * A job is EXCLUDED (not silently dropped) when:
 *   • its #11 fetch throws (RLS/compliance abort, network, label/customer unresolved), or
 *   • it returns null (job no longer exists), or
 *   • it has no chemicals to mix (nothing to contribute — surfaced so the count is honest).
 *
 * A job MISSING a tank capacity / carrier rate is NOT excluded — its mix is still summed;
 * the aggregator surfaces it under "loads need a capacity" (criterion 6 guard, not a drop).
 */
export async function fetchMasterMixSummaryData(jobIds: string[]): Promise<MasterMixFetchResult> {
  const uniqueIds = [...new Set(jobIds)];
  if (uniqueIds.length === 0) return { jobs: [], excluded: [] };

  // One batched read of the loads inputs (capacity/rate + vehicle gallon capacity) for the
  // whole selection — derive the EFFECTIVE gallon capacity per job exactly as #10 does. A
  // failure here is non-fatal for the MIX: the combined mix still computes. But we must NOT
  // conflate a FAILED read with a genuinely-empty capacity: PostgREST returns an `error`
  // object (it does NOT throw) on an RLS/relationship/missing-column/network failure, and
  // an empty loadsById would then falsely tell the user EVERY job needs a capacity (Codex
  // P2). So we track whether the read failed and mark those jobs `loads_unreadable`, which
  // surfaces the honest "could not read capacity" note instead of the "enter capacity" one.
  const loadsById = new Map<string, LoadsInputs>();
  const numberById = new Map<string, string>();
  let loadsReadFailed = false;
  try {
    const { data, error } = await supabase
      .from('jobs')
      .select(`
        id, job_number, carrier_rate_gpa, loader_tank_capacity,
        vehicle:vehicles(vehicle_name, capacity_gallons, capacity_unit)
      `)
      .in('id', uniqueIds);
    if (error) throw error;
    ((data || []) as unknown as LoadsRow[]).forEach((r) => {
      if (r.job_number) numberById.set(r.id, r.job_number);
      loadsById.set(r.id, deriveLoadsInputs(r));
    });
  } catch {
    // The capacity/rate read failed for the whole batch — keep the mix, but flag every
    // job so the loads note is honest ("could not read") rather than misleading.
    loadsReadFailed = true;
  }

  const jobs: MasterMixJobInput[] = [];
  const excluded: MasterMixExcludedJob[] = [];

  for (const jobId of uniqueIds) {
    const jobNumber = numberById.get(jobId) ?? null;
    try {
      const data = await fetchChemicalApplicationReportData(jobId);
      if (!data) {
        excluded.push({ job_id: jobId, job_number: jobNumber, reason: 'Job no longer exists' });
        continue;
      }
      // A job with no chemicals contributes nothing to the combined mix — list it as
      // excluded so the included-jobs count honestly reflects what was summed.
      if (data.products.length === 0) {
        excluded.push({ job_id: jobId, job_number: data.job_number ?? jobNumber, reason: 'No chemicals on this job' });
        continue;
      }
      const loads = loadsById.get(jobId);
      // loads_unreadable when the whole capacity read failed OR this job's row didn't come
      // back (so we genuinely couldn't read its capacity) — distinct from a row that came
      // back with an empty capacity (the user simply hasn't set one). Either way the mix is
      // summed; only the loads note differs (Codex P2).
      const unreadable = loadsReadFailed || !loads;
      jobs.push({
        job_id: jobId,
        data,
        tank_capacity: loads?.tank_capacity ?? null,
        capacity_unit: loads?.capacity_unit ?? null,
        carrier_rate_gpa: loads?.carrier_rate_gpa ?? null,
        capacity_source: loads?.capacity_source ?? null,
        loads_unreadable: unreadable,
      });
    } catch (err) {
      excluded.push({ job_id: jobId, job_number: jobNumber, reason: sanitizeError(err) });
    }
  }

  return { jobs, excluded };
}

/**
 * Derive the effective gallon capacity + its source for one job, exactly as the #10
 * loader worksheet does: the per-job override (gallons) wins over the assigned vehicle's
 * capacity, and a vehicle capacity is only usable as a gallon tank size when its unit
 * measures gallons (a dry spreader rated in lbs/tons cannot seed gallon loads).
 */
function deriveLoadsInputs(r: LoadsRow): LoadsInputs {
  const override = r.loader_tank_capacity != null && r.loader_tank_capacity > 0 ? r.loader_tank_capacity : null;
  const vehicleCap = isGallonCapacityUnit(r.vehicle?.capacity_unit) ? (r.vehicle?.capacity_gallons ?? null) : null;
  const effectiveCapacity = override ?? vehicleCap;
  const capacity_unit = override != null ? 'gal' : (r.vehicle?.capacity_unit || 'gal');
  // A short, human source note for the combined-loads block header.
  let capacity_source: string | null = null;
  if (override != null) capacity_source = 'per-job override';
  else if (vehicleCap != null && r.vehicle?.vehicle_name) capacity_source = r.vehicle.vehicle_name;
  else if (vehicleCap != null) capacity_source = 'vehicle';
  return {
    tank_capacity: effectiveCapacity,
    capacity_unit,
    carrier_rate_gpa: r.carrier_rate_gpa,
    capacity_source,
  };
}
