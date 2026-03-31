import { useEffect, useCallback } from 'react';
import { useControl } from 'react-map-gl/mapbox';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import type { GeoJSON } from 'geojson';

interface DrawControlProps {
  onDrawCreate?: (feature: GeoJSON.Feature) => void;
  onDrawUpdate?: (feature: GeoJSON.Feature) => void;
  onDrawDelete?: (featureIds: string[]) => void;
  initialGeoJSON?: GeoJSON.Feature | GeoJSON.Feature[] | null;
}

export default function DrawControl({
  onDrawCreate,
  onDrawUpdate,
  onDrawDelete,
  initialGeoJSON,
}: DrawControlProps) {
  const draw = useControl<MapboxDraw>(
    () =>
      new MapboxDraw({
        displayControlsDefault: false,
        controls: {
          polygon: true,
          trash: true,
        },
        defaultMode: 'simple_select',
        styles: [
          // Polygon fill
          {
            id: 'gl-draw-polygon-fill',
            type: 'fill',
            filter: ['all', ['==', '$type', 'Polygon'], ['!=', 'mode', 'static']],
            paint: {
              'fill-color': '#28A26A',
              'fill-outline-color': '#28A26A',
              'fill-opacity': 0.2,
            },
          },
          // Polygon stroke (active)
          {
            id: 'gl-draw-polygon-stroke-active',
            type: 'line',
            filter: ['all', ['==', '$type', 'Polygon'], ['!=', 'mode', 'static']],
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#28A26A', 'line-width': 2 },
          },
          // Polygon stroke (static)
          {
            id: 'gl-draw-polygon-fill-static',
            type: 'fill',
            filter: ['all', ['==', '$type', 'Polygon'], ['==', 'mode', 'static']],
            paint: { 'fill-color': '#28A26A', 'fill-outline-color': '#28A26A', 'fill-opacity': 0.15 },
          },
          {
            id: 'gl-draw-polygon-stroke-static',
            type: 'line',
            filter: ['all', ['==', '$type', 'Polygon'], ['==', 'mode', 'static']],
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#28A26A', 'line-width': 2 },
          },
          // Vertex points
          {
            id: 'gl-draw-point',
            type: 'circle',
            filter: ['all', ['==', '$type', 'Point'], ['==', 'meta', 'vertex']],
            paint: { 'circle-radius': 5, 'circle-color': '#28A26A' },
          },
          // Midpoints
          {
            id: 'gl-draw-point-mid',
            type: 'circle',
            filter: ['all', ['==', '$type', 'Point'], ['==', 'meta', 'midpoint']],
            paint: { 'circle-radius': 3, 'circle-color': '#28A26A' },
          },
        ],
      }),
    ({ map }) => {
      map.on('draw.create', (e: { features: GeoJSON.Feature[] }) => {
        if (e.features?.length > 0) onDrawCreate?.(e.features[0]);
      });
      map.on('draw.update', (e: { features: GeoJSON.Feature[] }) => {
        if (e.features?.length > 0) onDrawUpdate?.(e.features[0]);
      });
      map.on('draw.delete', (e: { features: GeoJSON.Feature[] }) => {
        onDrawDelete?.(e.features?.map((f) => f.id as string) || []);
      });
    },
    ({ map }) => {
      map.off('draw.create', () => {});
      map.off('draw.update', () => {});
      map.off('draw.delete', () => {});
    },
    { position: 'top-left' }
  );

  // Load initial geometry when available — supports single feature or array
  const loadInitial = useCallback(() => {
    if (!initialGeoJSON || !draw) return;
    try {
      draw.deleteAll();
      const features = Array.isArray(initialGeoJSON) ? initialGeoJSON : [initialGeoJSON];
      for (const f of features) {
        draw.add(f as unknown as GeoJSON.FeatureCollection);
      }
    } catch {
      // Silently handle invalid GeoJSON
    }
  }, [initialGeoJSON, draw]);

  useEffect(() => {
    // Small delay to ensure draw control is fully initialized
    const timer = setTimeout(loadInitial, 200);
    return () => clearTimeout(timer);
  }, [loadInitial]);

  return null;
}
