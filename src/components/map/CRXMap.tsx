import { useState, useCallback, type ReactNode } from 'react';
import Map, { NavigationControl, type MapRef } from 'react-map-gl/mapbox';
import 'mapbox-gl/dist/mapbox-gl.css';
import LayerToggle from './LayerToggle';
import LocateMe from './LocateMe';

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;

const BASE_LAYERS = {
  satellite: 'mapbox://styles/mapbox/satellite-streets-v12',
  roads: 'mapbox://styles/mapbox/streets-v12',
  hybrid: 'mapbox://styles/mapbox/satellite-streets-v12',
  terrain: 'mapbox://styles/mapbox/outdoors-v12',
} as const;

export type BaseLayerType = keyof typeof BASE_LAYERS;

export interface CRXMapProps {
  center?: [number, number];
  zoom?: number;
  baseLayer?: BaseLayerType;
  interactive?: boolean;
  showLayerToggle?: boolean;
  showLocateMe?: boolean;
  printMode?: boolean;
  className?: string;
  children?: ReactNode;
  onMapLoad?: (map: MapRef) => void;
}

const DEFAULT_CENTER: [number, number] = [-89.0, 40.0];
const DEFAULT_ZOOM = 7;

export default function CRXMap({
  center = DEFAULT_CENTER,
  zoom = DEFAULT_ZOOM,
  baseLayer = 'satellite',
  interactive = true,
  showLayerToggle = false,
  showLocateMe = false,
  printMode = false,
  className = 'h-[500px] w-full',
  children,
  onMapLoad,
}: CRXMapProps) {
  const [viewState, setViewState] = useState({
    longitude: center[0],
    latitude: center[1],
    zoom,
  });
  const [activeLayer, setActiveLayer] = useState<BaseLayerType>(baseLayer);

  const effectiveLayer = printMode ? 'roads' : activeLayer;

  const handleLoad = useCallback(
    (evt: { target: MapRef }) => {
      onMapLoad?.(evt.target);
    },
    [onMapLoad]
  );

  const handleLocate = useCallback((longitude: number, latitude: number) => {
    setViewState((prev) => ({ ...prev, longitude, latitude, zoom: 15 }));
  }, []);

  if (!MAPBOX_TOKEN) {
    return (
      <div className={`${className} bg-gray-100 rounded-lg flex items-center justify-center border border-gray-200`}>
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
    <div className={`${className} relative rounded-lg overflow-hidden`}>
      <Map
        {...viewState}
        onMove={(evt) => setViewState(evt.viewState)}
        mapboxAccessToken={MAPBOX_TOKEN}
        mapStyle={BASE_LAYERS[effectiveLayer]}
        style={{ width: '100%', height: '100%' }}
        interactive={interactive}
        onLoad={handleLoad as unknown as (e: unknown) => void}
        attributionControl={false}
      >
        {interactive && <NavigationControl position="top-right" />}
        {showLocateMe && <LocateMe onLocate={handleLocate} />}
        {children}
      </Map>
      {showLayerToggle && (
        <LayerToggle activeLayer={activeLayer} onChange={setActiveLayer} />
      )}
    </div>
  );
}
