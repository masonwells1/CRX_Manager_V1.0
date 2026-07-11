import { useState, useMemo } from 'react';
import { Marker, Popup } from 'react-map-gl/mapbox';
import type { Customer, Field } from '../../types';
import { billableAcres } from '../../lib/fieldGeometry';

type MappableField = Pick<Field, 'id' | 'field_name' | 'total_acres' | 'crop_type' | 'centroid_geojson' | 'boundary_geojson' | 'override_acres' | 'measured_acres'> & {
  customer_name?: string | null;
  customer?: Pick<Customer, 'farm_name'> | null;
  billable_acres?: number | null;
};

interface FieldGeo {
  id: string;
  field_name: string;
  total_acres: number | null;
  billable_acres: number | null;
  crop_type: string | null;
  customer_name?: string;
  lng: number;
  lat: number;
}

interface FieldMarkerLayerProps {
  fields: MappableField[];
  onFieldClick?: (fieldId: string) => void;
  /** When true, shows markers for ALL fields with centroids. When false (default), only for fields WITHOUT boundaries */
  showAll?: boolean;
  selectedIds?: ReadonlySet<string>;
  hoveredId?: string | null;
  onFieldHover?: (fieldId: string | null) => void;
  /** A selection picker should toggle directly instead of opening the information popup. */
  selectOnClick?: boolean;
  showLabels?: boolean;
}

export default function FieldMarkerLayer({
  fields,
  onFieldClick,
  showAll = false,
  selectedIds,
  hoveredId,
  onFieldHover,
  selectOnClick = false,
  showLabels = false,
}: FieldMarkerLayerProps) {
  const [selected, setSelected] = useState<FieldGeo | null>(null);

  const markers = useMemo(() => {
    const result: FieldGeo[] = [];
    for (const f of fields) {
      if (!f.centroid_geojson) continue;
      // Skip fields with boundaries unless showAll — boundary layer handles those
      if (!showAll && f.boundary_geojson) continue;
      try {
        const geo = JSON.parse(f.centroid_geojson);
        if (geo?.type === 'Point' && Array.isArray(geo.coordinates)) {
          result.push({
            id: f.id,
            field_name: f.field_name,
            total_acres: f.total_acres,
            billable_acres: f.billable_acres ?? billableAcres(f.override_acres, f.measured_acres, f.total_acres),
            crop_type: f.crop_type,
            customer_name:
              f.customer_name ||
              f.customer?.farm_name,
            lng: geo.coordinates[0],
            lat: geo.coordinates[1],
          });
        }
      } catch {
        // Skip invalid GeoJSON
      }
    }
    return result;
  }, [fields, showAll]);

  if (markers.length === 0) return null;

  return (
    <>
      {markers.map((m) => (
        <Marker
          key={m.id}
          longitude={m.lng}
          latitude={m.lat}
          anchor="center"
          onClick={(e) => {
            e.originalEvent.stopPropagation();
            if (selectOnClick) {
              onFieldClick?.(m.id);
              return;
            }
            setSelected(m);
          }}
        >
          <div
            onMouseEnter={() => onFieldHover?.(m.id)}
            onMouseLeave={() => onFieldHover?.(null)}
            className="relative cursor-pointer"
          >
            <div className={`h-4 w-4 rounded-full border-2 border-white shadow-md transition-transform hover:scale-125 ${
              selectedIds?.has(m.id) ? 'bg-amber-500' : hoveredId === m.id ? 'bg-blue-600' : 'bg-crx-green'
            }`} />
            {showLabels && (
              <span className="pointer-events-none absolute left-1/2 top-5 -translate-x-1/2 whitespace-nowrap rounded bg-black/70 px-1.5 py-0.5 text-center text-[10px] font-medium text-white shadow">
                {m.field_name}<br />
                {m.billable_acres == null ? <>&mdash;</> : `${m.billable_acres.toLocaleString()} ac`}
              </span>
            )}
          </div>
        </Marker>
      ))}

      {selected && (
        <Popup
          longitude={selected.lng}
          latitude={selected.lat}
          anchor="bottom"
          offset={12}
          closeButton
          closeOnClick={false}
          onClose={() => setSelected(null)}
          className="field-marker-popup"
        >
          <div className="text-xs px-1 py-1 space-y-0.5">
            <p className="font-semibold text-nav-dark">{selected.field_name}</p>
            {selected.billable_acres != null && (
              <p className="text-secondary">
                {selected.billable_acres.toLocaleString()} acres
              </p>
            )}
            {selected.crop_type && (
              <p className="text-secondary capitalize">{selected.crop_type}</p>
            )}
            {selected.customer_name && (
              <p className="text-secondary">{selected.customer_name}</p>
            )}
            <button
              onClick={() => onFieldClick?.(selected.id)}
              className="mt-1 text-xs font-medium text-crx-green hover:underline"
            >
              View Dashboard &rarr;
            </button>
          </div>
        </Popup>
      )}
    </>
  );
}
