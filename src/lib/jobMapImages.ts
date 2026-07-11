/**
 * Fetch static satellite map images for the selected fields on one job.
 *
 * This module intentionally has no React or PDF dependency. It gets geometry from
 * the job-scoped RPC, reduces it when needed to stay within Mapbox's static-image
 * URL limit, and returns PNG data URLs that a PDF renderer can draw directly.
 */
import { supabase, assertRpcResult } from './db';

const MAPBOX_STYLE = 'mapbox/satellite-streets-v12';
const MAPBOX_STATIC_URL = `https://api.mapbox.com/styles/v1/${MAPBOX_STYLE}/static`;
const MAX_STATIC_URL_LENGTH = 8_000;
const SIMPLIFY_TOLERANCES = [0, 0.00005, 0.0001, 0.0005, 0.001];
const MAPBOX_FETCH_TIMEOUT_MS = 10_000;

export interface JobFieldMapImage {
  fieldId: string;
  fieldName: string;
  customerName: string | null;
  acres: number | null;
  centroidLat: number | null;
  centroidLng: number | null;
  dataUrl: string;
}

export interface JobMapImages {
  overview: string | null;
  perField: JobFieldMapImage[];
}

/** Exactly the columns get_job_fields_with_geojson returns. */
interface JobMapFieldRow {
  id: string;
  customer_id: string;
  field_name: string;
  total_acres: number | null;
  measured_acres: number | null;
  override_acres: number | null;
  centroid_geojson: string | null;
  boundary_geojson: string | null;
  sort_order: number | null;
}

interface JobFieldAcresRow {
  field_id: string | null;
  acres_to_treat: number | null;
}

type Position = [number, number, ...number[]];

interface PointGeometry {
  type: 'Point';
  coordinates: Position;
}

interface LineStringGeometry {
  type: 'LineString';
  coordinates: Position[];
}

interface PolygonGeometry {
  type: 'Polygon';
  coordinates: Position[][];
}

interface MultiPointGeometry {
  type: 'MultiPoint';
  coordinates: Position[];
}

interface MultiLineStringGeometry {
  type: 'MultiLineString';
  coordinates: Position[][];
}

interface MultiPolygonGeometry {
  type: 'MultiPolygon';
  coordinates: Position[][][];
}

interface GeometryCollectionGeometry {
  type: 'GeometryCollection';
  geometries: GeoJsonGeometry[];
}

type GeoJsonGeometry =
  | PointGeometry
  | LineStringGeometry
  | PolygonGeometry
  | MultiPointGeometry
  | MultiLineStringGeometry
  | MultiPolygonGeometry
  | GeometryCollectionGeometry;

interface BoundaryFeature {
  type: 'Feature';
  properties: Record<string, string | number>;
  geometry: GeoJsonGeometry;
}

interface BoundaryFeatureCollection {
  type: 'FeatureCollection';
  features: BoundaryFeature[];
}

interface ParsedJobField {
  id: string;
  name: string;
  customerId: string;
  acres: number | null;
  centroidLat: number | null;
  centroidLng: number | null;
  geometry: GeoJsonGeometry;
}

interface BuildStaticUrlOptions {
  width: number;
  height: number;
  padding: number;
  token: string;
}

interface StaticImageBuild {
  url: string;
  /** The exact simplified GeoJSON encoded in `url`. */
  features: BoundaryFeature[];
}

interface GeometryBounds {
  minLongitude: number;
  maxLongitude: number;
  minMercatorLatitude: number;
  maxMercatorLatitude: number;
}

interface AcreageLabel {
  lat: number;
  lng: number;
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPosition(value: unknown): value is Position {
  return Array.isArray(value)
    && value.length >= 2
    && typeof value[0] === 'number'
    && Number.isFinite(value[0])
    && typeof value[1] === 'number'
    && Number.isFinite(value[1])
    && value.slice(2).every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate));
}

function isPositionArray(value: unknown): value is Position[] {
  return Array.isArray(value) && value.every(isPosition);
}

function isPositionArrayArray(value: unknown): value is Position[][] {
  return Array.isArray(value) && value.every(isPositionArray);
}

function isPositionArrayArrayArray(value: unknown): value is Position[][][] {
  return Array.isArray(value) && value.every(isPositionArrayArray);
}

function parseGeometry(value: unknown): GeoJsonGeometry | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;

  switch (value.type) {
    case 'Point':
      return isPosition(value.coordinates) ? { type: 'Point', coordinates: value.coordinates } : null;
    case 'LineString':
      return isPositionArray(value.coordinates) && value.coordinates.length >= 2
        ? { type: 'LineString', coordinates: value.coordinates }
        : null;
    case 'Polygon':
      return isPositionArrayArray(value.coordinates) && value.coordinates.every((ring) => ring.length >= 4)
        ? { type: 'Polygon', coordinates: value.coordinates }
        : null;
    case 'MultiPoint':
      return isPositionArray(value.coordinates) ? { type: 'MultiPoint', coordinates: value.coordinates } : null;
    case 'MultiLineString':
      return isPositionArrayArray(value.coordinates) && value.coordinates.every((line) => line.length >= 2)
        ? { type: 'MultiLineString', coordinates: value.coordinates }
        : null;
    case 'MultiPolygon':
      return isPositionArrayArrayArray(value.coordinates)
        && value.coordinates.every((polygon) => polygon.every((ring) => ring.length >= 4))
        ? { type: 'MultiPolygon', coordinates: value.coordinates }
        : null;
    case 'GeometryCollection': {
      if (!Array.isArray(value.geometries)) return null;
      const geometries = value.geometries.map(parseGeometry).filter((geometry): geometry is GeoJsonGeometry => geometry !== null);
      return geometries.length > 0 ? { type: 'GeometryCollection', geometries } : null;
    }
    default:
      return null;
  }
}

function parseGeoJsonGeometry(raw: string | null): GeoJsonGeometry | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && parsed.type === 'Feature') return parseGeometry(parsed.geometry);
    return parseGeometry(parsed);
  } catch {
    return null;
  }
}

function centroidFromGeoJson(raw: string | null): { lat: number | null; lng: number | null } {
  const geometry = parseGeoJsonGeometry(raw);
  if (!geometry || geometry.type !== 'Point') return { lat: null, lng: null };
  return { lat: geometry.coordinates[1], lng: geometry.coordinates[0] };
}

function distanceToSegment(point: Position, start: Position, end: Position): number {
  const deltaX = end[0] - start[0];
  const deltaY = end[1] - start[1];
  if (deltaX === 0 && deltaY === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  const ratio = Math.max(0, Math.min(1, ((point[0] - start[0]) * deltaX + (point[1] - start[1]) * deltaY) / (deltaX * deltaX + deltaY * deltaY)));
  return Math.hypot(point[0] - (start[0] + ratio * deltaX), point[1] - (start[1] + ratio * deltaY));
}

/** A small local Douglas-Peucker implementation; @turf/simplify is not installed. */
function simplifyLine(points: Position[], tolerance: number): Position[] {
  if (points.length <= 2 || tolerance <= 0) return points;
  let greatestDistance = 0;
  let greatestIndex = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    const distance = distanceToSegment(points[index], points[0], points[points.length - 1]);
    if (distance > greatestDistance) {
      greatestDistance = distance;
      greatestIndex = index;
    }
  }
  if (greatestDistance <= tolerance) return [points[0], points[points.length - 1]];
  return [
    ...simplifyLine(points.slice(0, greatestIndex + 1), tolerance).slice(0, -1),
    ...simplifyLine(points.slice(greatestIndex), tolerance),
  ];
}

function samePosition(first: Position, second: Position): boolean {
  return first[0] === second[0] && first[1] === second[1];
}

function simplifyRing(ring: Position[], tolerance: number): Position[] {
  const closed = ring.length > 1 && samePosition(ring[0], ring[ring.length - 1]);
  const openRing = closed ? ring.slice(0, -1) : ring;
  const simplified = simplifyLine(openRing, tolerance);
  // A polygon ring must retain at least three vertices plus the closing vertex.
  if (simplified.length < 3) return ring;
  return [...simplified, simplified[0]];
}

function simplifyGeometry(geometry: GeoJsonGeometry, tolerance: number): GeoJsonGeometry {
  switch (geometry.type) {
    case 'LineString':
      return { ...geometry, coordinates: simplifyLine(geometry.coordinates, tolerance) };
    case 'Polygon':
      return { ...geometry, coordinates: geometry.coordinates.map((ring) => simplifyRing(ring, tolerance)) };
    case 'MultiLineString':
      return { ...geometry, coordinates: geometry.coordinates.map((line) => simplifyLine(line, tolerance)) };
    case 'MultiPolygon':
      return {
        ...geometry,
        coordinates: geometry.coordinates.map((polygon) => polygon.map((ring) => simplifyRing(ring, tolerance))),
      };
    case 'GeometryCollection':
      return { ...geometry, geometries: geometry.geometries.map((child) => simplifyGeometry(child, tolerance)) };
    default:
      return geometry;
  }
}

function positionsInGeometry(geometry: GeoJsonGeometry): Position[] {
  switch (geometry.type) {
    case 'Point':
      return [geometry.coordinates];
    case 'LineString':
    case 'MultiPoint':
      return geometry.coordinates;
    case 'Polygon':
    case 'MultiLineString':
      return geometry.coordinates.flat();
    case 'MultiPolygon':
      return geometry.coordinates.flat(2);
    case 'GeometryCollection':
      return geometry.geometries.flatMap(positionsInGeometry);
  }
}

function boundaryFeature(field: ParsedJobField, includeFill: boolean, tolerance: number): BoundaryFeature {
  const properties: Record<string, string | number> = {
    stroke: '#FFD700',
    'stroke-width': 3,
  };
  if (includeFill) {
    properties.fill = '#FFD700';
    properties['fill-opacity'] = 0.15;
  }
  return { type: 'Feature', properties, geometry: simplifyGeometry(field.geometry, tolerance) };
}

function staticImageUrl(features: BoundaryFeature[], options: BuildStaticUrlOptions): string {
  const collection: BoundaryFeatureCollection = { type: 'FeatureCollection', features };
  const encodedOverlay = encodeURIComponent(JSON.stringify(collection));
  return `${MAPBOX_STATIC_URL}/geojson(${encodedOverlay})/auto/${options.width}x${options.height}?access_token=${encodeURIComponent(options.token)}&padding=${options.padding}`;
}

function buildStaticImageUrl(fields: ParsedJobField[], options: BuildStaticUrlOptions): StaticImageBuild | null {
  for (const includeFill of [true, false]) {
    const features = fields.map((field) => boundaryFeature(field, includeFill, 0));
    const url = staticImageUrl(features, options);
    if (url.length <= MAX_STATIC_URL_LENGTH) return { url, features };
  }
  for (const includeFill of [true, false]) {
    for (const tolerance of SIMPLIFY_TOLERANCES.slice(1)) {
      const features = fields.map((field) => boundaryFeature(field, includeFill, tolerance));
      const url = staticImageUrl(features, options);
      if (url.length <= MAX_STATIC_URL_LENGTH) return { url, features };
    }
  }
  return null;
}

function clampDimension(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(1280, Math.round(value));
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('Map image could not be converted to a data URL'));
    reader.onerror = () => reject(reader.error ?? new Error('Map image could not be read'));
    reader.readAsDataURL(blob.type ? blob : new Blob([blob], { type: 'image/png' }));
  });
}

/**
 * Web-Mercator Y scaled to the same 360-degree world width as longitude. Using
 * this scale (rather than normalized 0..1 Y) keeps X/Y bbox aspect ratios valid.
 */
function mapMercatorY(latitude: number): number {
  const clampedLatitude = Math.max(-85.051129, Math.min(85.051129, latitude));
  const radians = clampedLatitude * Math.PI / 180;
  return 180 - (180 * Math.log(Math.tan(radians) + 1 / Math.cos(radians))) / Math.PI;
}

function geometryBounds(features: BoundaryFeature[]): GeometryBounds | null {
  const positions = features.flatMap((feature) => positionsInGeometry(feature.geometry));
  if (positions.length === 0) return null;

  const longitudes = positions.map((position) => position[0]);
  const mercatorLatitudes = positions.map((position) => mapMercatorY(position[1]));
  const bounds: GeometryBounds = {
    minLongitude: Math.min(...longitudes),
    maxLongitude: Math.max(...longitudes),
    minMercatorLatitude: Math.min(...mercatorLatitudes),
    maxMercatorLatitude: Math.max(...mercatorLatitudes),
  };
  return bounds.minLongitude === bounds.maxLongitude
    || bounds.minMercatorLatitude === bounds.maxMercatorLatitude
    ? null
    : bounds;
}

/**
 * Pick a viewport whose usable (post-padding) area has the rendered geometry's
 * Mercator aspect ratio. Mapbox's `auto` camera then needs no letterboxing, so a
 * linear coordinate-to-pixel conversion maps precisely into the padded content box.
 */
function overviewOptionsForFeatures(
  features: BoundaryFeature[],
  baseOptions: Pick<BuildStaticUrlOptions, 'padding' | 'token'>,
): BuildStaticUrlOptions {
  const maxDimension = 1280;
  const maxContent = maxDimension - baseOptions.padding * 2;
  const minContentSide = 240;
  const bounds = geometryBounds(features);
  if (!bounds) {
    return { ...baseOptions, width: maxDimension, height: maxDimension };
  }

  const mercatorWidth = bounds.maxLongitude - bounds.minLongitude;
  const mercatorHeight = bounds.maxMercatorLatitude - bounds.minMercatorLatitude;
  const aspect = mercatorWidth / mercatorHeight;
  if (!Number.isFinite(aspect) || aspect <= 0) {
    return { ...baseOptions, width: maxDimension, height: maxDimension };
  }

  let contentWidth: number;
  let contentHeight: number;
  if (aspect >= 1) {
    contentHeight = Math.max(minContentSide, maxContent / aspect);
    contentWidth = Math.min(maxContent, contentHeight * aspect);
  } else {
    contentWidth = Math.max(minContentSide, maxContent * aspect);
    contentHeight = Math.min(maxContent, contentWidth / aspect);
  }

  return {
    ...baseOptions,
    width: Math.min(maxDimension, Math.max(1, Math.round(contentWidth + baseOptions.padding * 2))),
    height: Math.min(maxDimension, Math.max(1, Math.round(contentHeight + baseOptions.padding * 2))),
  };
}

/**
 * Mapbox expands the shorter camera axis when an exceptionally thin bbox cannot
 * match the 240px minimum. Derive that camera bbox from the rendered geometry so
 * labels remain correct even in that otherwise-impossible floor/max-dimension case.
 */
function viewportBoundsForOptions(
  bounds: GeometryBounds,
  options: Pick<BuildStaticUrlOptions, 'width' | 'height' | 'padding'>,
): GeometryBounds {
  const geometryWidth = bounds.maxLongitude - bounds.minLongitude;
  const geometryHeight = bounds.maxMercatorLatitude - bounds.minMercatorLatitude;
  const contentWidth = options.width - options.padding * 2;
  const contentHeight = options.height - options.padding * 2;
  const geometryAspect = geometryWidth / geometryHeight;
  const viewportAspect = contentWidth / contentHeight;

  if (geometryAspect > viewportAspect) {
    const viewportHeight = geometryWidth / viewportAspect;
    const extraHeight = (viewportHeight - geometryHeight) / 2;
    return {
      ...bounds,
      minMercatorLatitude: bounds.minMercatorLatitude - extraHeight,
      maxMercatorLatitude: bounds.maxMercatorLatitude + extraHeight,
    };
  }
  if (geometryAspect < viewportAspect) {
    const viewportWidth = geometryHeight * viewportAspect;
    const extraWidth = (viewportWidth - geometryWidth) / 2;
    return {
      ...bounds,
      minLongitude: bounds.minLongitude - extraWidth,
      maxLongitude: bounds.maxLongitude + extraWidth,
    };
  }
  return bounds;
}

/** Build a stable aspect-matched overview URL from the exact simplified overlay. */
function buildOverviewStaticImage(fields: ParsedJobField[], token: string): (StaticImageBuild & { options: BuildStaticUrlOptions }) | null {
  let options: BuildStaticUrlOptions = { width: 1280, height: 1280, padding: 40, token };
  // Width/height contribute only a few URL characters, but repeat until the URL
  // simplification choice and aspect calculation agree so labels use the exact
  // geometry Mapbox receives.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const built = buildStaticImageUrl(fields, options);
    if (!built) return null;
    const matchedOptions = overviewOptionsForFeatures(built.features, options);
    if (matchedOptions.width === options.width && matchedOptions.height === options.height) {
      return { ...built, options };
    }
    options = matchedOptions;
  }
  return null;
}

function formatAcreageLabel(acres: number | null): string | null {
  if (acres == null || !Number.isFinite(acres)) return null;
  return `${(Math.round(acres * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })} ac`;
}

/**
 * The Static Images API does not render text labels from GeoJSON. On browsers that
 * support bitmap decoding, draw acreage labels at the field centroids after the
 * satellite PNG is fetched. Older browsers still receive the outlined map.
 */
async function addAcreageLabels(
  blob: Blob,
  fallbackDataUrl: string,
  fields: ParsedJobField[],
  renderedFeatures: BoundaryFeature[],
  options: Pick<BuildStaticUrlOptions, 'width' | 'height' | 'padding'>,
): Promise<string> {
  const labels: AcreageLabel[] = fields.flatMap((field) => {
    const text = formatAcreageLabel(field.acres);
    return field.centroidLat != null && field.centroidLng != null && text
      ? [{ lat: field.centroidLat, lng: field.centroidLng, text }]
      : [];
  });
  if (labels.length === 0 || typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
    return fallbackDataUrl;
  }

  const bounds = geometryBounds(renderedFeatures);
  if (!bounds) return fallbackDataUrl;
  const viewportBounds = viewportBoundsForOptions(bounds, options);

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = options.width;
    canvas.height = options.height;
    const context = canvas.getContext('2d');
    if (!context) return fallbackDataUrl;
    context.drawImage(bitmap, 0, 0, options.width, options.height);
    context.font = 'bold 18px sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    const contentWidth = options.width - options.padding * 2;
    const contentHeight = options.height - options.padding * 2;
    labels.forEach((label) => {
      const x = options.padding + ((label.lng - viewportBounds.minLongitude) / (viewportBounds.maxLongitude - viewportBounds.minLongitude)) * contentWidth;
      const y = options.padding + ((viewportBounds.maxMercatorLatitude - mapMercatorY(label.lat)) / (viewportBounds.maxMercatorLatitude - viewportBounds.minMercatorLatitude)) * contentHeight;
      const textWidth = context.measureText(label.text).width;
      context.fillStyle = 'rgba(0, 0, 0, 0.72)';
      context.fillRect(x - textWidth / 2 - 6, y - 12, textWidth + 12, 24);
      context.fillStyle = '#FFD700';
      context.fillText(label.text, x, y);
    });
    return canvas.toDataURL('image/png');
  } catch (error) {
    console.warn('Unable to draw field acreage labels on the overview map.', error);
    return fallbackDataUrl;
  } finally {
    bitmap?.close();
  }
}

async function fetchImageDataUrl(
  url: string,
  label: string,
  overviewFields?: ParsedJobField[],
  overviewFeatures?: BoundaryFeature[],
  overviewOptions?: Pick<BuildStaticUrlOptions, 'width' | 'height' | 'padding'>,
): Promise<string | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MAPBOX_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      console.warn(`Unable to fetch ${label} field map: Mapbox returned ${response.status}.`);
      return null;
    }
    const blob = await response.blob();
    const dataUrl = await blobToDataUrl(blob);
    return overviewFields && overviewFeatures && overviewOptions
      ? addAcreageLabels(blob, dataUrl, overviewFields, overviewFeatures, overviewOptions)
      : dataUrl;
  } catch (error) {
    if (controller.signal.aborted) {
      console.warn(`Timed out fetching ${label} field map after ${MAPBOX_FETCH_TIMEOUT_MS / 1000} seconds.`, error);
    } else {
      console.warn(`Unable to fetch ${label} field map.`, error);
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function customerNamesById(customerIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (customerIds.length === 0) return names;
  try {
    const { data, error } = await supabase
      .from('customers')
      .select('id, farm_name')
      .in('id', customerIds);
    if (error) {
      console.warn('Unable to load field-map customer names.', error);
      return names;
    }
    (data as Array<{ id: string; farm_name: string | null }> | null)?.forEach((customer) => {
      if (customer.farm_name) names.set(customer.id, customer.farm_name);
    });
  } catch (error) {
    console.warn('Unable to load field-map customer names.', error);
  }
  return names;
}

/**
 * Fetch the satellite overview and close-up maps for one saved job.
 *
 * Failures are deliberately non-fatal: a field sheet remains printable without a
 * Mapbox token, map geometry, or a successfully downloaded static image.
 */
export async function fetchJobMapImages(
  jobId: string,
  opts: { overview?: boolean; perField?: boolean; widthPx?: number; heightPx?: number } = {},
): Promise<JobMapImages | null> {
  const token = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;
  if (!jobId || !token?.trim()) {
    console.warn('Skipping applicator-sheet maps because VITE_MAPBOX_TOKEN is not configured.');
    return null;
  }

  try {
    const { data, error } = await supabase.rpc('get_job_fields_with_geojson', { p_job_id: jobId });
    if (error) throw error;
    const rows = assertRpcResult<JobMapFieldRow[]>(data, 'get_job_fields_with_geojson');
    const jobAcresByFieldId = new Map<string, number | null>();
    try {
      const { data: jobFields, error: jobFieldsError } = await supabase
        .from('job_fields')
        .select('field_id, acres_to_treat')
        .eq('job_id', jobId);
      if (jobFieldsError) {
        console.warn('Unable to load job-specific field acres for applicator-sheet maps.', jobFieldsError);
      } else {
        (jobFields as JobFieldAcresRow[] | null)?.forEach((jobField) => {
          if (jobField.field_id) jobAcresByFieldId.set(jobField.field_id, jobField.acres_to_treat);
        });
      }
    } catch (error) {
      console.warn('Unable to load job-specific field acres for applicator-sheet maps.', error);
    }
    const fields = rows
      .map((row): ParsedJobField | null => {
        const geometry = parseGeoJsonGeometry(row.boundary_geojson);
        if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) return null;
        const centroid = centroidFromGeoJson(row.centroid_geojson);
        return {
          id: row.id,
          name: row.field_name,
          customerId: row.customer_id,
          acres: jobAcresByFieldId.get(row.id) ?? null,
          centroidLat: centroid.lat,
          centroidLng: centroid.lng,
          geometry,
        };
      })
      .filter((field): field is ParsedJobField => field !== null);

    if (fields.length === 0) {
      console.warn('Skipping applicator-sheet maps because this job has no field boundaries.');
      return null;
    }

    const customerNames = await customerNamesById([...new Set(fields.map((field) => field.customerId))]);
    const widthOverride = opts.widthPx;
    const heightOverride = opts.heightPx;
    const perFieldOptions: BuildStaticUrlOptions = {
      width: clampDimension(widthOverride ?? 1000, 1000),
      height: clampDimension(heightOverride ?? 700, 700),
      padding: 40,
      token: token.trim(),
    };

    let overview: string | null = null;
    if (opts.overview !== false) {
      const overviewImage = buildOverviewStaticImage(fields, token.trim());
      if (overviewImage) {
        overview = await fetchImageDataUrl(
          overviewImage.url,
          'overview',
          fields,
          overviewImage.features,
          overviewImage.options,
        );
      } else {
        console.warn('Skipping applicator-sheet overview map because its geometry exceeds Mapbox URL limits.');
      }
    }

    const perField: JobFieldMapImage[] = [];
    if (opts.perField !== false) {
      for (const field of fields) {
        const image = buildStaticImageUrl([field], perFieldOptions);
        if (!image) {
          console.warn(`Skipping map for ${field.name} because its geometry exceeds Mapbox URL limits.`);
          continue;
        }
        const dataUrl = await fetchImageDataUrl(image.url, field.name);
        if (!dataUrl) continue;
        perField.push({
          fieldId: field.id,
          fieldName: field.name,
          customerName: customerNames.get(field.customerId) ?? null,
          acres: field.acres,
          centroidLat: field.centroidLat,
          centroidLng: field.centroidLng,
          dataUrl,
        });
      }
    }

    return overview || perField.length > 0 ? { overview, perField } : null;
  } catch (error) {
    console.warn('Unable to load applicator-sheet field maps.', error);
    return null;
  }
}
