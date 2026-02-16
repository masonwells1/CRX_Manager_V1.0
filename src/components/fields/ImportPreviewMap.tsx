import { useCallback } from 'react';
import { Source, Layer, type MapRef } from 'react-map-gl/mapbox';
import MapContainer from '../map/MapContainer';
import { bbox } from '../../lib/fieldImportParser';
import type { FeatureCollection, Polygon, GeoJsonProperties } from 'geojson';
import type { LngLatBoundsLike } from 'mapbox-gl';

interface ImportPreviewMapProps {
  featureCollection: FeatureCollection<Polygon, GeoJsonProperties>;
  className?: string;
}

export default function ImportPreviewMap({
  featureCollection,
  className = 'h-[350px] w-full rounded-lg overflow-hidden',
}: ImportPreviewMapProps) {
  const handleMapLoad = useCallback(
    (map: MapRef) => {
      if (featureCollection.features.length === 0) return;

      try {
        const bounds = bbox(featureCollection) as [number, number, number, number];
        map.fitBounds(bounds as LngLatBoundsLike, {
          padding: 40,
          maxZoom: 16,
          duration: 500,
        });
      } catch {
        // fallback: do nothing, map stays at default center
      }
    },
    [featureCollection]
  );

  return (
    <MapContainer className={className} onMapLoad={handleMapLoad}>
      <Source id="import-preview" type="geojson" data={featureCollection}>
        <Layer
          id="import-preview-fill"
          type="fill"
          paint={{
            'fill-color': '#28A26A',
            'fill-opacity': 0.2,
          }}
        />
        <Layer
          id="import-preview-outline"
          type="line"
          paint={{
            'line-color': '#28A26A',
            'line-width': 2,
          }}
        />
      </Source>
    </MapContainer>
  );
}
