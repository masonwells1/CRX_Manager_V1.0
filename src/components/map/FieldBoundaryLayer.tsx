import { useMemo, useEffect } from 'react';
import { Source, Layer, useMap } from 'react-map-gl/mapbox';
import { billableAcres } from '../../lib/fieldGeometry';
import type { Customer, Field } from '../../types';

type FieldWithCustomer = Pick<Field, 'id' | 'field_name' | 'total_acres' | 'crop_type' | 'boundary_geojson' | 'override_acres' | 'measured_acres'> & {
  customer_name?: string | null;
  customer?: Pick<Customer, 'farm_name'> | null;
  billable_acres?: number | null;
};

interface FieldBoundaryLayerProps {
  fields: FieldWithCustomer[];
  showLabels?: boolean;
  /** Optional per-field prefix for boundary labels, such as a route number. */
  labelById?: Map<string, string>;
  onFieldClick?: (fieldId: string) => void;
  /** Phase 6 (2026-04-30): when set, fields with id in this set render highlighted. Lets the map double as a selection picker. */
  selectedIds?: Set<string>;
  /** Hover state can be shared with a companion table. */
  hoveredId?: string | null;
  onFieldHover?: (fieldId: string | null) => void;
}

export default function FieldBoundaryLayer({
  fields,
  showLabels = true,
  labelById,
  onFieldClick,
  selectedIds,
  hoveredId,
  onFieldHover,
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
          const b = f.billable_acres ?? billableAcres(f.override_acres, f.measured_acres, f.total_acres);
          const fieldLabel = labelById?.get(f.id)
            ? `${labelById.get(f.id)} · ${f.field_name}`
            : f.field_name;
          return {
            type: 'Feature' as const,
            properties: {
              id: f.id,
              field_name: f.field_name,
              // Map label shows the field name with its billable acres beneath it.
              label: b != null ? `${fieldLabel}\n${b} ac` : fieldLabel,
              total_acres: f.total_acres,
              crop_type: f.crop_type,
              customer_name:
                f.customer_name || f.customer?.farm_name || '',
              // Phase 6: stamp selection state into the feature so paint
              // expressions can pick it up. Re-derived whenever selectedIds changes.
              selected: selectedIds ? selectedIds.has(f.id) : false,
              hovered: hoveredId === f.id,
            },
            geometry,
          };
        } catch {
          return null;
        }
      })
      .filter((f): f is NonNullable<typeof f> => f !== null);

    return { type: 'FeatureCollection' as const, features };
  }, [fields, hoveredId, labelById, selectedIds]);

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
    const handleMouseMove = (e: mapboxgl.MapMouseEvent) => {
      map.getCanvas().style.cursor = 'pointer';
      const features = map.queryRenderedFeatures(e.point, {
        layers: ['field-boundaries-fill'],
      });
      onFieldHover!(features[0]?.properties?.id ?? null);
    };
    const handleMouseLeave = () => {
      map.getCanvas().style.cursor = '';
      onFieldHover?.(null);
    };
    const handleMouseEnter = () => {
      map.getCanvas().style.cursor = 'pointer';
    };

    map.on('click', 'field-boundaries-fill', handleClick);
    if (onFieldHover) {
      map.on('mousemove', 'field-boundaries-fill', handleMouseMove);
      map.on('mouseleave', 'field-boundaries-fill', handleMouseLeave);
    } else {
      map.on('mouseenter', 'field-boundaries-fill', handleMouseEnter);
      map.on('mouseleave', 'field-boundaries-fill', handleMouseLeave);
    }

    return () => {
      map.off('click', 'field-boundaries-fill', handleClick);
      if (onFieldHover) {
        map.off('mousemove', 'field-boundaries-fill', handleMouseMove);
        map.off('mouseleave', 'field-boundaries-fill', handleMouseLeave);
      } else {
        map.off('mouseenter', 'field-boundaries-fill', handleMouseEnter);
        map.off('mouseleave', 'field-boundaries-fill', handleMouseLeave);
      }
    };
  }, [map, onFieldClick, onFieldHover]);

  return (
    <Source id="field-boundaries" type="geojson" data={geojson}>
      <Layer
        id="field-boundaries-fill"
        type="fill"
        paint={{
          'fill-color': ['case', ['get', 'selected'], '#f59e0b', ['get', 'hovered'], '#2563eb', '#28A26A'],
          // Phase 6: selected fields render at higher opacity so the user can see
          // which ones are picked at a glance — without losing the unselected ones.
          'fill-opacity': ['case', ['get', 'selected'], 0.6, ['get', 'hovered'], 0.4, 0.18],
        }}
      />
      <Layer
        id="field-boundaries-outline"
        type="line"
        paint={{
          'line-color': ['case', ['get', 'selected'], '#b45309', ['get', 'hovered'], '#1d4ed8', '#28A26A'],
          'line-width': ['case', ['get', 'selected'], 3, ['get', 'hovered'], 3, 2],
        }}
      />
      {showLabels && (
        <Layer
          id="field-boundaries-labels"
          type="symbol"
          layout={{
            'text-field': ['get', 'label'],
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
