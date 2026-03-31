import { useState, useMemo } from 'react';
import { Marker, Popup } from 'react-map-gl/mapbox';
import type { Field } from '../../types';

interface FieldGeo {
  id: string;
  field_name: string;
  total_acres: number | null;
  crop_type: string | null;
  customer_name?: string;
  lng: number;
  lat: number;
}

interface FieldMarkerLayerProps {
  fields: Field[];
  onFieldClick?: (fieldId: string) => void;
  /** When true, shows markers for ALL fields with centroids. When false (default), only for fields WITHOUT boundaries */
  showAll?: boolean;
}

export default function FieldMarkerLayer({
  fields,
  onFieldClick,
  showAll = false,
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
            crop_type: f.crop_type,
            customer_name:
              (f as Field & { customer_name?: string }).customer_name ||
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
            setSelected(m);
          }}
        >
          <div
            className="w-4 h-4 rounded-full bg-crx-green border-2 border-white shadow-md cursor-pointer hover:scale-125 transition-transform"
          />
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
            {selected.total_acres && (
              <p className="text-secondary">
                {selected.total_acres.toLocaleString()} acres
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
