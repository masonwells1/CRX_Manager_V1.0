import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CsbLookupError,
  findCsbFeatureAt,
  loadCsbManifest,
  resetCsbCacheForTests,
  tileKeyForPoint,
} from './csbLookup';

const square = (minLng: number, minLat: number, size: number) => [[
  [minLng, minLat],
  [minLng + size, minLat],
  [minLng + size, minLat + size],
  [minLng, minLat + size],
  [minLng, minLat],
]];

function manifestFor(...keys: string[]) {
  return {
    tileSizeDeg: 0.5,
    dataset: 'USDA CSB test',
    generated: '2026-07-12',
    tiles: keys.map((key) => ({ key, count: 1, bytes: 100 })),
  };
}

function feature(id: string, acres: number, coordinates = square(0.1, 0.1, 0.2)) {
  return {
    type: 'Feature' as const,
    properties: { id, crop: 'Corn', acres },
    geometry: { type: 'Polygon' as const, coordinates },
  };
}

afterEach(() => {
  resetCsbCacheForTests();
  vi.useRealTimers();
});

describe('tileKeyForPoint', () => {
  it('floors coordinates to the 0.5 degree grid, including exact boundaries', () => {
    expect(tileKeyForPoint(-88.49, 39.49)).toBe('-88.5_39.0');
    expect(tileKeyForPoint(-88.5, 39)).toBe('-88.5_39.0');
    expect(tileKeyForPoint(-88.50001, 39.5)).toBe('-89.0_39.5');
    expect(tileKeyForPoint(0, 0)).toBe('0.0_0.0');
  });
});

describe('findCsbFeatureAt', () => {
  it('loads a manifest and tile once each, then serves later clicks from cache', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(manifestFor('0.0_0.0')), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        type: 'FeatureCollection',
        features: [feature('field-1', 10)],
      }), { status: 200 }));

    await expect(findCsbFeatureAt({ lng: 0.2, lat: 0.2 }, fetchMock)).resolves.toMatchObject({
      kind: 'hit', feature: { properties: { id: 'field-1' } },
    });
    await expect(findCsbFeatureAt({ lng: 0.25, lat: 0.25 }, fetchMock)).resolves.toMatchObject({ kind: 'hit' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe('/csb/manifest.json');
    expect(String(fetchMock.mock.calls[1][0])).toBe('/csb/csb_0.0_0.0.json');
  });

  it('distinguishes an area without a static tile from an empty point within a loaded tile', async () => {
    const noCoverageFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(manifestFor('1.0_1.0')), { status: 200 }),
    );
    await expect(findCsbFeatureAt({ lng: 0.1, lat: 0.1 }, noCoverageFetch)).resolves.toEqual({ kind: 'no-coverage' });
    expect(noCoverageFetch).toHaveBeenCalledTimes(1);

    resetCsbCacheForTests();
    const noFieldFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(manifestFor('0.0_0.0')), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ type: 'FeatureCollection', features: [feature('outside', 12)] }), { status: 200 }));
    await expect(findCsbFeatureAt({ lng: 0.45, lat: 0.45 }, noFieldFetch)).resolves.toEqual({ kind: 'no-field' });
  });

  it('uses a bbox prefilter and returns the smallest field containing the click', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(manifestFor('0.0_0.0')), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        type: 'FeatureCollection',
        features: [
          feature('outside-bbox', 1, square(0.7, 0.7, 0.1)),
          feature('large', 100, square(0.1, 0.1, 0.3)),
          feature('small', 20, square(0.15, 0.15, 0.1)),
        ],
      }), { status: 200 }));

    await expect(findCsbFeatureAt({ lng: 0.2, lat: 0.2 }, fetchMock)).resolves.toMatchObject({
      kind: 'hit', feature: { properties: { id: 'small' } },
    });
  });

  it('reports a ten-second tile timeout as a typed lookup error', async () => {
    vi.useFakeTimers();
    let tileStarted: () => void = () => undefined;
    const tileStart = new Promise<void>((resolve) => { tileStarted = resolve; });
    const fetchMock = vi.fn<typeof fetch>((url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === '/csb/manifest.json') {
        return Promise.resolve(new Response(JSON.stringify(manifestFor('0.0_0.0')), { status: 200 }));
      }
      tileStarted();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });

    const lookup = findCsbFeatureAt({ lng: 0.2, lat: 0.2 }, fetchMock);
    const timedOut = expect(lookup).rejects.toBeInstanceOf(CsbLookupError);
    await tileStart;
    await vi.advanceTimersByTimeAsync(10_000);
    await timedOut;
  });

  it('shares one in-flight manifest request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(manifestFor('0.0_0.0')), { status: 200 }),
    );
    await Promise.all([loadCsbManifest(fetchMock), loadCsbManifest(fetchMock)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
