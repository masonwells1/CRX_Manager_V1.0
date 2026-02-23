import { useState, useCallback, type ReactNode } from 'react';
import Map, { NavigationControl, type MapRef } from 'react-map-gl/mapbox';
import 'mapbox-gl/dist/mapbox-gl.css';

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;
const DEFAULT_CENTER: [number, number] = [-89.0, 40.0]; // Central Illinois
const DEFAULT_ZOOM = 7;
const SATELLITE_STYLE = 'mapbox://styles/mapbox/satellite-streets-v12';

interface MapContainerProps {
  center?: [number, number]; // [lng, lat]
  zoom?: number;
  className?: string;
  children?: ReactNode;
  interactive?: boolean;
  onMapLoad?: (map: MapRef) => void;
}

export default function MapContainer({
  center = DEFAULT_CENTER,
  zoom = DEFAULT_ZOOM,
  className = 'h-[400px] w-full rounded-lg overflow-hidden',
  children,
  interactive = true,
  onMapLoad,
}: MapContainerProps) {
  const [viewState, setViewState] = useState({
    longitude: center[0],
    latitude: center[1],
    zoom,
  });

  const handleLoad = useCallback(
    (evt: { target: MapRef }) => {
      onMapLoad?.(evt.target);
    },
    [onMapLoad]
  );

  if (!MAPBOX_TOKEN) {
    return (
      <div className={`${className} bg-gray-100 flex items-center justify-center border border-gray-200`}>
        <div className="text-center px-4">
          <p className="text-sm font-medium text-gray-500">Map not available</p>
          <p className="text-xs text-gray-400 mt-1">
            Set VITE_MAPBOX_TOKEN in your .env file to enable maps
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={className}>
      <Map
        {...viewState}
        onMove={(evt) => setViewState(evt.viewState)}
        mapboxAccessToken={MAPBOX_TOKEN}
        mapStyle={SATELLITE_STYLE}
        style={{ width: '100%', height: '100%' }}
        interactive={interactive}
        onLoad={handleLoad as unknown as (e: unknown) => void}
        attributionControl={false}
      >
        {interactive && <NavigationControl position="top-right" />}
        {children}
      </Map>
    </div>
  );
}
