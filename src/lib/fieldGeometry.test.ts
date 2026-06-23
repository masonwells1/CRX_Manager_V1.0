import { describe, it, expect } from 'vitest';
import type { Feature, Polygon } from 'geojson';
import {
  buildBoundaryGeometry,
  billableAcres,
  acreDivergencePct,
  isAcreDivergent,
  ACRE_DIVERGENCE_THRESHOLD_PCT,
  isAcreInBand,
  isAcreDenominatedColumn,
  ACRE_BAND_MIN,
  ACRE_BAND_MAX,
} from './fieldGeometry';

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

describe('isAcreInBand (the 0.1–5000 safety floor the override RPC lacks)', () => {
  it('rejects a tiny value below the 0.1 floor (the Codex P2 gap)', () => {
    expect(isAcreInBand(0.05)).toBe(false);
  });
  it('accepts exactly the floor', () => expect(isAcreInBand(ACRE_BAND_MIN)).toBe(true));
  it('accepts a normal field size', () => expect(isAcreInBand(40)).toBe(true));
  it('accepts exactly the ceiling', () => expect(isAcreInBand(ACRE_BAND_MAX)).toBe(true));
  it('rejects above the ceiling', () => expect(isAcreInBand(5001)).toBe(false));
  it('rejects zero and negatives', () => {
    expect(isAcreInBand(0)).toBe(false);
    expect(isAcreInBand(-5)).toBe(false);
  });
  it('rejects null/undefined', () => {
    expect(isAcreInBand(null)).toBe(false);
    expect(isAcreInBand(undefined)).toBe(false);
  });
});

describe('isAcreDenominatedColumn (acres may set money; raw GIS area may not)', () => {
  it('accepts acre-named columns', () => {
    for (const n of ['Acres', 'ACRES', 'total_acres', 'gis_acres', 'Calc_Acres', 'acreage'])
      expect(isAcreDenominatedColumn(n)).toBe(true);
  });
  it('accepts the bare "ac" abbreviation', () => expect(isAcreDenominatedColumn('AC')).toBe(true));
  it('REJECTS GIS geometry-area columns (square meters, not acres) — the Codex P1 gap', () => {
    for (const n of ['area', 'Shape_Area', 'SHAPE_AREA', 'st_area', 'Shape_Length'])
      expect(isAcreDenominatedColumn(n)).toBe(false);
  });
  it('rejects null/undefined/empty', () => {
    expect(isAcreDenominatedColumn(null)).toBe(false);
    expect(isAcreDenominatedColumn(undefined)).toBe(false);
    expect(isAcreDenominatedColumn('')).toBe(false);
  });
});

describe('acreDivergencePct', () => {
  it('is 0 when entered equals measured', () => expect(acreDivergencePct(40, 40)).toBe(0));
  it('measures an OVER-statement relative to measured', () => expect(acreDivergencePct(44, 40)).toBeCloseTo(10));
  it('measures an UNDER-statement relative to measured (the owner case)', () =>
    expect(acreDivergencePct(36, 40)).toBeCloseTo(10));
  it('is always non-negative (absolute)', () => expect(acreDivergencePct(20, 40)).toBeCloseTo(50));
  it('is null when there is no entered value', () => expect(acreDivergencePct(null, 40)).toBeNull());
  it('is null when there is no measured value', () => expect(acreDivergencePct(40, null)).toBeNull());
  it('is null when measured is 0 (no divide-by-zero)', () => expect(acreDivergencePct(40, 0)).toBeNull());
});

describe('isAcreDivergent', () => {
  it('flags an over-statement at the threshold', () => expect(isAcreDivergent(44, 40)).toBe(true));
  it('flags an under-statement at the threshold (over AND under)', () =>
    expect(isAcreDivergent(36, 40)).toBe(true));
  it('does not flag a small gap below the threshold', () => expect(isAcreDivergent(43, 40)).toBe(false));
  it('does not flag when there is nothing to compare', () => {
    expect(isAcreDivergent(40, null)).toBe(false);
    expect(isAcreDivergent(null, 40)).toBe(false);
  });
  it('uses the shared threshold constant', () => {
    const justOver = 40 * (1 + ACRE_DIVERGENCE_THRESHOLD_PCT / 100);
    expect(isAcreDivergent(justOver, 40)).toBe(true);
  });
});
