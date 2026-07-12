import type { Feature, MultiPolygon, Polygon } from 'geojson';
import type { DrawnPolygon } from '../components/map/DrawLayer';
import { ACRE_BAND_MAX, ACRE_BAND_MIN, isAcreInBand } from './fieldGeometry';
import { geometryAcres, validateFullGeometry } from './fieldImportParser';
import type { CsbFeature } from './csbLookup';

export class CsbAdoptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsbAdoptError';
  }
}

/** Converts a USDA CSB field into the same plain Polygon parts used by Mapbox Draw. */
export function csbFeatureToDrawnParts(
  feature: CsbFeature,
  existingCount: number,
): { parts: DrawnPolygon[]; totalAcres: number } {
  const geometry = feature.geometry as Polygon | MultiPolygon;
  const validationErrors = validateFullGeometry(geometry);
  if (validationErrors.length > 0) {
    throw new CsbAdoptError(`USDA boundary is invalid: ${validationErrors.join('; ')}`);
  }

  const totalAcres = geometryAcres(geometry);
  if (!isAcreInBand(totalAcres)) {
    throw new CsbAdoptError(
      `USDA boundary is ${totalAcres} ac; adopted boundaries must be between ${ACRE_BAND_MIN} and ${ACRE_BAND_MAX} ac.`,
    );
  }

  const polygonCoordinates = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  // Unique per adoption: re-adopting the same USDA field must not produce two
  // parts with one drawId (delete-by-drawId would remove both; Mapbox Draw
  // dedupes by feature id and would render only one).
  const adoptionToken = crypto.randomUUID().slice(0, 8);
  const parts = polygonCoordinates.map((coordinates, index) => {
    const drawId = `csb-${feature.properties.id}-${index}-${adoptionToken}`;
    const polygon: Feature<Polygon> = {
      type: 'Feature',
      id: drawId,
      properties: {},
      geometry: { type: 'Polygon', coordinates },
    };
    return {
      drawId,
      polygon,
      acres: geometryAcres(polygon.geometry),
      label: `Polygon ${existingCount + index + 1}`,
    };
  });

  return { parts, totalAcres };
}
