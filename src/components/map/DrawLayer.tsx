import { useCallback } from 'react';
import area from '@turf/area';
import centroid from '@turf/centroid';
import DrawControl from './DrawControl';
import type { Feature, Polygon } from 'geojson';

interface DrawLayerProps {
  initialGeoJSON?: Feature<Polygon> | null;
  onBoundaryChange?: (boundary: Feature<Polygon>, acres: number, center: [number, number]) => void;
  onBoundaryDelete?: () => void;
}

/** Wrapper around DrawControl that auto-calculates acreage and centroid from drawn polygons */
export default function DrawLayer({
  initialGeoJSON,
  onBoundaryChange,
  onBoundaryDelete,
}: DrawLayerProps) {
  const handleDrawChange = useCallback(
    (feature: GeoJSON.Feature) => {
      if (feature.geometry.type !== 'Polygon') return;

      const polygon = feature as Feature<Polygon>;
      const sqMeters = area(polygon);
      const acres = Math.round((sqMeters / 4046.8564224) * 100) / 100;
      const center = centroid(polygon);
      const [lng, lat] = center.geometry.coordinates;

      onBoundaryChange?.(polygon, acres, [lng, lat]);
    },
    [onBoundaryChange]
  );

  return (
    <DrawControl
      initialGeoJSON={initialGeoJSON}
      onDrawCreate={handleDrawChange}
      onDrawUpdate={handleDrawChange}
      onDrawDelete={onBoundaryDelete}
    />
  );
}
