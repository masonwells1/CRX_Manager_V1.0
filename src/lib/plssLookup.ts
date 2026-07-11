const BLM_PLSS_BASE_URL = 'https://gis.blm.gov/arcgis/rest/services/Cadastral/BLM_Natl_PLSS_CadNSDI/MapServer';
const PLSS_LOOKUP_TIMEOUT_MS = 8_000;

type AttributeMap = Record<string, unknown>;

interface ArcGisQueryResponse {
  features?: Array<{ attributes?: AttributeMap }>;
  error?: { message?: string };
}

export interface PlssLookupPoint {
  longitude: number;
  latitude: number;
}

export interface PlssLookupResult {
  legalDescription: string;
}

export class PlssLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlssLookupError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function firstAttributes(response: unknown, layerName: string): AttributeMap {
  if (!isRecord(response)) throw new PlssLookupError(`BLM returned an unreadable ${layerName} response.`);
  const typed = response as ArcGisQueryResponse;
  if (typed.error?.message) throw new PlssLookupError(`BLM ${layerName} lookup failed: ${typed.error.message}`);
  const attributes = typed.features?.[0]?.attributes;
  if (!attributes || !isRecord(attributes)) {
    throw new PlssLookupError(`BLM did not find a ${layerName} at this field location.`);
  }
  return attributes;
}

function readAttribute(attributes: AttributeMap, names: readonly string[]): string | null {
  const wanted = new Set(names.map((name) => name.toUpperCase()));
  for (const [key, value] of Object.entries(attributes)) {
    if (!wanted.has(key.toUpperCase()) || (typeof value !== 'string' && typeof value !== 'number')) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

function formatPlssNumber(raw: string | null, direction: string | null): string | null {
  if (!raw || !direction) return null;
  const number = Number(raw);
  const suffix = direction.trim().toUpperCase();
  if (!Number.isInteger(number) || number < 0 || !/^[NSEW]$/.test(suffix)) return null;
  return `${String(number).padStart(2, '0')}${suffix}`;
}

/** Pure parser for the two BLM layer responses. */
export function parsePlssLookup(
  townshipResponse: unknown,
  sectionResponse: unknown,
): PlssLookupResult {
  const township = firstAttributes(townshipResponse, 'township');
  const section = firstAttributes(sectionResponse, 'section');
  const townshipValue = formatPlssNumber(
    readAttribute(township, ['TWNSHPNO', 'TOWNSHIP', 'TOWNSHIPNO']),
    readAttribute(township, ['TWNSHPDIR', 'TOWNSHIPDIR']),
  );
  const rangeValue = formatPlssNumber(
    readAttribute(township, ['RANGENO', 'RANGE', 'RANGENUMBER']),
    readAttribute(township, ['RANGEDIR', 'RANGEDIRECTION']),
  );
  const sectionValue = readAttribute(section, ['FRSTDIVNO', 'SECTION', 'SECTIONNO']);

  if (!townshipValue || !rangeValue || !sectionValue) {
    throw new PlssLookupError('BLM returned an unfamiliar PLSS field layout; township, range, or section was unavailable.');
  }

  // County/state fill was dropped because the PLSS layer does not carry county data.
  return { legalDescription: `Sec ${sectionValue}, T${townshipValue} R${rangeValue}` };
}

function buildQueryUrl(layerId: 1 | 2, point: PlssLookupPoint): string {
  const params = new URLSearchParams({
    where: '1=1',
    geometry: `${point.longitude},${point.latitude}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: '*',
    returnGeometry: 'false',
    f: 'json',
  });
  return `${BLM_PLSS_BASE_URL}/${layerId}/query?${params.toString()}`;
}

async function queryPlssLayer(
  layerId: 1 | 2,
  point: PlssLookupPoint,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const response = await fetchImpl(buildQueryUrl(layerId, point), { signal });
  if (!response.ok) throw new PlssLookupError(`BLM lookup returned ${response.status}.`);
  return response.json();
}

/** Look up the PLSS township and section that contain a WGS84 longitude/latitude point. */
export async function lookupPlss(
  point: PlssLookupPoint,
  fetchImpl: typeof fetch = fetch,
): Promise<PlssLookupResult> {
  if (!Number.isFinite(point.longitude) || !Number.isFinite(point.latitude)) {
    throw new PlssLookupError('A valid field location is required for legal lookup.');
  }

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), PLSS_LOOKUP_TIMEOUT_MS);
  try {
    const [townshipResponse, sectionResponse] = await Promise.all([
      queryPlssLayer(1, point, controller.signal, fetchImpl),
      queryPlssLayer(2, point, controller.signal, fetchImpl),
    ]);
    return parsePlssLookup(townshipResponse, sectionResponse);
  } catch (error: unknown) {
    if (error instanceof PlssLookupError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new PlssLookupError('BLM lookup timed out.');
    }
    throw new PlssLookupError('BLM lookup could not be completed.');
  } finally {
    window.clearTimeout(timeoutId);
  }
}
