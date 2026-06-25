// Field-app parity #24 — pure helpers for the invoice editor's "Applied Info"
// carry-over panel.
//
// When a field-application invoice was TRANSFERRED from a job (invoices.job_id is
// set — the #27 transfer path), the legal as-applied record lives on that job's
// job_applied_records (applicator / vehicle / application date / start+end weather
// / tach / ground crew). The invoice editor READS those rows and DISPLAYS them
// read-only so the office can verify the compliance data on the bill itself,
// without re-keying it. These helpers turn a loaded JobAppliedRecordRow into the
// display strings the panel renders, reusing the #17–#21 helpers as the single
// source of truth for weather / time / crew formatting. Side-effect-free so they
// unit-test without the DB or React.

import type { JobAppliedRecordRow } from '../../types';
import {
  summarizeWeatherSet,
  formatTotalTime,
  computeTotalMinutes,
  timeForInput,
  crewMemberDisplayName,
} from '../jobs/appliedRecords';

// The two strings applicatorNameFor() returns when there is no real name to show.
// They are fine for the on-screen carry-over panel, but must NEVER reach the printed
// legal PDF Applicator field — there they read as junk. realApplicatorName() below
// maps them back to null so the PDF can fall through to a real source or print blank.
export const APPLICATOR_PLACEHOLDERS = ['—', '(removed applicator)'] as const;

export interface AppliedCarryoverRow {
  id: string;
  applicator_id: string | null;
  applicator_name: string;
  vehicle_name: string;
  application_date: string;
  start_weather: string;
  end_weather: string;
  total_time: string;
  net_tach: string;
  crew_members: string[];
}

// Resolve an applicator id to a name using a label map sourced from
// profile_public_view (NEVER a profiles embed — that RLS nulls out for
// non-admins; see the #17 LESSON). Falls back to a clear placeholder.
export type NameMap = ReadonlyMap<string, string>;

export function applicatorNameFor(
  applicatorId: string | null,
  names: NameMap,
): string {
  if (!applicatorId) return '—';
  return names.get(applicatorId) ?? '(removed applicator)';
}

// Return a REAL applicator name for the printed legal PDF, or null when there isn't
// one. A placeholder string (em-dash / "(removed applicator)") is treated as NO value
// so it never prints on the bill. #17 LESSON: an inactive applicator is still a real,
// printable name — resolve from an UNFILTERED name map (not the active-only picker
// list) so a now-inactive applicator still prints correctly instead of a placeholder.
export function realApplicatorName(name: string | null | undefined): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  if (trimmed === '' || (APPLICATOR_PLACEHOLDERS as readonly string[]).includes(trimmed)) {
    return null;
  }
  return trimmed;
}

// Format the net tach (engine hours) for display. net_tach is the GENERATED
// column = GREATEST(end - beginning, 0), NULL when either reading is missing.
export function formatNetTach(netTach: number | null): string {
  if (netTach == null) return '—';
  return `${netTach} hr`;
}

// Turn one saved as-applied record into the display row the carry-over panel
// renders. Weather / time / crew formatting is delegated to the #17–#21 helpers
// so the invoice panel and the job's Applied Info tab never drift.
export function carryoverRowFromRecord(
  rec: JobAppliedRecordRow,
  applicatorNames: NameMap,
): AppliedCarryoverRow {
  const startWeather = summarizeWeatherSet({
    time: rec.start_weather_time,
    temp_f: rec.start_temp_f,
    wind_direction: rec.start_wind_direction,
    wind_mph: rec.start_wind_mph,
    humidity_pct: rec.start_humidity_pct,
  });
  const endWeather = summarizeWeatherSet({
    time: rec.end_weather_time,
    temp_f: rec.end_temp_f,
    wind_direction: rec.end_wind_direction,
    wind_mph: rec.end_wind_mph,
    humidity_pct: rec.end_humidity_pct,
  });
  const totalMinutes = computeTotalMinutes(
    timeForInput(rec.start_weather_time),
    timeForInput(rec.end_weather_time),
  );
  const crewMembers = (rec.job_applied_record_crew ?? []).map((link) =>
    crewMemberDisplayName(link),
  );
  return {
    id: rec.id,
    applicator_id: rec.applicator_id,
    applicator_name: applicatorNameFor(rec.applicator_id, applicatorNames),
    vehicle_name: rec.vehicle?.vehicle_name ?? '—',
    application_date: rec.application_date || '—',
    start_weather: startWeather || '—',
    end_weather: endWeather || '—',
    total_time: formatTotalTime(totalMinutes),
    net_tach: formatNetTach(rec.net_tach),
    crew_members: crewMembers,
  };
}

// Map a list of saved records into display rows (most-recent first, matching the
// AppliedRecordsManager ordering).
export function carryoverRowsFromRecords(
  records: JobAppliedRecordRow[],
  applicatorNames: NameMap,
): AppliedCarryoverRow[] {
  return records.map((rec) => carryoverRowFromRecord(rec, applicatorNames));
}
