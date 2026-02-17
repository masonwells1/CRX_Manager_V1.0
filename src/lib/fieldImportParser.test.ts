import { describe, it, expect } from 'vitest';
import { parseGeoJSONFile, validateFeatureGeometry, calculateFieldMetrics } from './fieldImportParser';
import type { Feature, Polygon } from 'geojson';

// ---- Helper: create a simple polygon feature ----
function makePolygonFeature(
  coords: [number, number][],
  props: Record<string, unknown> = {}
): Feature<Polygon> {
  // Close the ring if not already closed
  const ring = [...coords];
  if (ring.length > 0 && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) {
    ring.push(ring[0]);
  }
  return {
    type: 'Feature',
    properties: props,
    geometry: { type: 'Polygon', coordinates: [ring] },
  };
}

// A valid ~1 acre square in Kansas (WGS84)
const kansasSquare: [number, number][] = [
  [-98.5, 38.5],
  [-98.499, 38.5],
  [-98.499, 38.501],
  [-98.5, 38.501],
  [-98.5, 38.5],
];

describe('parseGeoJSONFile', () => {
  it('parses a valid FeatureCollection', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [makePolygonFeature(kansasSquare, { name: 'Field 1' })],
    };
    const result = parseGeoJSONFile(JSON.stringify(fc));
    expect(result.featureCount).toBe(1);
    expect(result.attributeKeys).toContain('name');
    expect(result.crsDetected).toBeNull();
    expect(result.warnings).toHaveLength(0);
  });

  it('parses a single Feature (not wrapped in collection)', () => {
    const feature = makePolygonFeature(kansasSquare, { crop: 'corn' });
    const result = parseGeoJSONFile(JSON.stringify(feature));
    expect(result.featureCount).toBe(1);
    expect(result.attributeKeys).toContain('crop');
  });

  it('parses a bare Polygon geometry', () => {
    const polygon = { type: 'Polygon', coordinates: [kansasSquare] };
    const result = parseGeoJSONFile(JSON.stringify(polygon));
    expect(result.featureCount).toBe(1);
  });

  it('throws on invalid JSON', () => {
    expect(() => parseGeoJSONFile('not json{{')).toThrow('Invalid JSON');
  });

  it('throws on invalid GeoJSON type', () => {
    expect(() => parseGeoJSONFile(JSON.stringify({ type: 'Unsupported' }))).toThrow('Invalid GeoJSON');
  });

  it('throws on empty FeatureCollection', () => {
    const fc = { type: 'FeatureCollection', features: [] };
    expect(() => parseGeoJSONFile(JSON.stringify(fc))).toThrow('No features found');
  });

  it('throws when features exceed MAX_FEATURES (500)', () => {
    const features = Array.from({ length: 501 }, (_, i) =>
      makePolygonFeature(kansasSquare, { id: i })
    );
    const fc = { type: 'FeatureCollection', features };
    expect(() => parseGeoJSONFile(JSON.stringify(fc))).toThrow('Maximum is 500');
  });

  it('skips non-polygon features with warnings', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        makePolygonFeature(kansasSquare, { name: 'valid' }),
        { type: 'Feature', properties: { name: 'point' }, geometry: { type: 'Point', coordinates: [-98.5, 38.5] } },
      ],
    };
    const result = parseGeoJSONFile(JSON.stringify(fc));
    expect(result.featureCount).toBe(1);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('Point');
  });

  it('converts MultiPolygon to largest polygon', () => {
    const multi = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { name: 'multi' },
        geometry: {
          type: 'MultiPolygon',
          coordinates: [
            [kansasSquare], // polygon 1
            [[ // polygon 2 — slightly bigger
              [-98.5, 38.5],
              [-98.498, 38.5],
              [-98.498, 38.502],
              [-98.5, 38.502],
              [-98.5, 38.5],
            ]],
          ],
        },
      }],
    };
    const result = parseGeoJSONFile(JSON.stringify(multi));
    expect(result.featureCount).toBe(1);
    expect(result.warnings.some((w: string) => w.includes('MultiPolygon'))).toBe(true);
  });

  it('extracts all unique attribute keys', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        makePolygonFeature(kansasSquare, { name: 'A', crop: 'corn' }),
        makePolygonFeature(kansasSquare, { name: 'B', soil: 'clay' }),
      ],
    };
    const result = parseGeoJSONFile(JSON.stringify(fc));
    expect(result.attributeKeys).toEqual(expect.arrayContaining(['name', 'crop', 'soil']));
    expect(result.attributeKeys).toHaveLength(3);
  });
});

describe('validateFeatureGeometry', () => {
  it('returns no errors for a valid polygon', () => {
    const feature = makePolygonFeature(kansasSquare);
    expect(validateFeatureGeometry(feature)).toHaveLength(0);
  });

  it('returns error for empty geometry', () => {
    const feature = { type: 'Feature', properties: {}, geometry: null } as any;
    const errors = validateFeatureGeometry(feature);
    expect(errors).toContain('Empty geometry');
  });

  it('returns error for too few points', () => {
    const feature = makePolygonFeature([[-98.5, 38.5], [-98.499, 38.5]]);
    // After closing, we'd have 3 points — need at least 4 (3 unique + closing)
    const errors = validateFeatureGeometry(feature);
    expect(errors.some(e => e.includes('at least 3 points'))).toBe(true);
  });

  it('returns error for coordinates outside WGS84 range', () => {
    const badCoords: [number, number][] = [
      [500000, 4000000],   // Not WGS84 — projected coordinates
      [500100, 4000000],
      [500100, 4000100],
      [500000, 4000100],
      [500000, 4000000],
    ];
    const feature: Feature<Polygon> = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [badCoords] },
    };
    const errors = validateFeatureGeometry(feature);
    expect(errors.some(e => e.includes('WGS84'))).toBe(true);
  });

  it('returns no error for valid edge coordinates (exactly -180/180)', () => {
    const edgeCoords: [number, number][] = [
      [-180, -90],
      [180, -90],
      [180, 90],
      [-180, 90],
      [-180, -90],
    ];
    const feature: Feature<Polygon> = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [edgeCoords] },
    };
    expect(validateFeatureGeometry(feature)).toHaveLength(0);
  });
});

describe('calculateFieldMetrics', () => {
  it('returns acres and centroid for a polygon', () => {
    const feature = makePolygonFeature(kansasSquare);
    const metrics = calculateFieldMetrics(feature);

    expect(metrics.acres).toBeGreaterThan(0);
    expect(metrics.centroid.type).toBe('Point');
    expect(metrics.centroid.coordinates).toHaveLength(2);
    // Centroid should be roughly in the center of our Kansas square
    expect(metrics.centroid.coordinates[0]).toBeCloseTo(-98.4995, 2);
    expect(metrics.centroid.coordinates[1]).toBeCloseTo(38.5005, 2);
  });

  it('returns consistent acreage', () => {
    const feature = makePolygonFeature(kansasSquare);
    const m1 = calculateFieldMetrics(feature);
    const m2 = calculateFieldMetrics(feature);
    expect(m1.acres).toBe(m2.acres);
  });
});
