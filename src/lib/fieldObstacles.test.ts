import { describe, expect, it } from 'vitest';
import {
  canEnterObstacleMode,
  FIELD_OBSTACLE_KIND_LABELS,
  fieldObstacleToGeoJsonFeature,
} from './fieldObstacles';
import type { FieldObstacle } from '../types';

const obstacle: FieldObstacle = {
  id: 'obstacle-1',
  field_id: 'field-1',
  kind: 'windmill',
  label: 'North windmill',
  point_geojson: { type: 'Point', coordinates: [-89.1, 39.2] },
  created_by: 'user-1',
  created_at: '2026-07-11T12:00:00Z',
  updated_at: '2026-07-11T12:00:00Z',
};

describe('field obstacles', () => {
  it('blocks obstacle mode while a boundary sketch is in progress', () => {
    expect(canEnterObstacleMode(true)).toBe(false);
    expect(canEnterObstacleMode(false)).toBe(true);
  });

  it('provides a human label for every stored kind', () => {
    expect(FIELD_OBSTACLE_KIND_LABELS).toEqual({
      oil_well: 'Oil well',
      windmill: 'Windmill',
      tower: 'Tower',
      tree_line: 'Tree line',
      power_line: 'Power line',
      waterway: 'Waterway',
      other: 'Other',
    });
  });

  it('maps a valid obstacle to a red small Mapbox point feature', () => {
    expect(fieldObstacleToGeoJsonFeature(obstacle)).toEqual({
      type: 'Feature',
      properties: {
        id: 'obstacle-1',
        field_id: 'field-1',
        kind: 'windmill',
        label: 'North windmill',
        title: 'Windmill: North windmill',
        'marker-color': '#dc2626',
        'marker-size': 'small',
      },
      geometry: { type: 'Point', coordinates: [-89.1, 39.2] },
    });
  });

  it('rejects malformed or out-of-range point geometry', () => {
    expect(fieldObstacleToGeoJsonFeature({
      ...obstacle,
      point_geojson: { type: 'Point', coordinates: [200, 95] },
    })).toBeNull();
  });
});
