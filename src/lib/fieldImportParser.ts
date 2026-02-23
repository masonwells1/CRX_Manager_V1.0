// @ts-expect-error no type declarations
import * as shapefile from 'shapefile';
import proj4 from 'proj4';
import area from '@turf/area';
import turfCentroid from '@turf/centroid';
import bbox from '@turf/bbox';
import type {
  FeatureCollection,
  Feature,
  Geometry,
  Polygon,
  MultiPolygon,
  Position,
  GeoJsonProperties,
} from 'geojson';

// Re-export bbox for use by ImportPreviewMap
export { bbox };

export interface ParseResult {
  featureCollection: FeatureCollection<Polygon, GeoJsonProperties>;
  attributeKeys: string[];
  crsDetected: string | null;
  warnings: string[];
  featureCount: number;
}

const MAX_FEATURES = 500;

/**
 * Parse a shapefile bundle (.shp + .dbf, optional .prj) into GeoJSON.
 */
export async function parseShapefileBundle(
  shpBuffer: ArrayBuffer,
  dbfBuffer: ArrayBuffer,
  prjText: string | null
): Promise<ParseResult> {
  const warnings: string[] = [];

  // shapefile.read returns a GeoJSON FeatureCollection
  const fc = await (shapefile as unknown as { read: (shp: ArrayBuffer, dbf: ArrayBuffer) => Promise<GeoJSON.FeatureCollection> }).read(shpBuffer, dbfBuffer);

  if (!fc || !fc.features || fc.features.length === 0) {
    throw new Error('No features found in shapefile.');
  }

  if (fc.features.length > MAX_FEATURES) {
    throw new Error(
      `Shapefile contains ${fc.features.length} features. Maximum is ${MAX_FEATURES}. Please split your file.`
    );
  }

  let crsDetected: string | null = null;

  // Reproject if .prj file provided
  if (prjText && prjText.trim()) {
    crsDetected = extractCRSName(prjText);
    try {
      reprojectToWGS84(fc, prjText);
    } catch (err: unknown) {
      warnings.push(
        `Could not reproject coordinates: ${err instanceof Error ? err.message : String(err)}. Assuming WGS84.`
      );
    }
  } else {
    warnings.push(
      'No .prj file found. Assuming coordinates are in WGS84 (latitude/longitude). If fields appear in the wrong location, include the .prj file.'
    );
  }

  // Normalize features to Polygon only
  const normalized = normalizeToPolygons(fc, warnings);

  const attributeKeys = extractAttributeKeys(normalized);

  return {
    featureCollection: normalized,
    attributeKeys,
    crsDetected,
    warnings,
    featureCount: normalized.features.length,
  };
}

/**
 * Parse a GeoJSON file string.
 */
export function parseGeoJSONFile(jsonText: string): ParseResult {
  const warnings: string[] = [];

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonText) as Record<string, unknown>;
  } catch {
    throw new Error('Invalid JSON file. Could not parse.');
  }

  // Handle both FeatureCollection and single Feature
  let fc: FeatureCollection;
  if (parsed.type === 'FeatureCollection') {
    fc = parsed as unknown as FeatureCollection;
  } else if (parsed.type === 'Feature') {
    fc = { type: 'FeatureCollection', features: [parsed as unknown as Feature] };
  } else if (parsed.type === 'Polygon' || parsed.type === 'MultiPolygon') {
    fc = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: parsed as unknown as Geometry }],
    };
  } else {
    throw new Error(
      'Invalid GeoJSON. Expected a FeatureCollection, Feature, or Polygon geometry.'
    );
  }

  if (!fc.features || fc.features.length === 0) {
    throw new Error('No features found in GeoJSON file.');
  }

  if (fc.features.length > MAX_FEATURES) {
    throw new Error(
      `File contains ${fc.features.length} features. Maximum is ${MAX_FEATURES}.`
    );
  }

  const normalized = normalizeToPolygons(fc, warnings);
  const attributeKeys = extractAttributeKeys(normalized);

  return {
    featureCollection: normalized,
    attributeKeys,
    crsDetected: null,
    warnings,
    featureCount: normalized.features.length,
  };
}

/**
 * Parse a KML file string into GeoJSON.
 */
export async function parseKMLFile(kmlText: string): Promise<ParseResult> {
  const warnings: string[] = [];

  // Dynamic import to avoid bundling if unused
  // @ts-expect-error no type declarations
  const togeojson = await import('@mapbox/togeojson');
  const kml = togeojson.kml;

  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(kmlText, 'text/xml');

  // Check for parse errors
  const parseError = xmlDoc.querySelector('parsererror');
  if (parseError) {
    throw new Error('Invalid KML file. Could not parse XML.');
  }

  const fc = kml(xmlDoc) as FeatureCollection;

  if (!fc || !fc.features || fc.features.length === 0) {
    throw new Error('No features found in KML file.');
  }

  if (fc.features.length > MAX_FEATURES) {
    throw new Error(
      `KML contains ${fc.features.length} features. Maximum is ${MAX_FEATURES}.`
    );
  }

  const normalized = normalizeToPolygons(fc, warnings);
  const attributeKeys = extractAttributeKeys(normalized);

  return {
    featureCollection: normalized,
    attributeKeys,
    crsDetected: null,
    warnings,
    featureCount: normalized.features.length,
  };
}

/**
 * Reproject all coordinates in a FeatureCollection from a given CRS (WKT) to WGS84.
 * Mutates the FeatureCollection in place.
 */
function reprojectToWGS84(
  fc: FeatureCollection,
  prjWKT: string
): void {
  proj4.defs('SOURCE_CRS', prjWKT);

  for (const feature of fc.features) {
    if (feature.geometry) {
      reprojectGeometry(feature.geometry);
    }
  }
}

function reprojectGeometry(geometry: Geometry): void {
  if (!geometry) return;

  switch (geometry.type) {
    case 'Point':
      geometry.coordinates = reprojectCoord(geometry.coordinates);
      break;
    case 'MultiPoint':
    case 'LineString':
      geometry.coordinates = geometry.coordinates.map(reprojectCoord);
      break;
    case 'MultiLineString':
    case 'Polygon':
      geometry.coordinates = geometry.coordinates.map((ring) =>
        ring.map(reprojectCoord)
      );
      break;
    case 'MultiPolygon':
      geometry.coordinates = geometry.coordinates.map((polygon) =>
        polygon.map((ring) => ring.map(reprojectCoord))
      );
      break;
    case 'GeometryCollection':
      for (const g of geometry.geometries) {
        reprojectGeometry(g);
      }
      break;
  }
}

function reprojectCoord(coord: Position): Position {
  const [x, y] = proj4('SOURCE_CRS', 'EPSG:4326', [coord[0], coord[1]]);
  return coord.length > 2 ? [x, y, coord[2]] : [x, y];
}

/**
 * Extract a human-readable CRS name from a .prj WKT string.
 */
function extractCRSName(prjText: string): string {
  // WKT starts with GEOGCS["name",...] or PROJCS["name",...]
  const match = prjText.match(/^(?:GEOGCS|PROJCS)\["([^"]+)"/);
  return match ? match[1] : 'Unknown CRS';
}

/**
 * Filter a FeatureCollection to only Polygon features.
 * Converts MultiPolygon to the largest single Polygon.
 * Skips non-polygon features with warnings.
 */
function normalizeToPolygons(
  fc: FeatureCollection,
  warnings: string[]
): FeatureCollection<Polygon, GeoJsonProperties> {
  const polygonFeatures: Feature<Polygon, GeoJsonProperties>[] = [];

  for (let i = 0; i < fc.features.length; i++) {
    const feature = fc.features[i];
    const geom = feature.geometry;

    if (!geom) {
      warnings.push(`Feature ${i + 1}: Empty geometry, skipped.`);
      continue;
    }

    if (geom.type === 'Polygon') {
      polygonFeatures.push(feature as Feature<Polygon, GeoJsonProperties>);
    } else if (geom.type === 'MultiPolygon') {
      const largest = extractLargestPolygon(geom as MultiPolygon);
      if (largest) {
        const acresLargest = Math.round(
          (area({ type: 'Feature', properties: {}, geometry: largest }) /
            4046.8564224) *
            100
        ) / 100;
        warnings.push(
          `Feature ${i + 1}: MultiPolygon converted to largest polygon (${acresLargest} acres).`
        );
        polygonFeatures.push({
          type: 'Feature',
          properties: feature.properties || {},
          geometry: largest,
        });
      } else {
        warnings.push(`Feature ${i + 1}: Empty MultiPolygon, skipped.`);
      }
    } else {
      warnings.push(
        `Feature ${i + 1}: ${geom.type} is not a polygon, skipped.`
      );
    }
  }

  if (polygonFeatures.length === 0) {
    throw new Error(
      'No polygon boundaries found in file. This file may contain only points or lines.'
    );
  }

  return {
    type: 'FeatureCollection',
    features: polygonFeatures,
  };
}

/**
 * Extract the largest polygon from a MultiPolygon by area.
 */
function extractLargestPolygon(mp: MultiPolygon): Polygon | null {
  if (!mp.coordinates || mp.coordinates.length === 0) return null;

  let largestIdx = 0;
  let largestArea = 0;

  for (let i = 0; i < mp.coordinates.length; i++) {
    const poly: Polygon = { type: 'Polygon', coordinates: mp.coordinates[i] };
    const a = area({ type: 'Feature', properties: {}, geometry: poly });
    if (a > largestArea) {
      largestArea = a;
      largestIdx = i;
    }
  }

  return { type: 'Polygon', coordinates: mp.coordinates[largestIdx] };
}

/**
 * Get all unique property keys from a FeatureCollection.
 */
function extractAttributeKeys(
  fc: FeatureCollection
): string[] {
  const keys = new Set<string>();
  for (const feature of fc.features) {
    if (feature.properties) {
      for (const key of Object.keys(feature.properties)) {
        keys.add(key);
      }
    }
  }
  return Array.from(keys).sort();
}

/**
 * Calculate acres and centroid for a polygon feature.
 */
export function calculateFieldMetrics(feature: Feature<Polygon>): {
  acres: number;
  centroid: { type: 'Point'; coordinates: [number, number] };
} {
  const sqMeters = area(feature);
  const acres = Math.round((sqMeters / 4046.8564224) * 100) / 100;
  const centroidResult = turfCentroid(feature);
  return {
    acres,
    centroid: centroidResult.geometry as { type: 'Point'; coordinates: [number, number] },
  };
}

/**
 * Validate a polygon feature's geometry.
 * Returns an array of error strings (empty if valid).
 */
export function validateFeatureGeometry(
  feature: Feature<Polygon>
): string[] {
  const errors: string[] = [];
  const geom = feature.geometry;

  if (!geom || !geom.coordinates || geom.coordinates.length === 0) {
    errors.push('Empty geometry');
    return errors;
  }

  const ring = geom.coordinates[0];
  if (!ring || ring.length < 4) {
    errors.push('Polygon must have at least 3 points');
    return errors;
  }

  // Check coordinates are in valid WGS84 range
  for (const coord of ring) {
    const [lng, lat] = coord;
    if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
      errors.push(
        'Coordinates outside valid WGS84 range. Include the .prj file if available.'
      );
      break;
    }
  }

  return errors;
}
