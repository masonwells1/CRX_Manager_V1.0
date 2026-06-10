import { describe, it, expect, vi, afterEach } from 'vitest';
import { degreesToCardinal, parseCentroid, fetchCurrentWeather } from './weatherCapture';

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
