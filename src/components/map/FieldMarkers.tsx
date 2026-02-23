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

interface FieldMarkersProps {
  fields: Field[];
  onFieldClick?: (fieldId: string) => void;
}

export default function FieldMarkers({ fields, onFieldClick }: FieldMarkersProps) {
  const [hovered, setHovered] = useState<FieldGeo | null>(null);

  // Parse centroid GeoJSON strings into usable coordinates
  const markers = useMemo(() => {
    const result: FieldGeo[] = [];
    for (const f of fields) {
      if (!f.centroid_geojson) continue;
      try {
        const geo = JSON.parse(f.centroid_geojson);
        if (geo?.type === 'Point' && Array.isArray(geo.coordinates)) {
          result.push({
            id: f.id,
            field_name: f.field_name,
            total_acres: f.total_acres,
            crop_type: f.crop_type,
            customer_name: (f as Field & { customer_name?: string }).customer_name || f.customer?.farm_name,
            lng: geo.coordinates[0],
            lat: geo.coordinates[1],
          });
        }
      } catch {
        // Skip invalid GeoJSON
      }
    }
    return result;
  }, [fields]);

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
            onFieldClick?.(m.id);
          }}
        >
          <div
            className="w-4 h-4 rounded-full bg-crx-green border-2 border-white shadow-md cursor-pointer hover:scale-125 transition-transform"
            onMouseEnter={() => setHovered(m)}
            onMouseLeave={() => setHovered(null)}
          />
        </Marker>
      ))}

      {hovered && (
        <Popup
          longitude={hovered.lng}
          latitude={hovered.lat}
          anchor="bottom"
          offset={12}
          closeButton={false}
          closeOnClick={false}
          className="field-marker-popup"
        >
          <div className="text-xs px-1 py-0.5">
            <p className="font-semibold text-nav-dark">{hovered.field_name}</p>
            {hovered.total_acres && (
              <p className="text-secondary">{hovered.total_acres.toLocaleString()} acres</p>
            )}
            {hovered.crop_type && (
              <p className="text-secondary capitalize">{hovered.crop_type}</p>
            )}
            {hovered.customer_name && (
              <p className="text-secondary">{hovered.customer_name}</p>
            )}
          </div>
        </Popup>
      )}
    </>
  );
}
