import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRpc, mockFrom, mockIn, mockEq } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockFrom: vi.fn(),
  mockIn: vi.fn(),
  mockEq: vi.fn(),
}));

vi.mock('./db', () => ({
  supabase: { rpc: mockRpc, from: mockFrom },
  assertRpcResult: <T,>(data: unknown): T => data as T,
}));

import { fetchJobMapImages } from './jobMapImages';

const squareBoundary = JSON.stringify({
  type: 'Polygon',
  coordinates: [[[-89.1, 39.1], [-89.0, 39.1], [-89.0, 39.2], [-89.1, 39.2], [-89.1, 39.1]]],
});

function makeRow(boundary = squareBoundary, centroid: [number, number] = [-89.05, 39.15]) {
  return {
    id: 'field-1',
    customer_id: 'customer-1',
    field_name: 'North 40',
    total_acres: 40,
    measured_acres: 41.25,
    override_acres: null,
    centroid_geojson: JSON.stringify({ type: 'Point', coordinates: centroid }),
    boundary_geojson: boundary,
    sort_order: 0,
  };
}

function setupRpc(boundary = squareBoundary, centroid?: [number, number], acresToTreat: number | null = 10): void {
  mockRpc.mockResolvedValue({ data: [makeRow(boundary, centroid)], error: null });
  mockFrom.mockImplementation((table: string) => {
    if (table === 'job_fields') {
      return { select: vi.fn().mockReturnValue({ eq: mockEq }) };
    }
    return { select: vi.fn().mockReturnValue({ in: mockIn }) };
  });
  mockEq.mockResolvedValue({ data: [{ field_id: 'field-1', acres_to_treat: acresToTreat }], error: null });
  mockIn.mockResolvedValue({ data: [{ id: 'customer-1', farm_name: 'Smith Farm' }], error: null });
}

describe('fetchJobMapImages', () => {
  const originalToken = import.meta.env.VITE_MAPBOX_TOKEN;

  beforeEach(() => {
    vi.clearAllMocks();
    import.meta.env.VITE_MAPBOX_TOKEN = 'test-mapbox-token';
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    import.meta.env.VITE_MAPBOX_TOKEN = originalToken;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('builds a satellite-streets URL with yellow GeoJSON boundaries and converts its PNG response to a data URL', async () => {
    setupRpc();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new Blob(['png'], { type: 'image/png' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchJobMapImages('job-1', { perField: false });

    expect(mockRpc).toHaveBeenCalledWith('get_job_fields_with_geojson', { p_job_id: 'job-1' });
    expect(mockEq).toHaveBeenCalledWith('job_id', 'job-1');
    expect(result?.overview).toBe('data:image/png;base64,cG5n');
    expect(result?.perField).toEqual([]);
    const url = String(mockFetch.mock.calls[0][0]);
    expect(url).toContain('/mapbox/satellite-streets-v12/static/geojson(');
    expect(url).toMatch(/\/auto\/\d+x\d+\?access_token=test-mapbox-token&padding=40/);
    const encodedOverlay = url.match(/geojson\((.+)\)\/auto/);
    expect(encodedOverlay).not.toBeNull();
    const overlay = JSON.parse(decodeURIComponent(encodedOverlay?.[1] ?? '')) as {
      features: Array<{ properties: Record<string, string | number> }>;
    };
    expect(overlay.features[0].properties).toMatchObject({
      stroke: '#FFD700',
      'stroke-width': 3,
      fill: '#FFD700',
      'fill-opacity': 0.15,
    });
  });

  it('uses the job field acres for each printed field map', async () => {
    setupRpc();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new Blob(['png'], { type: 'image/png' }),
    }));

    const result = await fetchJobMapImages('job-1', { overview: false });

    expect(result?.perField).toHaveLength(1);
    expect(result?.perField[0].acres).toBe(10);
  });

  it('draws an overview acreage label at the Mercator-matched position for a non-square bbox', async () => {
    const minLatitude = 39;
    const maxLatitude = 39.1;
    const mercatorY = (latitude: number) => {
      const radians = latitude * Math.PI / 180;
      return (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2;
    };
    const latitudeForMercatorY = (y: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI;
    const centroid: [number, number] = [
      -89.85,
      latitudeForMercatorY((mercatorY(minLatitude) + mercatorY(maxLatitude)) / 2),
    ];
    const nonSquareBoundary = JSON.stringify({
      type: 'Polygon',
      coordinates: [[[-90, minLatitude], [-89.7, minLatitude], [-89.7, maxLatitude], [-90, maxLatitude], [-90, minLatitude]]],
    });
    setupRpc(nonSquareBoundary, centroid);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new Blob(['png'], { type: 'image/png' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const context = {
      drawImage: vi.fn(),
      measureText: vi.fn(() => ({ width: 48 })),
      fillRect: vi.fn(),
      fillText: vi.fn(),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,bGFiZWxlZA==');
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ close: vi.fn() }));

    const result = await fetchJobMapImages('job-1', { perField: false });

    expect(result?.overview).toBe('data:image/png;base64,bGFiZWxlZA==');
    const url = String(mockFetch.mock.calls[0][0]);
    const size = url.match(/\/auto\/(\d+)x(\d+)\?/);
    expect(size).not.toBeNull();
    const width = Number(size?.[1]);
    const height = Number(size?.[2]);
    expect(width / height).toBeGreaterThan(2);
    const [text, x, y] = context.fillText.mock.calls[0] as [string, number, number];
    expect(text).toBe('10 ac');
    expect(Math.abs(x - width / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(y - height / 2)).toBeLessThanOrEqual(1);
  });

  it('omits acreage when the job-field acreage query fails', async () => {
    setupRpc();
    mockEq.mockResolvedValue({ data: null, error: new Error('job_fields unavailable') });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new Blob(['png'], { type: 'image/png' }),
    }));

    const result = await fetchJobMapImages('job-1', { overview: false });

    expect(result?.perField[0].acres).toBeNull();
  });

  it('returns null when a hanging Mapbox request reaches the ten-second timeout', async () => {
    vi.useFakeTimers();
    setupRpc();
    let notifyFetchStarted: () => void = () => undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      notifyFetchStarted = resolve;
    });
    const mockFetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      notifyFetchStarted();
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('Request aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }));
    vi.stubGlobal('fetch', mockFetch);

    const result = fetchJobMapImages('job-1', { perField: false });
    await fetchStarted;
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(result).resolves.toBeNull();
    expect(console.warn).toHaveBeenCalledWith(
      'Timed out fetching overview field map after 10 seconds.',
      expect.objectContaining({ name: 'AbortError' }),
    );
  });

  it('keeps the original geometry when its URL already fits within the Mapbox limit', async () => {
    const originalCoordinates = [
      [-89.1, 39.1],
      [-89.075, 39.1],
      [-89.0, 39.1],
      [-89.0, 39.2],
      [-89.1, 39.2],
      [-89.1, 39.1],
    ];
    setupRpc(JSON.stringify({ type: 'Polygon', coordinates: [originalCoordinates] }));
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new Blob(['png'], { type: 'image/png' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await fetchJobMapImages('job-1', { perField: false });

    const url = String(mockFetch.mock.calls[0][0]);
    const encodedOverlay = url.match(/geojson\((.+)\)\/auto/);
    const overlay = JSON.parse(decodeURIComponent(encodedOverlay?.[1] ?? '')) as {
      features: Array<{ geometry: { coordinates: number[][][] } }>;
    };
    expect(overlay.features[0].geometry.coordinates[0]).toEqual(originalCoordinates);
  });

  it('does not call Supabase or Mapbox when no token is configured', async () => {
    import.meta.env.VITE_MAPBOX_TOKEN = '';
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    await expect(fetchJobMapImages('job-1')).resolves.toBeNull();

    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('guards Mapbox against an un-simplifiable oversized polygon instead of requesting an overlong URL', async () => {
    const vertices = Array.from({ length: 1_500 }, (_, index) => [
      -89 + (index % 2 === 0 ? 0 : 0.02),
      39 + index * 0.00001,
    ]);
    vertices.push(vertices[0]);
    setupRpc(JSON.stringify({ type: 'Polygon', coordinates: [vertices] }));
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchJobMapImages('job-1', { perField: false });

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
