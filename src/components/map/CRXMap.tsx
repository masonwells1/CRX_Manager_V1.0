import { useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import Map, { NavigationControl, type MapRef } from 'react-map-gl/mapbox';
import 'mapbox-gl/dist/mapbox-gl.css';
import { Loader2, AlertTriangle, RefreshCw } from 'lucide-react';
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
  bounds?: [number, number, number, number] | null; // [minLng, minLat, maxLng, maxLat]
  boundsOptions?: { padding?: number; maxZoom?: number };
  className?: string;
  children?: ReactNode;
  onMapLoad?: (map: MapRef) => void;
  /** Fired after navigation settles so consumers can cheaply refresh viewport-dependent work. */
  onMapMoveEnd?: (center: [number, number]) => void;
  /** Fired when the map surface is clicked. Marker/layer handlers may stop propagation. */
  onMapClick?: (longitude: number, latitude: number) => void;
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
  bounds = null,
  boundsOptions = { padding: 60, maxZoom: 16 },
  printMode = false,
  className = 'h-[500px] w-full',
  children,
  onMapLoad,
  onMapMoveEnd,
  onMapClick,
}: CRXMapProps) {
  const [viewState, setViewState] = useState({
    longitude: center[0],
    latitude: center[1],
    zoom,
  });
  const [activeLayer, setActiveLayer] = useState<BaseLayerType>(baseLayer);

  const effectiveLayer = printMode ? 'roads' : activeLayer;

  const mapRef = useRef<MapRef | null>(null);

  // Map load lifecycle: show a spinner until the first load, and a retryable error state if
  // the map never loads. Transient tile/network errors AFTER a successful load are ignored.
  const [mapStatus, setMapStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [reloadKey, setReloadKey] = useState(0);
  const loadedRef = useRef(false);

  const handleLoad = useCallback(
    (evt: { target: MapRef }) => {
      mapRef.current = evt.target;
      loadedRef.current = true;
      setMapStatus('ready');
      onMapLoad?.(evt.target);
      // If bounds were set before map loaded, apply now
      if (bounds) {
        evt.target.fitBounds(
          [[bounds[0], bounds[1]], [bounds[2], bounds[3]]],
          { padding: boundsOptions?.padding ?? 60, maxZoom: boundsOptions?.maxZoom ?? 16 }
        );
      }
    },
    [onMapLoad, bounds, boundsOptions]
  );

  const handleError = useCallback((evt?: { sourceId?: string; tile?: unknown }) => {
    if (loadedRef.current) return;
    // Ignore transient tile/source-scoped errors before first load (a flaky rural connection can
    // drop a tile while the map is still coming up). Only a fatal style/auth load failure — which
    // is NOT source-scoped — should surface the retry overlay; a later successful 'load' clears it.
    if (evt && (evt.sourceId || evt.tile)) return;
    setMapStatus('error');
  }, []);

  const handleRetry = useCallback(() => {
    loadedRef.current = false;
    setMapStatus('loading');
    setReloadKey((k) => k + 1); // remount the Map to retry the style/tile load
  }, []);

  // Re-fit bounds when they change after initial load
  useEffect(() => {
    if (!bounds || !mapRef.current) return;
    mapRef.current.fitBounds(
      [[bounds[0], bounds[1]], [bounds[2], bounds[3]]],
      { padding: boundsOptions?.padding ?? 60, maxZoom: boundsOptions?.maxZoom ?? 16 }
    );
  }, [bounds, boundsOptions]);

  const handleLocate = useCallback((longitude: number, latitude: number) => {
    setViewState((prev) => ({ ...prev, longitude, latitude, zoom: 15 }));
  }, []);

  const handleMoveEnd = useCallback((evt: { viewState: { longitude: number; latitude: number } }) => {
    onMapMoveEnd?.([evt.viewState.longitude, evt.viewState.latitude]);
  }, [onMapMoveEnd]);

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
        key={reloadKey}
        {...viewState}
        onMove={(evt) => setViewState(evt.viewState)}
        onMoveEnd={handleMoveEnd}
        onClick={(evt) => onMapClick?.(evt.lngLat.lng, evt.lngLat.lat)}
        mapboxAccessToken={MAPBOX_TOKEN}
        mapStyle={BASE_LAYERS[effectiveLayer]}
        style={{ width: '100%', height: '100%' }}
        interactive={interactive}
        onLoad={handleLoad as unknown as (e: unknown) => void}
        onError={handleError as unknown as (e: unknown) => void}
        attributionControl={false}
      >
        {interactive && <NavigationControl position="top-right" />}
        {showLocateMe && <LocateMe onLocate={handleLocate} />}
        {children}
      </Map>
      {showLayerToggle && (
        <LayerToggle activeLayer={activeLayer} onChange={setActiveLayer} />
      )}
      {mapStatus === 'loading' && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-gray-100/80 pointer-events-none">
          <div className="flex items-center gap-2 text-sm text-secondary">
            <Loader2 className="w-5 h-5 animate-spin text-crx-green" />
            Loading map...
          </div>
        </div>
      )}
      {mapStatus === 'error' && (
        <button
          type="button"
          onClick={handleRetry}
          className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-gray-100 px-4 text-center"
        >
          <AlertTriangle className="w-6 h-6 text-amber-500" />
          <p className="text-sm font-medium text-gray-600">Map could not load</p>
          <span className="flex items-center gap-1.5 text-xs font-medium text-crx-green">
            <RefreshCw className="w-3.5 h-3.5" />
            Tap to retry
          </span>
        </button>
      )}
    </div>
  );
}
