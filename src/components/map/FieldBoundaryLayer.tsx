import { useMemo, useEffect } from 'react';
import { Source, Layer, useMap } from 'react-map-gl/mapbox';
import type { Field } from '../../types';

interface FieldWithCustomer extends Field {
  customer_name?: string;
}

interface FieldBoundaryLayerProps {
  fields: FieldWithCustomer[];
  showLabels?: boolean;
  onFieldClick?: (fieldId: string) => void;
  /** Phase 6 (2026-04-30): when set, fields with id in this set render highlighted. Lets the map double as a selection picker. */
  selectedIds?: Set<string>;
}

export default function FieldBoundaryLayer({
  fields,
  showLabels = true,
  onFieldClick,
  selectedIds,
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
              // Phase 6: stamp selection state into the feature so paint
              // expressions can pick it up. Re-derived whenever selectedIds changes.
              selected: selectedIds ? selectedIds.has(f.id) : false,
            },
            geometry,
          };
        } catch {
          return null;
        }
      })
      .filter((f): f is NonNullable<typeof f> => f !== null);

    return { type: 'FeatureCollection' as const, features };
  }, [fields, selectedIds]);

  // Click handler for boundary polygons
  const { current: map } = useMap();
  useEffect(() => {
    if (!map || !onFieldClick) return;

    const handleClick = (e: mapboxgl.MapMouseEvent) => {
      const features = map.queryRenderedFeatures(e.point, {
        layers: ['field-boundaries-fill'],
      });
      if (features && features.length > 0) {
        const fieldId = features[0].properties?.id;
        if (fieldId) onFieldClick(fieldId);
      }
    };
    const handleMouseEnter = () => {
      map.getCanvas().style.cursor = 'pointer';
    };
    const handleMouseLeave = () => {
      map.getCanvas().style.cursor = '';
    };

    map.on('click', 'field-boundaries-fill', handleClick);
    map.on('mouseenter', 'field-boundaries-fill', handleMouseEnter);
    map.on('mouseleave', 'field-boundaries-fill', handleMouseLeave);

    return () => {
      map.off('click', 'field-boundaries-fill', handleClick);
      map.off('mouseenter', 'field-boundaries-fill', handleMouseEnter);
      map.off('mouseleave', 'field-boundaries-fill', handleMouseLeave);
    };
  }, [map, onFieldClick]);

  return (
    <Source id="field-boundaries" type="geojson" data={geojson}>
      <Layer
        id="field-boundaries-fill"
        type="fill"
        paint={{
          'fill-color': '#28A26A',
          // Phase 6: selected fields render at higher opacity so the user can see
          // which ones are picked at a glance — without losing the unselected ones.
          'fill-opacity': ['case', ['get', 'selected'], 0.55, 0.18],
        }}
      />
      <Layer
        id="field-boundaries-outline"
        type="line"
        paint={{
          'line-color': ['case', ['get', 'selected'], '#0f5132', '#28A26A'],
          'line-width': ['case', ['get', 'selected'], 3, 2],
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
