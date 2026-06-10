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
