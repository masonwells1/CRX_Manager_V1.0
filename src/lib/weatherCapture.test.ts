import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  degreesToCardinal,
  parseCentroid,
  fetchCurrentWeather,
  pickHourlyIndex,
  mapHourlyAt,
  fetchWeatherForDateTime,
} from './weatherCapture';

vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn() } }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('degreesToCardinal', () => {
  it('maps the principal directions', () => {
    expect(degreesToCardinal(0)).toBe('N');
    expect(degreesToCardinal(90)).toBe('E');
    expect(degreesToCardinal(180)).toBe('S');
    expect(degreesToCardinal(270)).toBe('W');
  });

  it('maps intermediate directions and wraps', () => {
    expect(degreesToCardinal(337.5)).toBe('NNW');
    expect(degreesToCardinal(360)).toBe('N');
    expect(degreesToCardinal(720 + 45)).toBe('NE');
    expect(degreesToCardinal(-90)).toBe('W');
  });
});

describe('parseCentroid', () => {
  it('parses a GeoJSON Point ([lng, lat] order)', () => {
    expect(parseCentroid('{"type":"Point","coordinates":[-89.5,40.1]}')).toEqual({ lat: 40.1, lng: -89.5 });
  });

  it('returns null for missing/garbage input', () => {
    expect(parseCentroid(null)).toBeNull();
    expect(parseCentroid(undefined)).toBeNull();
    expect(parseCentroid('not json')).toBeNull();
    expect(parseCentroid('{"type":"Polygon","coordinates":[]}')).toBeNull();
  });
});

describe('fetchCurrentWeather', () => {
  it('maps a successful Open-Meteo response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        current: { temperature_2m: 72.6, relative_humidity_2m: 54.2, wind_speed_10m: 8.34, wind_direction_10m: 200 },
      }),
    }));
    const w = await fetchCurrentWeather(40.1, -89.5);
    expect(w).toEqual({ temperature_f: 73, wind_speed_mph: 8.3, wind_direction: 'SSW', humidity_pct: 54 });
  });

  it('returns null on HTTP failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    expect(await fetchCurrentWeather(40, -89)).toBeNull();
  });

  it('returns null on malformed payload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ current: { temperature_2m: 'hot' } }) }));
    expect(await fetchCurrentWeather(40, -89)).toBeNull();
  });

  it('returns null (not throw) on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await fetchCurrentWeather(40, -89)).toBeNull();
  });
});

// ── #19 date + time-keyed hourly lookup ──────────────────────────────────────

const HOURS = ['2026-06-22T07:00', '2026-06-22T08:00', '2026-06-22T09:00', '2026-06-22T10:00'];

describe('pickHourlyIndex', () => {
  it('picks the hour nearest the requested time', () => {
    expect(pickHourlyIndex(HOURS, '08:10')).toBe(1); // 08:00 is closest
    expect(pickHourlyIndex(HOURS, '09:40')).toBe(3); // 10:00 is closest
  });

  it('defaults to midday-ish when no time is given (nearest available to 12:00)', () => {
    expect(pickHourlyIndex(HOURS, null)).toBe(3); // 10:00 is the closest to 12:00 in this block
  });

  it('returns -1 for an empty/missing block', () => {
    expect(pickHourlyIndex([], '08:00')).toBe(-1);
    expect(pickHourlyIndex(undefined, '08:00')).toBe(-1);
  });
});

describe('mapHourlyAt', () => {
  const hourly = {
    time: HOURS,
    temperature_2m: [60, 64.6, 68, 71],
    relative_humidity_2m: [80, 74.2, 70, 66],
    wind_speed_10m: [5, 8.34, 11, 13],
    wind_direction_10m: [10, 200, 210, 220],
  };

  it('maps a slice, rounding like the current-conditions path', () => {
    expect(mapHourlyAt(hourly, 1)).toEqual({ temperature_f: 65, wind_speed_mph: 8.3, wind_direction: 'SSW', humidity_pct: 74 });
  });

  it('returns null for an out-of-range or null-containing slice', () => {
    expect(mapHourlyAt({ ...hourly, temperature_2m: [null, null, null, null] }, 1)).toBeNull();
    expect(mapHourlyAt(hourly, -1)).toBeNull();
  });
});

describe('fetchWeatherForDateTime', () => {
  it('fetches hourly data for a date and maps the nearest hour', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        hourly: {
          time: HOURS,
          temperature_2m: [60, 64.6, 68, 71],
          relative_humidity_2m: [80, 74.2, 70, 66],
          wind_speed_10m: [5, 8.34, 11, 13],
          wind_direction_10m: [10, 200, 210, 220],
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const w = await fetchWeatherForDateTime(40.1, -89.5, '2026-06-22', '08:00');
    expect(w).toEqual({ temperature_f: 65, wind_speed_mph: 8.3, wind_direction: 'SSW', humidity_pct: 74 });
    // Stays on the whitelisted forecast host with a single-day window.
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('https://api.open-meteo.com/v1/forecast');
    expect(url).toContain('start_date=2026-06-22');
    expect(url).toContain('end_date=2026-06-22');
  });

  it('returns null for a bad date string without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchWeatherForDateTime(40, -89, 'not-a-date', '08:00')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null on HTTP failure / missing hourly / network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    expect(await fetchWeatherForDateTime(40, -89, '2026-06-22', '08:00')).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    expect(await fetchWeatherForDateTime(40, -89, '2026-06-22', '08:00')).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await fetchWeatherForDateTime(40, -89, '2026-06-22', '08:00')).toBeNull();
  });
});
