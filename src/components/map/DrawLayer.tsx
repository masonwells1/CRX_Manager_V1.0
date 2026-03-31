import { useCallback } from 'react';
import area from '@turf/area';
import centroid from '@turf/centroid';
import DrawControl from './DrawControl';
import type { Feature, Polygon } from 'geojson';

export interface DrawnPolygon {
  drawId: string;
  polygon: Feature<Polygon>;
  acres: number;
  label: string;
}

interface DrawLayerProps {
  /** Multi-polygon mode */
  initialPolygons?: DrawnPolygon[];
  onPolygonsChange?: (polygons: DrawnPolygon[]) => void;
  /** Legacy single-polygon mode (backward compat) */
  initialGeoJSON?: Feature<Polygon> | null;
  onBoundaryChange?: (boundary: Feature<Polygon>, acres: number, center: [number, number]) => void;
  onBoundaryDelete?: () => void;
}

/** Wrapper around DrawControl that auto-calculates acreage and centroid from drawn polygons */
export default function DrawLayer({
  initialPolygons,
  onPolygonsChange,
  initialGeoJSON,
  onBoundaryChange,
  onBoundaryDelete,
}: DrawLayerProps) {
  const isMultiMode = !!onPolygonsChange;

  // Determine initial features for DrawControl
  const initialFeatures = initialPolygons && initialPolygons.length > 0
    ? initialPolygons.map((p) => p.polygon)
    : initialGeoJSON
    ? [initialGeoJSON]
    : undefined;

  const handleCreate = useCallback(
    (feature: GeoJSON.Feature) => {
      if (feature.geometry.type !== 'Polygon') return;

      const polygon = feature as Feature<Polygon>;
      const sqMeters = area(polygon);
      const acres = Math.round((sqMeters / 4046.8564224) * 100) / 100;
      const center = centroid(polygon);
      const [lng, lat] = center.geometry.coordinates;

      // Multi-polygon mode: append to list
      if (isMultiMode && initialPolygons) {
        const newPoly: DrawnPolygon = {
          drawId: (feature.id as string) || crypto.randomUUID(),
          polygon,
          acres,
          label: `Polygon ${initialPolygons.length + 1}`,
        };
        onPolygonsChange?.([...initialPolygons, newPoly]);
        return;
      }

      // Legacy single-polygon mode
      onBoundaryChange?.(polygon, acres, [lng, lat]);
    },
    [isMultiMode, initialPolygons, onPolygonsChange, onBoundaryChange]
  );

  const handleUpdate = useCallback(
    (feature: GeoJSON.Feature) => {
      if (feature.geometry.type !== 'Polygon') return;

      const polygon = feature as Feature<Polygon>;
      const sqMeters = area(polygon);
      const acres = Math.round((sqMeters / 4046.8564224) * 100) / 100;
      const center = centroid(polygon);
      const [lng, lat] = center.geometry.coordinates;

      if (isMultiMode && initialPolygons) {
        const drawId = feature.id as string;
        const updated = initialPolygons.map((p) =>
          p.drawId === drawId ? { ...p, polygon, acres } : p
        );
        onPolygonsChange?.(updated);
        return;
      }

      onBoundaryChange?.(polygon, acres, [lng, lat]);
    },
    [isMultiMode, initialPolygons, onPolygonsChange, onBoundaryChange]
  );

  const handleDelete = useCallback(
    (featureIds: string[]) => {
      if (isMultiMode && initialPolygons) {
        const remaining = initialPolygons.filter((p) => !featureIds.includes(p.drawId));
        onPolygonsChange?.(remaining);
        return;
      }
      onBoundaryDelete?.();
    },
    [isMultiMode, initialPolygons, onPolygonsChange, onBoundaryDelete]
  );

  return (
    <DrawControl
      initialGeoJSON={initialFeatures && initialFeatures.length > 0 ? initialFeatures : null}
      onDrawCreate={handleCreate}
      onDrawUpdate={handleUpdate}
      onDrawDelete={handleDelete}
    />
  );
}
