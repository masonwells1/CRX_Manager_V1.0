/**
 * weatherCapture.ts — current-conditions lookup for application records (deep-dive H1 C4).
 *
 * Replaces hand-typed wind/temp/humidity at job completion with a one-tap fetch
 * from Open-Meteo (free, keyless, CORS-enabled; whitelisted in vercel.json CSP).
 * Returns null on any failure — weather prefill is a convenience, never a gate.
 */
import { Sentry } from './sentry';

export interface CapturedWeather {
  temperature_f: number;
  wind_speed_mph: number;
  wind_direction: string; // cardinal, e.g. 'NNW'
  humidity_pct: number;
}

const CARDINALS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'] as const;

/** 0–360° → 16-point cardinal. Exported for tests. */
export function degreesToCardinal(deg: number): string {
  const normalized = ((deg % 360) + 360) % 360;
  return CARDINALS[Math.round(normalized / 22.5) % 16];
}

/** Parse a GeoJSON Point string into [lat, lng]. Returns null when unusable. */
export function parseCentroid(centroidGeojson: string | null | undefined): { lat: number; lng: number } | null {
  if (!centroidGeojson) return null;
  try {
    const g = typeof centroidGeojson === 'string' ? JSON.parse(centroidGeojson) : centroidGeojson;
    if (g?.type === 'Point' && Array.isArray(g.coordinates) && g.coordinates.length >= 2) {
      const [lng, lat] = g.coordinates;
      if (typeof lat === 'number' && typeof lng === 'number') return { lat, lng };
    }
  } catch {
    // fall through to null
  }
  return null;
}

export async function fetchCurrentWeather(lat: number, lng: number): Promise<CapturedWeather | null> {
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
      `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m` +
      `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json()) as {
      current?: { temperature_2m?: number; relative_humidity_2m?: number; wind_speed_10m?: number; wind_direction_10m?: number };
    };
    const c = json.current;
    if (
      !c ||
      typeof c.temperature_2m !== 'number' ||
      typeof c.relative_humidity_2m !== 'number' ||
      typeof c.wind_speed_10m !== 'number' ||
      typeof c.wind_direction_10m !== 'number'
    ) {
      return null;
    }
    return {
      temperature_f: Math.round(c.temperature_2m),
      wind_speed_mph: Math.round(c.wind_speed_10m * 10) / 10,
      wind_direction: degreesToCardinal(c.wind_direction_10m),
      humidity_pct: Math.round(c.relative_humidity_2m),
    };
  } catch (err) {
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'weather_capture' } });
    return null;
  }
}

// ── Date + time-keyed weather (field-app #19 START/END pair) ────────────────
//
// ChemMan's "Get Weather" pulls the conditions for the application DATE + the
// chosen TIME (start or end of the spray window) at the field location. The
// existing fetchCurrentWeather is current-conditions only, so this adds an
// hourly lookup. It stays on the SAME whitelisted host (api.open-meteo.com — the
// /v1/forecast endpoint also serves hourly data for recent past dates and the
// near future via start_date/end_date, so no new CSP entry is needed and the
// free/keyless Open-Meteo rule is preserved). Returns null on any failure so the
// caller falls back to manual entry — weather is never a save gate.

/** Open-Meteo hourly timestamps are 'YYYY-MM-DDTHH:MM' (no zone, field-local via timezone=auto). */
interface HourlyBlock {
  time?: string[];
  temperature_2m?: (number | null)[];
  relative_humidity_2m?: (number | null)[];
  wind_speed_10m?: (number | null)[];
  wind_direction_10m?: (number | null)[];
}

/**
 * Pick the hourly index whose timestamp is closest to the target 'HH:MM' on the
 * requested date. When no time is given, default to the top of midday (12:00) —
 * a representative daytime reading. Exported for tests.
 * Returns -1 when the block has no usable times.
 */
export function pickHourlyIndex(times: string[] | undefined, targetHHMM: string | null): number {
  if (!times || times.length === 0) return -1;
  // Minutes-from-midnight of the target; midday (720) when unspecified/garbage.
  const targetMin = (() => {
    if (!targetHHMM) return 720;
    const m = /^(\d{1,2}):(\d{2})/.exec(targetHHMM);
    if (!m) return 720;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (!Number.isFinite(h) || !Number.isFinite(min)) return 720;
    return h * 60 + min;
  })();
  let bestIdx = 0;
  let bestDelta = Infinity;
  for (let i = 0; i < times.length; i++) {
    const t = /T(\d{2}):(\d{2})/.exec(times[i] ?? '');
    if (!t) continue;
    const min = Number(t[1]) * 60 + Number(t[2]);
    const delta = Math.abs(min - targetMin);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIdx = i;
    }
  }
  return bestDelta === Infinity ? -1 : bestIdx;
}

/**
 * Map a single hourly slice of an Open-Meteo block into CapturedWeather. Returns
 * null when any of the four readings is missing/non-numeric at that index.
 * Exported for tests.
 */
export function mapHourlyAt(hourly: HourlyBlock, idx: number): CapturedWeather | null {
  if (idx < 0) return null;
  const temp = hourly.temperature_2m?.[idx];
  const hum = hourly.relative_humidity_2m?.[idx];
  const spd = hourly.wind_speed_10m?.[idx];
  const dir = hourly.wind_direction_10m?.[idx];
  if (
    typeof temp !== 'number' ||
    typeof hum !== 'number' ||
    typeof spd !== 'number' ||
    typeof dir !== 'number'
  ) {
    return null;
  }
  return {
    temperature_f: Math.round(temp),
    wind_speed_mph: Math.round(spd * 10) / 10,
    wind_direction: degreesToCardinal(dir),
    humidity_pct: Math.round(hum),
  };
}

/**
 * Fetch the weather for a specific date (YYYY-MM-DD) and clock time (HH:MM, may
 * be null) at a field location. Uses the whitelisted api.open-meteo.com forecast
 * endpoint with hourly data for that single day, then picks the hour nearest the
 * requested time. Returns null on any failure (offline, no data, bad payload) so
 * the caller can fall back to manual entry.
 */
export async function fetchWeatherForDateTime(
  lat: number,
  lng: number,
  dateISO: string,
  timeHHMM: string | null,
): Promise<CapturedWeather | null> {
  // A valid YYYY-MM-DD date is required to key the hourly lookup.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return null;
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
      `&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m` +
      `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto` +
      `&start_date=${dateISO}&end_date=${dateISO}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json()) as { hourly?: HourlyBlock };
    const hourly = json.hourly;
    if (!hourly) return null;
    const idx = pickHourlyIndex(hourly.time, timeHHMM);
    return mapHourlyAt(hourly, idx);
  } catch (err) {
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'weather_capture_datetime' } });
    return null;
  }
}
