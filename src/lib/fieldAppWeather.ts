/**
 * fieldAppWeather.ts — pure mapping logic for the field-application invoice's
 * structured START/END weather (ChemMan Gap-Closeout #1).
 *
 * The invoice mirrors the proven job_applied_records weather model: each of
 * START and END carries Time (HH:MM), Temp (F), Wind Direction (cardinal), Wind
 * mph, Humidity %, and a source flag ('auto' = Open-Meteo pull, 'manual' =
 * hand-entered/edited). Weather is a convenience capture and NEVER gates a save;
 * manual entry must always work (offline fallback).
 *
 * This module is intentionally UI-free so the form<->row<->RPC mapping is unit
 * testable. The component (FieldApplicationInvoice.tsx) holds the React state
 * and calls these helpers.
 */
import type { CapturedWeather } from './weatherCapture';

export type WeatherSource = 'auto' | 'manual';

/** One weather set (START or END) as edited in the form. All strings so the
 *  inputs are controlled; empty string = not entered. `source` is null until a
 *  value exists, then 'auto' (fetched) or 'manual' (hand-entered/edited). */
export interface WeatherSetForm {
  time: string; // 'HH:MM'
  temp_f: string;
  wind_mph: string;
  wind_direction: string;
  humidity_pct: string;
  source: WeatherSource | null;
  /** TRUE while the set still contains ANY modeled (Open-Meteo) reading — set on
   *  a fetch, and KEPT through a partial manual correction (the un-edited values
   *  are still modeled). Reset only when the set is emptied or fully re-fetched.
   *  Drives invalidate-on-field/date-change so a partially-edited auto set (whose
   *  `source` has flipped to 'manual') is still cleared rather than saved as
   *  current data for a new field/date. This is form state only — it never
   *  persists; the DB keeps just `source` ('auto' | 'manual'). */
  hasAutoData: boolean;
}

export const EMPTY_WEATHER_SET: WeatherSetForm = {
  time: '',
  temp_f: '',
  wind_mph: '',
  wind_direction: '',
  humidity_pct: '',
  source: null,
  hasAutoData: false,
};

/** A minimal view of the invoice row's structured-weather columns. */
export interface InvoiceWeatherRow {
  start_temp_f: number | null;
  start_wind_mph: number | null;
  start_wind_direction: string | null;
  start_humidity_pct: number | null;
  start_weather_time: string | null;
  start_weather_source: WeatherSource | null;
  end_temp_f: number | null;
  end_wind_mph: number | null;
  end_wind_direction: string | null;
  end_humidity_pct: number | null;
  end_weather_time: string | null;
  end_weather_source: WeatherSource | null;
  weather_manual_override: boolean | null;
}

const numToStr = (n: number | null | undefined): string =>
  n === null || n === undefined || Number.isNaN(n) ? '' : String(n);

/** A DB time may come back as 'HH:MM:SS'; an <input type="time"> wants 'HH:MM'. */
export function normalizeTimeForInput(t: string | null | undefined): string {
  if (!t) return '';
  const m = /^(\d{2}:\d{2})/.exec(t);
  return m ? m[1] : '';
}

/** Build a form set for START or END from the loaded invoice row.
 *
 *  `hasAutoData` is derived from the persisted `source` ('auto' ⇒ true). ACCEPTED
 *  LIMITATION: the DB stores only a single per-set `source` flag, not per-value
 *  provenance, so a set that was auto-filled then hand-corrected on ONE value is
 *  persisted as `source='manual'` and reloads with `hasAutoData=false`. After such
 *  a save+reload, a later field/date change won't auto-clear the remaining modeled
 *  readings (the in-session stale-data guard only covers the un-saved edit flow).
 *  This is intentional: the values were reviewed + committed by the user (the
 *  record is internally consistent and flagged 'manual'), and the modeled-not-
 *  measured disclaimer carries the verify-on-site obligation — far preferable to
 *  pessimistically wiping a user's saved manual corrections on every reload. */
export function weatherSetFromRow(row: InvoiceWeatherRow, set: 'start' | 'end'): WeatherSetForm {
  if (set === 'start') {
    return {
      time: normalizeTimeForInput(row.start_weather_time),
      temp_f: numToStr(row.start_temp_f),
      wind_mph: numToStr(row.start_wind_mph),
      wind_direction: row.start_wind_direction ?? '',
      humidity_pct: numToStr(row.start_humidity_pct),
      source: row.start_weather_source ?? null,
      hasAutoData: row.start_weather_source === 'auto',
    };
  }
  return {
    time: normalizeTimeForInput(row.end_weather_time),
    temp_f: numToStr(row.end_temp_f),
    wind_mph: numToStr(row.end_wind_mph),
    wind_direction: row.end_wind_direction ?? '',
    humidity_pct: numToStr(row.end_humidity_pct),
    source: row.end_weather_source ?? null,
    hasAutoData: row.end_weather_source === 'auto',
  };
}

/** The clock time the Open-Meteo helper falls back to when no time is given —
 *  midday (matches pickHourlyIndex's 720-minute default). Stamped into the form
 *  so an auto reading taken with a blank time still records WHICH hour it came
 *  from (compliance provenance) instead of saving weather with a null time. */
export const WEATHER_FALLBACK_TIME = '12:00';

/** Apply a fetched CapturedWeather onto a form set: fill the four readings and
 *  flag the set as 'auto'. Preserves an entered time; when the time was blank,
 *  stamps the midday fallback the fetch actually used so the saved record
 *  identifies the reading's hour. Mirrors AppliedRecordsManager.getWeather. */
export function applyCapturedWeather(prev: WeatherSetForm, w: CapturedWeather): WeatherSetForm {
  return {
    ...prev,
    time: prev.time.trim() === '' ? WEATHER_FALLBACK_TIME : prev.time,
    temp_f: String(w.temperature_f),
    wind_mph: String(w.wind_speed_mph),
    wind_direction: w.wind_direction,
    humidity_pct: String(w.humidity_pct),
    source: 'auto',
    hasAutoData: true,
  };
}

/** Apply a single manual edit to a form set: write the field and flip source to
 *  'manual' (any hand-edit means the value is no longer a pristine auto pull).
 *
 *  Special case — editing the TIME of an AUTO set: a modeled reading is keyed to
 *  its hour, so once the user moves the time the old temp/wind/humidity no longer
 *  describe that hour. Rather than silently keep stale modeled values under a new
 *  time label, clear the four readings (the user re-fetches for the new time);
 *  the new time is kept. Manual-source sets are user-typed, so their readings are
 *  left intact when the time changes. */
export function applyManualEdit(
  prev: WeatherSetForm,
  key: 'time' | 'temp_f' | 'wind_mph' | 'wind_direction' | 'humidity_pct',
  value: string,
): WeatherSetForm {
  if (key === 'time' && prev.source === 'auto') {
    return { ...EMPTY_WEATHER_SET, time: value };
  }
  return { ...prev, [key]: value, source: 'manual' };
}

/** A set is "entered" if any of its readings or its time has a value. Used to
 *  decide whether to persist a source flag at all (an untouched set stays null). */
export function weatherSetHasData(s: WeatherSetForm): boolean {
  return (
    s.time.trim() !== '' ||
    s.temp_f.trim() !== '' ||
    s.wind_mph.trim() !== '' ||
    s.wind_direction.trim() !== '' ||
    s.humidity_pct.trim() !== ''
  );
}

/** Parse a numeric string to a number, or null when blank/non-numeric. */
function parseNum(s: string): number | null {
  const t = s.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Parse an 'HH:MM' string to itself when valid, else null (blank or garbage). */
function parseTime(s: string): string | null {
  const t = s.trim();
  return /^\d{2}:\d{2}$/.test(t) ? t : null;
}

/** The structured-weather params for update_field_app_applied_info, derived from
 *  the two form sets. A blank field maps to null (clears the column). The source
 *  for each set is only sent when that set has data. */
export interface WeatherRpcParams {
  p_start_temp_f: number | null;
  p_start_wind_mph: number | null;
  p_start_wind_direction: string | null;
  p_start_humidity_pct: number | null;
  p_start_weather_time: string | null;
  p_start_weather_source: WeatherSource | null;
  p_end_temp_f: number | null;
  p_end_wind_mph: number | null;
  p_end_wind_direction: string | null;
  p_end_humidity_pct: number | null;
  p_end_weather_time: string | null;
  p_end_weather_source: WeatherSource | null;
  p_weather_manual_override: boolean;
}

/** weather_manual_override is true when EITHER set was last touched by hand
 *  (source 'manual') AND has data — i.e. the user overrode/typed a value
 *  rather than leaving a pristine auto pull. */
export function computeManualOverride(start: WeatherSetForm, end: WeatherSetForm): boolean {
  const startManual = start.source === 'manual' && weatherSetHasData(start);
  const endManual = end.source === 'manual' && weatherSetHasData(end);
  return startManual || endManual;
}

export function buildWeatherRpcParams(start: WeatherSetForm, end: WeatherSetForm): WeatherRpcParams {
  const startHas = weatherSetHasData(start);
  const endHas = weatherSetHasData(end);
  return {
    p_start_temp_f: parseNum(start.temp_f),
    p_start_wind_mph: parseNum(start.wind_mph),
    p_start_wind_direction: start.wind_direction.trim() === '' ? null : start.wind_direction.trim(),
    p_start_humidity_pct: parseNum(start.humidity_pct),
    p_start_weather_time: parseTime(start.time),
    p_start_weather_source: startHas ? (start.source ?? 'manual') : null,
    p_end_temp_f: parseNum(end.temp_f),
    p_end_wind_mph: parseNum(end.wind_mph),
    p_end_wind_direction: end.wind_direction.trim() === '' ? null : end.wind_direction.trim(),
    p_end_humidity_pct: parseNum(end.humidity_pct),
    p_end_weather_time: parseTime(end.time),
    p_end_weather_source: endHas ? (end.source ?? 'manual') : null,
    p_weather_manual_override: computeManualOverride(start, end),
  };
}

/** Invalidate an AUTO-sourced set when its lookup key (field + application date)
 *  changes: a modeled reading is keyed to a specific place + day, so once the
 *  date or field moves, the old auto readings no longer describe the new
 *  application and must not be saved as current compliance data. A set that holds
 *  ANY modeled value (hasAutoData) is reset to empty so the user re-fetches/types
 *  for the new key — INCLUDING a partially hand-corrected auto set (whose `source`
 *  has flipped to 'manual' but whose un-edited readings are still modeled). A set
 *  with no auto-derived data left (fully hand-entered, or already empty) is
 *  returned UNCHANGED — we never wipe purely hand-typed values. */
export function invalidateAutoWeather(s: WeatherSetForm): WeatherSetForm {
  if (!s.hasAutoData) return s;
  return { ...EMPTY_WEATHER_SET };
}

/** The mandatory compliance disclaimer shown wherever invoice weather is
 *  entered/displayed. Single source of truth so UI + tests can't drift. */
export const WEATHER_DISCLAIMER =
  'Weather is modeled, not measured — verify on-site before relying on it for compliance.';
