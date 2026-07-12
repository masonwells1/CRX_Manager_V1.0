import type { Feature, MultiPolygon, Polygon, Position } from 'geojson';

const CSB_TILE_SIZE_DEG = 0.5;
const CSB_LOOKUP_TIMEOUT_MS = 10_000;

export interface CsbFeatureProperties {
  id: string;
  crop: string;
  acres: number;
}

export type CsbFeature = Feature<Polygon | MultiPolygon, CsbFeatureProperties>;

interface CsbManifest {
  tileSizeDeg: number;
  dataset: string;
  generated: string;
  tiles: Array<{ key: string; count: number; bytes: number }>;
}

export type CsbLookupResult =
  | { kind: 'hit'; feature: CsbFeature }
  | { kind: 'no-coverage' }
  | { kind: 'no-field' };

export class CsbLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsbLookupError';
  }
}

interface IndexedCsbFeature {
  feature: CsbFeature;
  bounds: FeatureBounds;
}

let manifestCache: CsbManifest | null = null;
let manifestRequest: Promise<CsbManifest> | null = null;
const tileCache = new Map<string, IndexedCsbFeature[]>();
const tileRequests = new Map<string, Promise<IndexedCsbFeature[]>>();

function formatTileCoordinate(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Object.is(rounded, -0) ? '0.0' : rounded.toFixed(1);
}

/** Returns the southwest-corner CSB tile key for a WGS84 point. */
export function tileKeyForPoint(lng: number, lat: number): string {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    throw new CsbLookupError('A valid field location is required for USDA boundary lookup.');
  }
  const tileLng = Math.floor(lng / CSB_TILE_SIZE_DEG) * CSB_TILE_SIZE_DEG;
  const tileLat = Math.floor(lat / CSB_TILE_SIZE_DEG) * CSB_TILE_SIZE_DEG;
  return `${formatTileCoordinate(tileLng)}_${formatTileCoordinate(tileLat)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPosition(value: unknown): value is Position {
  return Array.isArray(value)
    && value.length >= 2
    && typeof value[0] === 'number'
    && Number.isFinite(value[0])
    && typeof value[1] === 'number'
    && Number.isFinite(value[1]);
}

function isRing(value: unknown): value is Position[] {
  return Array.isArray(value) && value.every(isPosition);
}

function isPolygonCoordinates(value: unknown): value is Position[][] {
  return Array.isArray(value) && value.every(isRing);
}

function isMultiPolygonCoordinates(value: unknown): value is Position[][][] {
  return Array.isArray(value) && value.every(isPolygonCoordinates);
}

function parseCsbFeature(value: unknown): CsbFeature | null {
  if (!isRecord(value) || value.type !== 'Feature' || !isRecord(value.properties) || !isRecord(value.geometry)) return null;
  const { id, crop, acres } = value.properties;
  if (typeof id !== 'string' || typeof crop !== 'string' || typeof acres !== 'number' || !Number.isFinite(acres)) return null;

  if (value.geometry.type === 'Polygon' && isPolygonCoordinates(value.geometry.coordinates)) {
    return {
      type: 'Feature',
      properties: { id, crop, acres },
      geometry: { type: 'Polygon', coordinates: value.geometry.coordinates },
    };
  }
  if (value.geometry.type === 'MultiPolygon' && isMultiPolygonCoordinates(value.geometry.coordinates)) {
    return {
      type: 'Feature',
      properties: { id, crop, acres },
      geometry: { type: 'MultiPolygon', coordinates: value.geometry.coordinates },
    };
  }
  return null;
}

function parseManifest(value: unknown): CsbManifest {
  if (!isRecord(value) || !Array.isArray(value.tiles)) {
    throw new CsbLookupError('USDA boundary manifest was unreadable.');
  }
  const tiles = value.tiles.flatMap((tile) => {
    if (!isRecord(tile) || typeof tile.key !== 'string') return [];
    return [{
      key: tile.key,
      count: typeof tile.count === 'number' ? tile.count : 0,
      bytes: typeof tile.bytes === 'number' ? tile.bytes : 0,
    }];
  });
  return {
    tileSizeDeg: typeof value.tileSizeDeg === 'number' ? value.tileSizeDeg : CSB_TILE_SIZE_DEG,
    dataset: typeof value.dataset === 'string' ? value.dataset : 'USDA CSB',
    generated: typeof value.generated === 'string' ? value.generated : '',
    tiles,
  };
}

function parseTile(value: unknown): IndexedCsbFeature[] {
  if (!isRecord(value) || value.type !== 'FeatureCollection' || !Array.isArray(value.features)) {
    throw new CsbLookupError('USDA boundary tile was unreadable.');
  }
  // Bounds are computed ONCE here so per-click hit-testing on a cached tile is
  // a cheap bbox scan, not a full geometry traversal of ~10k features.
  return value.features.flatMap((raw) => {
    const feature = parseCsbFeature(raw);
    if (!feature) return [];
    const bounds = featureBounds(feature);
    return bounds ? [{ feature, bounds }] : [];
  });
}

async function fetchJson(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMessage: string,
): Promise<unknown> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), CSB_LOOKUP_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new CsbLookupError(`USDA boundary lookup returned ${response.status}.`);
    return response.json();
  } catch (error: unknown) {
    if (error instanceof CsbLookupError) throw error;
    if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      throw new CsbLookupError(timeoutMessage);
    }
    throw new CsbLookupError('USDA boundary lookup could not be completed.');
  } finally {
    window.clearTimeout(timeoutId);
  }
}

/** Loads the static-tile manifest once per browser session. */
export async function loadCsbManifest(fetchImpl: typeof fetch = fetch): Promise<CsbManifest> {
  if (manifestCache) return manifestCache;
  if (!manifestRequest) {
    manifestRequest = fetchJson('/csb/manifest.json', fetchImpl, 'USDA boundary manifest timed out.')
      .then(parseManifest)
      .then((manifest) => {
        manifestCache = manifest;
        return manifest;
      })
      .catch((error: unknown) => {
        manifestRequest = null;
        throw error;
      });
  }
  return manifestRequest;
}

async function loadTile(key: string, fetchImpl: typeof fetch): Promise<IndexedCsbFeature[]> {
  const cached = tileCache.get(key);
  if (cached) return cached;
  const inflight = tileRequests.get(key);
  if (inflight) return inflight;

  const request = fetchJson(`/csb/csb_${key}.json`, fetchImpl, 'USDA boundary tile lookup timed out.')
    .then(parseTile)
    .then((features) => {
      tileCache.set(key, features);
      tileRequests.delete(key);
      return features;
    })
    .catch((error: unknown) => {
      tileRequests.delete(key);
      throw error;
    });
  tileRequests.set(key, request);
  return request;
}

interface FeatureBounds {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

function geometryPositions(geometry: Polygon | MultiPolygon): Position[] {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polygons.flatMap((polygon) => polygon.flat());
}

function featureBounds(feature: CsbFeature): FeatureBounds | null {
  const positions = geometryPositions(feature.geometry);
  if (positions.length === 0) return null;
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of positions) {
    minLng = Math.min(minLng, lng);
    minLat = Math.min(minLat, lat);
    maxLng = Math.max(maxLng, lng);
    maxLat = Math.max(maxLat, lat);
  }
  return { minLng, minLat, maxLng, maxLat };
}

function isPointOnSegment(point: Position, start: Position, end: Position): boolean {
  const [x, y] = point;
  const [x1, y1] = start;
  const [x2, y2] = end;
  const cross = (x - x1) * (y2 - y1) - (y - y1) * (x2 - x1);
  if (Math.abs(cross) > 1e-12) return false;
  return x >= Math.min(x1, x2) && x <= Math.max(x1, x2) && y >= Math.min(y1, y2) && y <= Math.max(y1, y2);
}

/** Pure ray-casting point-in-ring test; points on an edge count as inside. */
function pointInRing(point: Position, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const current = ring[i];
    const previous = ring[j];
    if (isPointOnSegment(point, previous, current)) return true;
    const intersects = (current[1] > point[1]) !== (previous[1] > point[1])
      && point[0] < ((previous[0] - current[0]) * (point[1] - current[1])) / (previous[1] - current[1]) + current[0];
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point: Position, polygon: Position[][]): boolean {
  if (!polygon[0] || !pointInRing(point, polygon[0])) return false;
  return !polygon.slice(1).some((hole) => pointInRing(point, hole));
}

function featureContainsPoint(feature: CsbFeature, point: Position): boolean {
  const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  return polygons.some((polygon) => pointInPolygon(point, polygon));
}

/**
 * Finds the smallest USDA CSB field containing a click. The result differentiates a missing
 * static tile from a point that simply does not land inside a USDA boundary.
 */
export async function findCsbFeatureAt(
  lngLat: { lng: number; lat: number },
  fetchImpl: typeof fetch = fetch,
): Promise<CsbLookupResult> {
  const key = tileKeyForPoint(lngLat.lng, lngLat.lat);
  const manifest = await loadCsbManifest(fetchImpl);
  if (!manifest.tiles.some((tile) => tile.key === key)) return { kind: 'no-coverage' };

  const point: Position = [lngLat.lng, lngLat.lat];
  const candidatesById = new Map<string, CsbFeature>();
  for (const { feature, bounds } of await loadTile(key, fetchImpl)) {
    if (point[0] < bounds.minLng || point[0] > bounds.maxLng
      || point[1] < bounds.minLat || point[1] > bounds.maxLat
      || !featureContainsPoint(feature, point)) continue;

    const existing = candidatesById.get(feature.properties.id);
    if (!existing || feature.properties.acres < existing.properties.acres) {
      candidatesById.set(feature.properties.id, feature);
    }
  }

  const feature = [...candidatesById.values()].sort((a, b) => a.properties.acres - b.properties.acres)[0];
  return feature ? { kind: 'hit', feature } : { kind: 'no-field' };
}

/** Test-only reset for the module-level manifest and tile caches. */
export function resetCsbCacheForTests(): void {
  manifestCache = null;
  manifestRequest = null;
  tileCache.clear();
  tileRequests.clear();
}
