import { useMemo } from 'react';
import { Source, Layer } from 'react-map-gl/mapbox';
import type { Field } from '../../types';

interface FieldWithCustomer extends Field {
  customer_name?: string;
}

interface FieldBoundaryLayerProps {
  fields: FieldWithCustomer[];
  showLabels?: boolean;
}

export default function FieldBoundaryLayer({
  fields,
  showLabels = true,
}: FieldBoundaryLayerProps) {
  const geojson = useMemo(() => {
    const features = fields
      .filter((f) => f.boundary_geojson)
      .map((f) => {
        try {
          const geometry =
            typeof f.boundary_geojson === 'string'
              ? JSON.parse(f.boundary_geojson)
              : f.boundary_geojson;
          return {
            type: 'Feature' as const,
            properties: {
              id: f.id,
              field_name: f.field_name,
              total_acres: f.total_acres,
              crop_type: f.crop_type,
              customer_name:
                f.customer_name || f.customer?.farm_name || '',
            },
            geometry,
          };
        } catch {
          return null;
        }
      })
      .filter((f): f is NonNullable<typeof f> => f !== null);

    return { type: 'FeatureCollection' as const, features };
  }, [fields]);

  return (
    <Source id="field-boundaries" type="geojson" data={geojson}>
      <Layer
        id="field-boundaries-fill"
        type="fill"
        paint={{
          'fill-color': '#28A26A',
          'fill-opacity': 0.2,
        }}
      />
      <Layer
        id="field-boundaries-outline"
        type="line"
        paint={{
          'line-color': '#28A26A',
          'line-width': 2,
        }}
      />
      {showLabels && (
        <Layer
          id="field-boundaries-labels"
          type="symbol"
          layout={{
            'text-field': ['get', 'field_name'],
            'text-size': 12,
            'text-anchor': 'center',
            'text-allow-overlap': false,
          }}
          paint={{
            'text-color': '#ffffff',
            'text-halo-color': '#000000',
            'text-halo-width': 1,
          }}
        />
      )}
    </Source>
  );
}
