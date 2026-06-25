// Field-app parity #17 — pure helpers for as-applied entry records.
//
// These are intentionally side-effect-free so they can be unit-tested without
// the DB or React. The component (AppliedRecordsManager) handles I/O; the
// rules here decide the default vehicle, validate an entry, and build the
// persisted patch.

import type { JobAppliedRecord, JobAppliedRecordRow } from '../../types';

// Field-app parity #18: a per-location line inside an as-applied entry draft —
// which field was sprayed in this pass and how many acres on it. String-valued
// (form inputs). The persisted child table is job_applied_record_fields.
export interface AppliedFieldDraft {
  field_id: string;
  applied_acres: string;
}

// Field-app parity #19: one weather set (START or END) as edited in the form —
// all string-valued (form inputs). `source` tracks whether the set was last
// auto-pulled from Open-Meteo or hand-entered/edited, so the UI can badge it and
// so an edit after an auto-pull flips it to 'manual'.
export interface WeatherSetDraft {
  time: string; // 'HH:MM'
  temp_f: string;
  wind_direction: string;
  wind_mph: string;
  humidity_pct: string;
  source: 'auto' | 'manual' | '';
}

export function emptyWeatherSetDraft(): WeatherSetDraft {
  return { time: '', temp_f: '', wind_direction: '', wind_mph: '', humidity_pct: '', source: '' };
}

export interface AppliedRecordDraft {
  applicator_id: string;
  vehicle_id: string;
  application_date: string; // 'YYYY-MM-DD'
  applied_acres: string;
  notes: string;
  // #18: per-location applied acres. When any line is present, the record's
  // applied_acres total is DERIVED from these (the manual applied_acres input is
  // hidden in favour of this detail). Empty list = no per-location detail.
  fields: AppliedFieldDraft[];
  // #19: START + END weather pair.
  startWeather: WeatherSetDraft;
  endWeather: WeatherSetDraft;
}

export function emptyAppliedRecordDraft(defaults?: Partial<AppliedRecordDraft>): AppliedRecordDraft {
  return {
    applicator_id: '',
    vehicle_id: '',
    application_date: '',
    applied_acres: '',
    notes: '',
    fields: [],
    startWeather: emptyWeatherSetDraft(),
    endWeather: emptyWeatherSetDraft(),
    ...defaults,
  };
}

// DB `time` values come back as 'HH:MM:SS'; the <input type="time"> wants 'HH:MM'.
// Trim seconds for display/editing without losing a meaningful value.
export function timeForInput(t: string | null | undefined): string {
  if (!t) return '';
  const m = /^(\d{2}:\d{2})/.exec(t);
  return m ? m[1] : '';
}

// Turn a persisted weather set (START or END columns) back into a draft.
function weatherSetFromRecord(
  rec: JobAppliedRecord,
  prefix: 'start' | 'end',
): WeatherSetDraft {
  const num = (v: number | null) => (v != null ? String(v) : '');
  if (prefix === 'start') {
    return {
      time: timeForInput(rec.start_weather_time),
      temp_f: num(rec.start_temp_f),
      wind_direction: rec.start_wind_direction ?? '',
      wind_mph: num(rec.start_wind_mph),
      humidity_pct: num(rec.start_humidity_pct),
      source: rec.start_weather_source ?? '',
    };
  }
  return {
    time: timeForInput(rec.end_weather_time),
    temp_f: num(rec.end_temp_f),
    wind_direction: rec.end_wind_direction ?? '',
    wind_mph: num(rec.end_wind_mph),
    humidity_pct: num(rec.end_humidity_pct),
    source: rec.end_weather_source ?? '',
  };
}

// Turn a persisted row back into an editable draft (string-valued for inputs).
export function draftFromRecord(rec: JobAppliedRecord & { job_applied_record_fields?: { field_id: string; applied_acres: number }[] }): AppliedRecordDraft {
  return {
    applicator_id: rec.applicator_id ?? '',
    vehicle_id: rec.vehicle_id ?? '',
    application_date: rec.application_date ?? '',
    applied_acres: rec.applied_acres != null ? String(rec.applied_acres) : '',
    notes: rec.notes ?? '',
    fields: (rec.job_applied_record_fields ?? []).map((f) => ({
      field_id: f.field_id,
      applied_acres: f.applied_acres != null ? String(f.applied_acres) : '',
    })),
    startWeather: weatherSetFromRecord(rec, 'start'),
    endWeather: weatherSetFromRecord(rec, 'end'),
  };
}

// ── #19 weather pair: Total Time + persistence helpers (pure, DB-free, tested) ─

// Minutes-from-midnight of an 'HH:MM' (or 'HH:MM:SS') time, or null if unparseable.
function timeToMinutes(t: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(t.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null;
  return h * 60 + min;
}

// Total Time = end - start, in whole minutes. Returns null when either time is
// missing/invalid. When end is earlier than start the window is assumed to cross
// midnight (e.g. start 23:00, end 01:00 -> 120 min), matching how a crew would
// read an overnight spray window. Pure — exported for tests and the UI display.
export function computeTotalMinutes(startTime: string, endTime: string): number | null {
  const s = timeToMinutes(startTime);
  const e = timeToMinutes(endTime);
  if (s == null || e == null) return null;
  const diff = e - s;
  return diff >= 0 ? diff : diff + 24 * 60;
}

// Format a minute count as 'Hh Mm' (e.g. 135 -> '2h 15m', 45 -> '45m'). Returns
// '—' for null so the Total Time cell is never blank/NaN.
export function formatTotalTime(minutes: number | null): string {
  if (minutes == null) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// True when a weather set has at least one entered value (used to decide whether
// to default an un-flagged source to 'manual' on save, and to show the badge).
export function weatherSetHasData(w: WeatherSetDraft): boolean {
  return (
    w.time.trim() !== '' ||
    w.temp_f.trim() !== '' ||
    w.wind_direction.trim() !== '' ||
    w.wind_mph.trim() !== '' ||
    w.humidity_pct.trim() !== ''
  );
}

// A persisted weather set (the start_/end_ columns of a saved record).
export interface PersistedWeatherSet {
  time: string | null;
  temp_f: number | null;
  wind_direction: string | null;
  wind_mph: number | null;
  humidity_pct: number | null;
}

// Compact one-line summary of a persisted weather set for the entry list, e.g.
// "08:30 · 72°F · NNW 8mph · 54%". Empty parts are omitted; returns '' when the
// set has no data. Pure — exported for tests and the list cell.
export function summarizeWeatherSet(w: PersistedWeatherSet): string {
  const parts: string[] = [];
  if (w.time) parts.push(timeForInput(w.time));
  if (w.temp_f != null) parts.push(`${w.temp_f}°F`);
  const wind: string[] = [];
  if (w.wind_direction) wind.push(w.wind_direction);
  if (w.wind_mph != null) wind.push(`${w.wind_mph}mph`);
  if (wind.length) parts.push(wind.join(' '));
  if (w.humidity_pct != null) parts.push(`${w.humidity_pct}%`);
  return parts.join(' · ');
}

// ── #18 per-location applied-acres math (pure, DB-free, unit-tested) ─────────

// Sum the per-location lines of a single entry draft (blank/invalid -> 0). This
// is the entry's own applied-acres total when per-location detail is present.
export function sumDraftFieldAcres(fields: AppliedFieldDraft[]): number {
  return fields.reduce((sum, f) => {
    const n = Number(f.applied_acres);
    return sum + (Number.isFinite(n) && n > 0 ? n : 0);
  }, 0);
}

// Sum the persisted per-location rows of an already-saved entry. This is the raw
// child-row sum only — for a record's *effective* acres (which falls back to the
// manual figure when there are no child rows) use effectiveRecordAcres below.
export function sumRecordFieldAcres(rec: JobAppliedRecordRow): number {
  return (rec.job_applied_record_fields ?? []).reduce(
    (sum, f) => sum + (Number.isFinite(f.applied_acres) ? f.applied_acres : 0),
    0,
  );
}

// A record's EFFECTIVE applied acres — the figure that contributes to the job
// total. This MUST mirror the DB exactly (recompute_job_applied_acres sums
// job_applied_records.applied_acres across ALL records, where a per-location
// record's applied_acres = sum of its child rows and a #17-era manual-only
// record keeps its manual applied_acres):
//   - child rows present  -> sum of the child rows (a per-location record)
//   - no child rows       -> the coerced manual applied_acres (a #17-era record)
// Without this, a mixed #17/#18 job would read low (manual records ignored) and
// the per-row cell would contradict the job summary.
export function effectiveRecordAcres(rec: JobAppliedRecordRow): number {
  const children = rec.job_applied_record_fields ?? [];
  if (children.length > 0) return sumRecordFieldAcres(rec);
  const manual = Number(rec.applied_acres);
  return Number.isFinite(manual) ? manual : 0;
}

// The job's total APPLIED acres across every saved entry, using each record's
// EFFECTIVE acres (child-sum when per-location, manual figure otherwise). This
// mirrors what the DB writes to jobs.applied_acres. `excludeId` drops the entry
// currently being edited so the live counter can preview the new total =
// (others) + (this draft's current sum) without double-counting.
export function sumAppliedAcresAcrossRecords(
  records: JobAppliedRecordRow[],
  excludeId?: string | null,
): number {
  return records
    .filter((r) => !excludeId || r.id !== excludeId)
    .reduce((sum, r) => sum + effectiveRecordAcres(r), 0);
}

export interface RemainingAcresView {
  total: number; // planned (jobs.total_acres)
  applied: number; // sum of every entry's per-location acres
  remaining: number; // GREATEST(total - applied, 0) — mirrors the GENERATED col
  over: number; // how far applied exceeds total (0 when within plan)
  isOver: boolean; // applied > total -> show the over-application warning
}

// Epsilon for the over-application check. Raw JS float math means {0.1, 0.2}
// sums to 0.30000000000000004, which would trip "Over-applied by 0.00 ac" against
// a 0.3 total. We flag over-application only when applied exceeds total by more
// than EPS (a hair under a hundredth of an acre — well below the 2dp the UI shows).
const OVER_EPS = 1e-6;

// Compute the Total / Applied / Remaining view for a job, optionally previewing
// an in-progress edit (excludeId + draftSum replaces that entry's saved acres).
// remaining clamps at 0 to mirror the GENERATED jobs.remaining_acres column; the
// `over` amount is surfaced separately so the UI can warn without the column
// going negative.
export function computeRemainingAcres(
  totalAcres: number,
  records: JobAppliedRecordRow[],
  opts?: { excludeId?: string | null; draftSum?: number },
): RemainingAcresView {
  const others = sumAppliedAcresAcrossRecords(records, opts?.excludeId);
  const applied = others + (opts?.draftSum ?? 0);
  const total = Number.isFinite(totalAcres) ? totalAcres : 0;
  const remaining = Math.max(total - applied, 0);
  // Float-safe over check: only a difference beyond EPS counts as over-applied,
  // so {0.1,0.2} vs 0.3 does NOT falsely flag "over by 0.00 ac".
  const isOver = applied - total > OVER_EPS;
  const over = isOver ? applied - total : 0;
  return { total, applied, remaining, over, isOver };
}

// "Vehicle defaults from the chosen applicator/vehicle but is editable":
// when an applicator is picked, default the vehicle to the one that applicator
// most recently used (its newest prior record), so a repeat applicator gets
// their usual machine pre-filled. Falls back to the job's vehicle_id. Returns
// '' when there is nothing to default to. Newest is decided by application_date
// then created_at (string-comparable ISO/date values).
export function defaultVehicleForApplicator(
  applicatorId: string,
  existingRecords: JobAppliedRecordRow[],
  jobVehicleId: string | null | undefined,
): string {
  if (!applicatorId) return '';
  const prior = existingRecords
    .filter((r) => r.applicator_id === applicatorId && r.vehicle_id)
    .sort((a, b) => {
      const byDate = (b.application_date ?? '').localeCompare(a.application_date ?? '');
      if (byDate !== 0) return byDate;
      return (b.created_at ?? '').localeCompare(a.created_at ?? '');
    });
  if (prior.length > 0 && prior[0].vehicle_id) return prior[0].vehicle_id;
  return jobVehicleId ?? '';
}

export interface AppliedRecordValidation {
  ok: boolean;
  error?: string;
}

// An applied record is the legal proof of who sprayed, with what, on what day.
// The non-negotiable fields are Applicator and Application Date (a record with
// neither is not usable). Vehicle is recommended but not strictly required (a
// hand-applied pass may have no machine). applied_acres, if entered, must parse
// to a non-negative number (mirrors the DB CHECK). #18: each per-location line,
// if a field is picked, must carry a non-negative acres value, and a field can
// only appear once per entry (the DB has UNIQUE(record, field)).
export function validateAppliedRecord(draft: AppliedRecordDraft): AppliedRecordValidation {
  if (!draft.applicator_id) return { ok: false, error: 'Select an applicator.' };
  if (!draft.application_date) return { ok: false, error: 'Pick an application date.' };
  if (draft.applied_acres.trim() !== '') {
    const n = Number(draft.applied_acres);
    if (!Number.isFinite(n) || n < 0) {
      return { ok: false, error: 'Applied acres must be a number of 0 or more.' };
    }
  }
  const seen = new Set<string>();
  for (const f of draft.fields) {
    if (!f.field_id) continue; // a blank row a user hasn't filled in yet is dropped on save
    if (seen.has(f.field_id)) {
      return { ok: false, error: 'Each location can only be listed once per entry.' };
    }
    seen.add(f.field_id);
    if (f.applied_acres.trim() === '') {
      return { ok: false, error: 'Enter applied acres for each location, or remove the row.' };
    }
    const n = Number(f.applied_acres);
    if (!Number.isFinite(n) || n < 0) {
      return { ok: false, error: 'Location applied acres must be a number of 0 or more.' };
    }
  }
  // #19: weather values, if entered, must be valid (mirror the DB CHECKs). Temp
  // is unconstrained (can be below 0F); wind speed >= 0; humidity 0–100.
  const wErr = validateWeatherSet(draft.startWeather, 'Start');
  if (wErr) return { ok: false, error: wErr };
  const eErr = validateWeatherSet(draft.endWeather, 'End');
  if (eErr) return { ok: false, error: eErr };
  return { ok: true };
}

// Validate one weather set's numeric fields. Returns an error message or null.
// Blank fields are allowed (every weather value is optional). Wind speed must be
// >= 0 and humidity 0–100 to mirror the DB CHECK constraints; temp is free.
function validateWeatherSet(w: WeatherSetDraft, label: string): string | null {
  if (w.temp_f.trim() !== '' && !Number.isFinite(Number(w.temp_f))) {
    return `${label} temperature must be a number.`;
  }
  if (w.wind_mph.trim() !== '') {
    const n = Number(w.wind_mph);
    if (!Number.isFinite(n) || n < 0) return `${label} wind speed must be a number of 0 or more.`;
  }
  if (w.humidity_pct.trim() !== '') {
    const n = Number(w.humidity_pct);
    if (!Number.isFinite(n) || n < 0 || n > 100) return `${label} humidity must be between 0 and 100.`;
  }
  return null;
}

// The persisted weather columns for one set (START or END). All nullable.
export interface WeatherSetPatch {
  time: string | null; // 'HH:MM' (Postgres `time`)
  temp_f: number | null;
  wind_direction: string | null;
  wind_mph: number | null;
  humidity_pct: number | null;
  source: 'auto' | 'manual' | null;
}

export interface AppliedRecordPatch {
  applicator_id: string;
  vehicle_id: string | null;
  application_date: string;
  applied_acres: number | null;
  notes: string | null;
  // #19 START + END weather columns (flattened with start_/end_ prefixes).
  start_weather_time: string | null;
  start_temp_f: number | null;
  start_wind_direction: string | null;
  start_wind_mph: number | null;
  start_humidity_pct: number | null;
  start_weather_source: 'auto' | 'manual' | null;
  end_weather_time: string | null;
  end_temp_f: number | null;
  end_wind_direction: string | null;
  end_wind_mph: number | null;
  end_humidity_pct: number | null;
  end_weather_source: 'auto' | 'manual' | null;
}

// Convert a weather-set draft into its persisted columns. Empty strings -> null.
// `source` resolution: keep an explicit 'auto'/'manual' flag; otherwise mark a
// set that has any data as 'manual' (the crew typed it), and leave a fully-empty
// set's source NULL. Assumes the draft already passed validateAppliedRecord.
export function buildWeatherSetPatch(w: WeatherSetDraft): WeatherSetPatch {
  const numOrNull = (s: string) => (s.trim() === '' ? null : Number(s));
  const hasData = weatherSetHasData(w);
  const source: 'auto' | 'manual' | null = w.source === 'auto' || w.source === 'manual'
    ? w.source
    : (hasData ? 'manual' : null);
  return {
    time: w.time.trim() === '' ? null : w.time.trim(),
    temp_f: numOrNull(w.temp_f),
    wind_direction: w.wind_direction.trim() === '' ? null : w.wind_direction.trim(),
    wind_mph: numOrNull(w.wind_mph),
    humidity_pct: numOrNull(w.humidity_pct),
    source,
  };
}

// The persisted per-location child rows for an entry (job_applied_record_fields,
// minus the application_record_id which the caller stamps after the parent saves).
export interface AppliedFieldRow {
  field_id: string;
  applied_acres: number;
}

// Build the exact object persisted to job_applied_records. Empty strings become
// null (so an un-picked vehicle / blank notes store as NULL, not ''). Assumes
// the draft already passed validateAppliedRecord.
//
// applied_acres resolution (#18):
//   - perLocationMode = true (the job has planned locations, so the UI captures
//     per-location acres): the record's applied_acres ALWAYS equals the sum of
//     its per-location lines — including 0 when every line was removed. This
//     keeps the per-entry display in lock-step with what the DB trigger rolls
//     into the job total (no stale "60" left on a record whose locations were
//     all cleared). The DB trigger also recomputes it, so the two agree.
//   - perLocationMode = false (a job with no planned locations, the #17-style
//     fallback): the manual applied_acres input is used as-is.
export function buildAppliedRecordPatch(
  draft: AppliedRecordDraft,
  perLocationMode = false,
): AppliedRecordPatch {
  const manual = draft.applied_acres.trim();
  const applied = perLocationMode
    ? sumDraftFieldAcres(draft.fields)
    : (manual === '' ? null : Number(manual));
  const start = buildWeatherSetPatch(draft.startWeather);
  const end = buildWeatherSetPatch(draft.endWeather);
  return {
    applicator_id: draft.applicator_id,
    vehicle_id: draft.vehicle_id || null,
    application_date: draft.application_date,
    applied_acres: applied,
    notes: draft.notes.trim() === '' ? null : draft.notes.trim(),
    start_weather_time: start.time,
    start_temp_f: start.temp_f,
    start_wind_direction: start.wind_direction,
    start_wind_mph: start.wind_mph,
    start_humidity_pct: start.humidity_pct,
    start_weather_source: start.source,
    end_weather_time: end.time,
    end_temp_f: end.temp_f,
    end_wind_direction: end.wind_direction,
    end_wind_mph: end.wind_mph,
    end_humidity_pct: end.humidity_pct,
    end_weather_source: end.source,
  };
}

// Extract the per-location child rows to persist (dropping blank rows). Assumes
// the draft already passed validateAppliedRecord (so no dup fields / bad acres).
export function buildAppliedFieldRows(draft: AppliedRecordDraft): AppliedFieldRow[] {
  return draft.fields
    .filter((f) => f.field_id && f.applied_acres.trim() !== '')
    .map((f) => ({ field_id: f.field_id, applied_acres: Number(f.applied_acres) }));
}
