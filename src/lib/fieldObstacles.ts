import type { Feature, Point } from 'geojson';
import type { FieldObstacle, FieldObstacleKind } from '../types';

export const FIELD_OBSTACLE_KINDS: readonly FieldObstacleKind[] = [
  'oil_well',
  'windmill',
  'tower',
  'tree_line',
  'power_line',
  'waterway',
  'other',
];

export const FIELD_OBSTACLE_KIND_LABELS: Record<FieldObstacleKind, string> = {
  oil_well: 'Oil well',
  windmill: 'Windmill',
  tower: 'Tower',
  tree_line: 'Tree line',
  power_line: 'Power line',
  waterway: 'Waterway',
  other: 'Other',
};

/** An in-progress boundary must be finished or cancelled before obstacle placement can begin. */
export function canEnterObstacleMode(isDrawingBoundary: boolean): boolean {
  return !isDrawingBoundary;
}

export interface FieldObstacleFeatureProperties {
  id: string;
  field_id: string;
  kind: FieldObstacleKind;
  label: string;
  title: string;
  'marker-color': string;
  'marker-size': 'small';
}

function isFiniteCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isFieldObstaclePoint(value: unknown): value is Point {
  if (!value || typeof value !== 'object') return false;
  const point = value as { type?: unknown; coordinates?: unknown };
  if (point.type !== 'Point' || !Array.isArray(point.coordinates) || point.coordinates.length < 2) return false;
  const [longitude, latitude] = point.coordinates;
  return isFiniteCoordinate(longitude)
    && isFiniteCoordinate(latitude)
    && longitude >= -180
    && longitude <= 180
    && latitude >= -90
    && latitude <= 90;
}

/** Convert a stored obstacle into a validated Mapbox simplestyle point feature. */
export function fieldObstacleToGeoJsonFeature(
  obstacle: FieldObstacle,
): Feature<Point, FieldObstacleFeatureProperties> | null {
  if (!isFieldObstaclePoint(obstacle.point_geojson)) return null;
  const kindLabel = FIELD_OBSTACLE_KIND_LABELS[obstacle.kind];
  const label = obstacle.label?.trim() || kindLabel;
  return {
    type: 'Feature',
    properties: {
      id: obstacle.id,
      field_id: obstacle.field_id,
      kind: obstacle.kind,
      label,
      title: label === kindLabel ? kindLabel : `${kindLabel}: ${label}`,
      'marker-color': '#dc2626',
      'marker-size': 'small',
    },
    geometry: obstacle.point_geojson,
  };
}
