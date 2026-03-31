import { describe, it, expect } from 'vitest';
import { computeBounds } from './useFitBounds';

describe('computeBounds', () => {
  it('returns null for empty array', () => {
    expect(computeBounds([])).toBeNull();
  });

  it('returns null when all entries are null/undefined', () => {
    expect(computeBounds([null, undefined, ''])).toBeNull();
  });

  it('computes bbox from a single polygon GeoJSON string', () => {
    const polygon = JSON.stringify({
      type: 'Polygon',
      coordinates: [[[-89.5, 40.0], [-89.4, 40.0], [-89.4, 40.1], [-89.5, 40.1], [-89.5, 40.0]]],
    });
    const result = computeBounds([polygon]);
    expect(result).not.toBeNull();
    expect(result![0]).toBeCloseTo(-89.5, 1);
    expect(result![1]).toBeCloseTo(40.0, 1);
    expect(result![2]).toBeCloseTo(-89.4, 1);
    expect(result![3]).toBeCloseTo(40.1, 1);
  });

  it('computes bbox from multiple point GeoJSON strings', () => {
    const p1 = JSON.stringify({ type: 'Point', coordinates: [-89.0, 40.0] });
    const p2 = JSON.stringify({ type: 'Point', coordinates: [-88.0, 41.0] });
    const result = computeBounds([p1, p2]);
    expect(result).not.toBeNull();
    expect(result![0]).toBeCloseTo(-89.0, 1);
    expect(result![2]).toBeCloseTo(-88.0, 1);
  });

  it('computes bbox spanning multiple polygons', () => {
    const poly1 = JSON.stringify({
      type: 'Polygon',
      coordinates: [[[-90.0, 39.0], [-89.5, 39.0], [-89.5, 39.5], [-90.0, 39.5], [-90.0, 39.0]]],
    });
    const poly2 = JSON.stringify({
      type: 'Polygon',
      coordinates: [[[-88.0, 41.0], [-87.5, 41.0], [-87.5, 41.5], [-88.0, 41.5], [-88.0, 41.0]]],
    });
    const result = computeBounds([poly1, poly2]);
    expect(result).not.toBeNull();
    expect(result![0]).toBeCloseTo(-90.0, 1); // minLng
    expect(result![1]).toBeCloseTo(39.0, 1);  // minLat
    expect(result![2]).toBeCloseTo(-87.5, 1); // maxLng
    expect(result![3]).toBeCloseTo(41.5, 1);  // maxLat
  });

  it('skips invalid JSON gracefully', () => {
    const valid = JSON.stringify({ type: 'Point', coordinates: [-89.0, 40.0] });
    const result = computeBounds(['not-json', valid, '{bad}']);
    expect(result).not.toBeNull();
    expect(result![0]).toBeCloseTo(-89.0, 1);
  });

  it('handles Feature wrapper objects', () => {
    const feature = JSON.stringify({
      type: 'Feature',
      properties: {},
      geometry: { type: 'Point', coordinates: [-88.5, 40.5] },
    });
    const result = computeBounds([feature]);
    expect(result).not.toBeNull();
    expect(result![0]).toBeCloseTo(-88.5, 1);
  });
});
