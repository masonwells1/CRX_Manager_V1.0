import { describe, it, expect } from 'vitest';
import { parseGeoJSONFile, parseKMLFile, validateFeatureGeometry, validateFullGeometry, calculateFieldMetrics, geometryAcres } from './fieldImportParser';
import type { Feature, Polygon, MultiPolygon } from 'geojson';

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
    // DISPLAY stays largest-ring Polygon (no regression to the preview/validators)...
    expect(result.featureCollection.features[0].geometry.type).toBe('Polygon');
    // ...but the FULL multi-part geometry is preserved for set_field_boundary to measure all parts.
    expect(result.fullGeometries).toHaveLength(1);
    expect(result.fullGeometries[0].type).toBe('MultiPolygon');
  });

  it('preserves a single Polygon as-is in fullGeometries', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [makePolygonFeature(kansasSquare)],
    };
    const result = parseGeoJSONFile(JSON.stringify(fc));
    expect(result.fullGeometries).toHaveLength(1);
    expect(result.fullGeometries[0].type).toBe('Polygon');
    // index-aligned with the display features
    expect(result.fullGeometries.length).toBe(result.featureCollection.features.length);
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

describe('geometryAcres', () => {
  const box = (x0: number, y0: number, dx: number, dy: number): number[][] => [
    [x0, y0], [x0, y0 + dy], [x0 + dx, y0 + dy], [x0 + dx, y0], [x0, y0],
  ];

  it('measures a single Polygon', () => {
    const a = geometryAcres({ type: 'Polygon', coordinates: [box(-100, 40, 0.0045, 0.0036)] });
    expect(a).toBeGreaterThan(25);
    expect(a).toBeLessThan(60);
  });

  it('sums ALL parts of a MultiPolygon (not just the largest)', () => {
    const large: Polygon = { type: 'Polygon', coordinates: [box(-100, 40, 0.0045, 0.0036)] };
    const small: Polygon = { type: 'Polygon', coordinates: [box(-99.99, 40, 0.00225, 0.0036)] };
    const mp: MultiPolygon = { type: 'MultiPolygon', coordinates: [large.coordinates, small.coordinates] };
    const largeAcres = geometryAcres(large);
    const fullAcres = geometryAcres(mp);
    // the multi-part total is strictly greater than its largest single part
    expect(fullAcres).toBeGreaterThan(largeAcres + 1);
    expect(fullAcres).toBeCloseTo(largeAcres + geometryAcres(small), 0);
  });
});

describe('validateFullGeometry', () => {
  const goodBox = [[-100, 40], [-100, 40.01], [-99.99, 40.01], [-99.99, 40], [-100, 40]];
  it('passes a valid Polygon', () => {
    expect(validateFullGeometry({ type: 'Polygon', coordinates: [goodBox] })).toHaveLength(0);
  });
  it('passes a valid MultiPolygon (every part)', () => {
    expect(validateFullGeometry({ type: 'MultiPolygon', coordinates: [[goodBox], [goodBox]] })).toHaveLength(0);
  });
  it('flags a SMALLER part with out-of-range coords (largest-only validation would miss it)', () => {
    const bad = [[-200, 40], [-200, 40.01], [-199.99, 40.01], [-199.99, 40], [-200, 40]]; // lng -200 invalid
    const errs = validateFullGeometry({ type: 'MultiPolygon', coordinates: [[goodBox], [bad]] });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.includes('WGS84'))).toBe(true);
  });
});

describe('validateFeatureGeometry', () => {
  it('returns no errors for a valid polygon', () => {
    const feature = makePolygonFeature(kansasSquare);
    expect(validateFeatureGeometry(feature)).toHaveLength(0);
  });

  it('returns error for empty geometry', () => {
    const feature = { type: 'Feature', properties: {}, geometry: null } as unknown as Feature<Polygon>;
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

describe('parseKMLFile (audit #38 — @tmcw/togeojson swap, 2026-05-16)', () => {
  // Minimal valid KML with a single polygon over our Kansas square.
  // Note: KML uses lng,lat[,alt] in coordinates and the polygon ring is
  // closed (first == last) as required by the spec.
  const validKml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark>
      <name>Field A</name>
      <description>Test field over Kansas</description>
      <Polygon>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>
              -98.5,38.5 -98.499,38.5 -98.499,38.501 -98.5,38.501 -98.5,38.5
            </coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>
    </Placemark>
  </Document>
</kml>`;

  it('parses a valid KML polygon', async () => {
    const result = await parseKMLFile(validKml);
    expect(result.featureCount).toBe(1);
    expect(result.featureCollection.features[0].geometry.type).toBe('Polygon');
    expect(result.crsDetected).toBeNull();
  });

  it('extracts placemark name as an attribute', async () => {
    const result = await parseKMLFile(validKml);
    // @tmcw/togeojson populates feature.properties.name from <name>
    expect(result.attributeKeys).toContain('name');
  });

  it('throws on KML with no polygon features', async () => {
    const kmlPointOnly = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark>
      <Point><coordinates>-98.5,38.5,0</coordinates></Point>
    </Placemark>
  </Document>
</kml>`;
    await expect(parseKMLFile(kmlPointOnly)).rejects.toThrow('No polygon boundaries');
  });

  it('throws on completely empty KML', async () => {
    const emptyKml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document></Document></kml>`;
    await expect(parseKMLFile(emptyKml)).rejects.toThrow('No features found');
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
