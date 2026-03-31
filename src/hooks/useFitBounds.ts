import { useMemo } from 'react';
import bbox from '@turf/bbox';
import type { BBox } from 'geojson';

export type Bounds = [number, number, number, number]; // [minLng, minLat, maxLng, maxLat]

/**
 * Pure function: compute a bounding box from an array of GeoJSON strings.
 * Returns null if no valid geometries found.
 */
export function computeBounds(
  geojsonStrings: (string | null | undefined)[]
): Bounds | null {
  const features: GeoJSON.Feature[] = [];

  for (const raw of geojsonStrings) {
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed.type === 'Feature') {
        features.push(parsed);
      } else if (parsed.type && parsed.coordinates) {
        features.push({ type: 'Feature', properties: {}, geometry: parsed });
      }
    } catch {
      // Skip invalid JSON
    }
  }

  if (features.length === 0) return null;

  const collection: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features,
  };

  const box: BBox = bbox(collection);
  return [box[0], box[1], box[2], box[3]];
}

/**
 * React hook: memoizes bounding box computation from GeoJSON strings.
 */
export function useFitBounds(
  geojsonStrings: (string | null | undefined)[]
): Bounds | null {
  return useMemo(() => computeBounds(geojsonStrings), [geojsonStrings]);
}
