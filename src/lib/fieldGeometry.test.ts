import { describe, it, expect } from 'vitest';
import type { Feature, Polygon } from 'geojson';
import { buildBoundaryGeometry, billableAcres } from './fieldGeometry';

const poly = (ring: number[][]): Feature<Polygon> => ({
  type: 'Feature',
  properties: {},
  geometry: { type: 'Polygon', coordinates: [ring] },
});

const A = poly([[-100, 40], [-100, 40.01], [-99.99, 40.01], [-99.99, 40], [-100, 40]]);
const B = poly([[-99, 41], [-99, 41.01], [-98.99, 41.01], [-98.99, 41], [-99, 41]]);

describe('buildBoundaryGeometry', () => {
  it('combines multiple drawn polygons into one MultiPolygon (preserves all parts)', () => {
    const g = buildBoundaryGeometry([A, B], null);
    expect(g).not.toBeNull();
    expect(g!.type).toBe('MultiPolygon');
    expect((g as { coordinates: number[][][][] }).coordinates).toHaveLength(2);
    expect((g as { coordinates: number[][][][] }).coordinates[0]).toEqual(A.geometry.coordinates);
    expect((g as { coordinates: number[][][][] }).coordinates[1]).toEqual(B.geometry.coordinates);
  });

  it('passes a single drawn boundary as its Polygon geometry', () => {
    const g = buildBoundaryGeometry([], A);
    expect(g).toEqual(A.geometry);
    expect(g!.type).toBe('Polygon');
  });

  it('prefers drawn polygons over the single boundary when both exist', () => {
    const g = buildBoundaryGeometry([A], B);
    expect(g!.type).toBe('MultiPolygon');
  });

  it('returns null when there is no geometry', () => {
    expect(buildBoundaryGeometry([], null)).toBeNull();
  });

  it('never emits a Feature or FeatureCollection (RPC input contract)', () => {
    const g = buildBoundaryGeometry([A, B], null);
    expect(['Polygon', 'MultiPolygon']).toContain(g!.type);
  });
});

describe('billableAcres', () => {
  it('override wins', () => expect(billableAcres(38.5, 40, 25)).toBe(38.5));
  it('falls back to measured when no override', () => expect(billableAcres(null, 40, 25)).toBe(40));
  it('falls back to legacy total when no override or measured', () => expect(billableAcres(null, null, 25)).toBe(25));
  it('is null when all absent', () => expect(billableAcres(null, null, null)).toBeNull());
  it('treats a 0 override as a real value (not nullish)', () => expect(billableAcres(0, 40, 25)).toBe(0));
  it('handles undefined like null', () => expect(billableAcres(undefined, undefined, 25)).toBe(25));
});
