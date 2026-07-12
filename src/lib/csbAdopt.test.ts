import { describe, expect, it } from 'vitest';
import type { CsbFeature } from './csbLookup';
import { CsbAdoptError, csbFeatureToDrawnParts } from './csbAdopt';

const ring = (lng: number, lat: number, size = 0.001) => [
  [lng, lat],
  [lng + size, lat],
  [lng + size, lat + size],
  [lng, lat + size],
  [lng, lat],
] as [number, number][];

function csbFeature(geometry: CsbFeature['geometry']): CsbFeature {
  return {
    type: 'Feature',
    properties: { id: 'usda-123', crop: 'Corn', acres: 20 },
    geometry,
  };
}

describe('csbFeatureToDrawnParts', () => {
  it('converts a Polygon into one normal DrawLayer part', () => {
    const result = csbFeatureToDrawnParts(csbFeature({ type: 'Polygon', coordinates: [ring(-89, 40)] }), 2);

    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]).toMatchObject({
      label: 'Polygon 3',
      polygon: { geometry: { type: 'Polygon' } },
    });
    expect(result.parts[0].drawId).toMatch(/^csb-usda-123-0-[0-9a-f]{8}$/);
    expect(result.parts[0].polygon.id).toBe(result.parts[0].drawId);
    expect(result.parts[0].acres).toBeGreaterThan(0.1);
    expect(result.totalAcres).toBe(result.parts[0].acres);
  });

  it('gives re-adoptions of the same USDA field distinct drawIds', () => {
    const feature = csbFeature({ type: 'Polygon', coordinates: [ring(-89, 40)] });
    const first = csbFeatureToDrawnParts(feature, 0);
    const second = csbFeatureToDrawnParts(feature, 1);
    expect(first.parts[0].drawId).not.toBe(second.parts[0].drawId);
  });

  it('splits a MultiPolygon into editable DrawLayer parts with continued labels', () => {
    const result = csbFeatureToDrawnParts(csbFeature({
      type: 'MultiPolygon',
      coordinates: [[ring(-89, 40)], [ring(-88.99, 40)]],
    }), 4);

    expect(result.parts[0].drawId).toMatch(/^csb-usda-123-0-[0-9a-f]{8}$/);
    expect(result.parts[1].drawId).toMatch(/^csb-usda-123-1-[0-9a-f]{8}$/);
    expect(result.parts.map((part) => part.label)).toEqual(['Polygon 5', 'Polygon 6']);
    expect(result.totalAcres).toBeGreaterThan(result.parts[0].acres);
  });

  it('rejects a boundary whose combined acreage is outside the safe acreage band', () => {
    const tiny = csbFeature({ type: 'Polygon', coordinates: [ring(-89, 40, 0.000001)] });
    expect(() => csbFeatureToDrawnParts(tiny, 0)).toThrow(CsbAdoptError);
    expect(() => csbFeatureToDrawnParts(tiny, 0)).toThrow('between 0.1 and 5000');
  });
});
