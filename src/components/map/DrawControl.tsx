import { useEffect, useCallback, useRef, useState } from 'react';
import { useControl } from 'react-map-gl/mapbox';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import type { GeoJSON } from 'geojson';
import DrawingHud from './DrawingHud';
import { drawingRingMetrics } from '../../lib/fieldGeometry';
import { shouldSyncInitialDrawFeatures } from '../../lib/fieldBoundaryState';

interface DrawControlProps {
  onDrawCreate?: (feature: GeoJSON.Feature) => void;
  onDrawUpdate?: (feature: GeoJSON.Feature) => void;
  onDrawDelete?: (featureIds: string[]) => void;
  initialGeoJSON?: GeoJSON.Feature | GeoJSON.Feature[] | null;
  allowRemoveSinglePart?: boolean;
  /** Prevents starting or changing a boundary while another map mode is active. */
  disabled?: boolean;
  /** Reports whether Mapbox Draw is currently collecting boundary vertices. */
  onDrawingStateChange?: (isDrawing: boolean) => void;
}

interface HudState {
  isDrawing: boolean;
  partCount: number;
  acres: number;
  corners: number;
}

const EMPTY_HUD: HudState = { isDrawing: false, partCount: 0, acres: 0, corners: 0 };

// Mapbox Draw's normal selection modes allow existing boundary polygons to be dragged. During
// obstacle placement, use a deliberately handler-free mode so those billable boundaries remain
// visible but cannot receive clicks or drags.
const STATIC_MODE: MapboxDraw.DrawCustomMode = {
  onSetup: () => ({}),
  toDisplayFeatures: (_state, geojson, display) => display(geojson),
};

export default function DrawControl({
  onDrawCreate,
  onDrawUpdate,
  onDrawDelete,
  initialGeoJSON,
  allowRemoveSinglePart = false,
  disabled = false,
  onDrawingStateChange,
}: DrawControlProps) {
  const drawRef = useRef<MapboxDraw | null>(null);
  const mapRef = useRef<{ getContainer: () => HTMLElement } | null>(null);
  const [hud, setHud] = useState<HudState>(EMPTY_HUD);
  const hudRef = useRef<HudState>(EMPTY_HUD);
  // Stable references for the draw.* listeners so onRemove can actually detach them.
  const listenersRef = useRef<Record<string, (e: unknown) => void>>({});
  // The control is registered once, so its map event listeners must read the current disabled
  // state rather than the value from their initial render.
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  // react-map-gl registers the useControl onAdd ONCE (its effect has [] deps), so the draw.*
  // listeners would otherwise close over the FIRST render's parent callbacks. DrawLayer rebuilds
  // its handlers as the polygon list grows (multi-part fields), so route through a ref kept current
  // every render — without this, committing a 2nd/3rd part fires a stale handler that overwrites
  // the earlier parts (the geometry that bills). Single-boundary callbacks are stable, so unaffected.
  const cbRef = useRef({ onDrawCreate, onDrawUpdate, onDrawDelete, onDrawingStateChange });
  cbRef.current = { onDrawCreate, onDrawUpdate, onDrawDelete, onDrawingStateChange };

  // Read the current draw state straight off the mapbox-gl-draw instance and push it to the
  // HUD. Driven by draw.render (fires on every mouse move while drawing) so the acreage forms
  // live; the change-guard keeps it from re-rendering when nothing actually changed.
  const recompute = useCallback((modeOverride?: string) => {
    const draw = drawRef.current;
    if (!draw) return;
    const mode = modeOverride ?? draw.getMode();
    const fc = draw.getAll();
    const drawing = mode === 'draw_polygon';
    const polys = fc.features.filter((f) => f.geometry?.type === 'Polygon');

    let acres = 0;
    let corners = 0;
    if (drawing && polys.length > 0) {
      // While drawing, the in-progress polygon is the most recently added (last) feature.
      const ring = (polys[polys.length - 1].geometry as GeoJSON.Polygon).coordinates[0];
      const m = drawingRingMetrics(ring);
      acres = m.acres; // area of the shape on screen, including the floating mouse-follow point (live preview)
      // Exclude mapbox-gl-draw's floating mouse-follow vertex from the committed-corner count —
      // but ONLY when the ring is open (its last point IS that floating vertex). If the cursor
      // momentarily sits on the first corner the ring reads closed, drawingRingMetrics already
      // dropped the duplicate, so subtracting again would under-count and flicker the Done gate.
      const last = ring.length > 0 ? ring[ring.length - 1] : null;
      const first = ring.length > 0 ? ring[0] : null;
      const ringClosed = !!first && !!last && first[0] === last[0] && first[1] === last[1];
      corners = ringClosed ? m.corners : Math.max(0, m.corners - 1);
    }

    const next: HudState = {
      isDrawing: drawing,
      partCount: fc.features.length,
      acres,
      corners,
    };
    const prev = hudRef.current;
    if (
      prev.isDrawing === next.isDrawing &&
      prev.partCount === next.partCount &&
      prev.acres === next.acres &&
      prev.corners === next.corners
    ) {
      return;
    }
    hudRef.current = next;
    setHud(next);
    cbRef.current.onDrawingStateChange?.(drawing);
  }, []);

  const draw = useControl<MapboxDraw>(
    () =>
      new MapboxDraw({
        displayControlsDefault: false,
        keybindings: false,
        controls: {
          polygon: true,
          // Boundary parts are removed from FieldSetup's confirmed part list so an accidental
          // tap on the map controls cannot silently discard a saved section.
          trash: false,
        },
        defaultMode: 'simple_select',
        modes: {
          ...MapboxDraw.modes,
          static: STATIC_MODE,
        },
        styles: [
          // Polygon fill
          {
            id: 'gl-draw-polygon-fill',
            type: 'fill',
            filter: ['all', ['==', '$type', 'Polygon'], ['!=', 'mode', 'static']],
            paint: {
              'fill-color': '#28A26A',
              'fill-outline-color': '#28A26A',
              'fill-opacity': 0.2,
            },
          },
          // Polygon stroke (active)
          {
            id: 'gl-draw-polygon-stroke-active',
            type: 'line',
            filter: ['all', ['==', '$type', 'Polygon'], ['!=', 'mode', 'static']],
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#28A26A', 'line-width': 2 },
          },
          // Polygon stroke (static)
          {
            id: 'gl-draw-polygon-fill-static',
            type: 'fill',
            filter: ['all', ['==', '$type', 'Polygon'], ['==', 'mode', 'static']],
            paint: { 'fill-color': '#28A26A', 'fill-outline-color': '#28A26A', 'fill-opacity': 0.15 },
          },
          {
            id: 'gl-draw-polygon-stroke-static',
            type: 'line',
            filter: ['all', ['==', '$type', 'Polygon'], ['==', 'mode', 'static']],
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#28A26A', 'line-width': 2 },
          },
          // Vertex points
          {
            id: 'gl-draw-point',
            type: 'circle',
            filter: ['all', ['==', '$type', 'Point'], ['==', 'meta', 'vertex']],
            paint: { 'circle-radius': 5, 'circle-color': '#28A26A' },
          },
          // Midpoints
          {
            id: 'gl-draw-point-mid',
            type: 'circle',
            filter: ['all', ['==', '$type', 'Point'], ['==', 'meta', 'midpoint']],
            paint: { 'circle-radius': 3, 'circle-color': '#28A26A' },
          },
        ],
      }),
    ({ map }) => {
      mapRef.current = map;
      const onCreate = (e: unknown) => {
        const features = (e as { features?: GeoJSON.Feature[] }).features;
        if (features && features.length > 0) cbRef.current.onDrawCreate?.(features[0]);
        recompute();
      };
      const onUpdate = (e: unknown) => {
        const features = (e as { features?: GeoJSON.Feature[] }).features;
        if (features && features.length > 0) cbRef.current.onDrawUpdate?.(features[0]);
        recompute();
      };
      const onDelete = (e: unknown) => {
        const features = (e as { features?: GeoJSON.Feature[] }).features;
        cbRef.current.onDrawDelete?.(features?.map((f) => f.id as string) || []);
        recompute();
      };
      const onModeChange = (e: unknown) => {
        const mode = (e as { mode?: string }).mode;
        // Keyboard bindings are disabled, but plugins and programmatic callers can still enter a
        // draw mode. Keep obstacle placement fail-closed by returning Draw to its inert mode.
        if (disabledRef.current && mode !== 'static') {
          drawRef.current?.changeMode('static');
          return;
        }
        recompute(mode);
      };
      const onRender = () => recompute();

      listenersRef.current = {
        'draw.create': onCreate,
        'draw.update': onUpdate,
        'draw.delete': onDelete,
        'draw.modechange': onModeChange,
        'draw.render': onRender,
      };
      map.on('draw.create', onCreate);
      map.on('draw.update', onUpdate);
      map.on('draw.delete', onDelete);
      map.on('draw.modechange', onModeChange);
      map.on('draw.render', onRender);
      recompute();
    },
    ({ map }) => {
      for (const [evt, fn] of Object.entries(listenersRef.current)) {
        map.off(evt, fn);
      }
      listenersRef.current = {};
    },
    { position: 'top-left' }
  );
  drawRef.current = draw;

  // Mapbox Draw's built-in polygon button lives outside React. Disable that button and the
  // React HUD together so obstacle-placement clicks cannot accidentally add a boundary vertex.
  // More importantly, static mode makes every existing boundary inert while the map click is
  // reserved for placing an obstacle pin.
  useEffect(() => {
    const d = drawRef.current;
    if (d) {
      if (disabled) d.changeMode('static');
      else d.changeMode('simple_select');
    }

    const buttons = mapRef.current?.getContainer().querySelectorAll<HTMLButtonElement>(
      '.mapbox-gl-draw_ctrl-draw-btn',
    ) ?? [];
    buttons.forEach((button) => {
      button.disabled = disabled;
      button.setAttribute('aria-disabled', String(disabled));
    });
  }, [disabled]);

  // Load initial geometry when available — supports single feature or array
  const loadInitial = useCallback(() => {
    const d = drawRef.current;
    if (!initialGeoJSON || !d) return;
    // A map move can re-render the parent while the user is placing a new section. Do not
    // replace Draw's feature collection in that mode: deleteAll() would erase the sketch.
    if (!shouldSyncInitialDrawFeatures(d.getMode())) return;
    try {
      d.deleteAll();
      const features = Array.isArray(initialGeoJSON) ? initialGeoJSON : [initialGeoJSON];
      for (const f of features) {
        d.add(f as unknown as GeoJSON.FeatureCollection);
      }
      recompute();
    } catch {
      // Silently handle invalid GeoJSON
    }
  }, [initialGeoJSON, recompute]);

  useEffect(() => {
    // Small delay to ensure draw control is fully initialized
    const timer = setTimeout(loadInitial, 200);
    return () => clearTimeout(timer);
  }, [loadInitial]);

  // HUD button handlers — these drive the SAME draw.create/draw.delete callbacks the manual
  // polygon/trash controls do, so the saved geometry + acreage preview stay correct.
  const handleStartDrawing = useCallback(() => {
    drawRef.current?.changeMode('draw_polygon');
  }, []);

  const handleDone = useCallback(() => {
    const d = drawRef.current;
    // Leaving draw_polygon mode commits the polygon and fires draw.create (when it has >=3
    // corners) — the same thing the hidden double-click does, but discoverable.
    if (d && d.getMode() === 'draw_polygon') d.changeMode('simple_select');
  }, []);

  const handleStartOver = useCallback(() => {
    const d = drawRef.current;
    // Only shown while drawing: abandon JUST the in-progress polygon and restart it. draw.trash()
    // in draw_polygon mode deletes the current (uncommitted) feature and exits to simple_select;
    // already-committed parts are untouched. Then re-enter draw mode so the user can redraw.
    if (d && d.getMode() === 'draw_polygon') {
      d.trash();
      d.changeMode('draw_polygon');
    }
  }, []);

  const handleReplaceBoundary = useCallback(() => {
    const d = drawRef.current;
    if (!d) return;
    // Only offered when exactly ONE boundary exists (single-boundary fields — the hand-drawn case),
    // so this clears one part and re-draws it. deleteAll() is silent (no draw.delete) → notify the
    // parent so it drops the boundary too; then re-enter draw mode for the replacement.
    const ids = d.getAll().features.map((f) => f.id as string).filter(Boolean);
    d.deleteAll();
    if (ids.length > 0) cbRef.current.onDrawDelete?.(ids);
    d.changeMode('draw_polygon');
  }, []);

  const handleRemoveSinglePart = useCallback(() => {
    const d = drawRef.current;
    if (!d || d.getMode() === 'draw_polygon') return;
    const ids = d.getAll().features.map((feature) => feature.id as string).filter(Boolean);
    if (ids.length !== 1) return;
    // deleteAll() is silent, so keep FieldSetup's confirmed list in sync explicitly.
    d.deleteAll();
    cbRef.current.onDrawDelete?.(ids);
    recompute();
  }, [recompute]);

  return (
    <DrawingHud
      isDrawing={hud.isDrawing}
      partCount={hud.partCount}
      acres={hud.acres}
      corners={hud.corners}
      onStartDrawing={handleStartDrawing}
      onReplace={handleReplaceBoundary}
      onDone={handleDone}
      onStartOver={handleStartOver}
      canRemoveSinglePart={allowRemoveSinglePart}
      onRemoveSinglePart={handleRemoveSinglePart}
      disabled={disabled}
    />
  );
}
