import { Pencil, Plus, Check, RotateCcw } from 'lucide-react';

export interface DrawingHudProps {
  /** True while mapbox-gl-draw is in draw_polygon mode (the user is placing corners). */
  isDrawing: boolean;
  /** How many boundary parts (features) currently exist on the map. */
  partCount: number;
  /** Live geodesic acres of the shape forming on screen (0 until 3+ corners). */
  acres: number;
  /** Committed corner count (the floating mouse-follow vertex is excluded by the caller). */
  corners: number;
  /**
   * Enter draw mode to ADD a boundary part — never clears existing parts. Used when there are
   * 0 parts ("Draw field boundary") or 2+ parts ("Draw another part", only reachable on imported
   * multi-part fields, where appending genuinely works).
   */
  onStartDrawing: () => void;
  /** Replace the single existing boundary (only offered at exactly 1 part — the hand-drawn case). */
  onReplace: () => void;
  /** Finish the in-progress polygon without needing the hidden double-click. */
  onDone: () => void;
  /** Abandon ONLY the in-progress polygon and restart it (does not touch committed parts). */
  onStartOver: () => void;
}

const MIN_CORNERS = 3;

/**
 * On-map overlay that makes drawing a field boundary self-explanatory (SOW-F1):
 * a discoverable "Draw field boundary" entry point, live instructions, the live
 * acreage + corner count as the shape forms (the acreage is what the field bills on),
 * and explicit Done / Start-over buttons so finishing never depends on the undiscoverable
 * double-click. Purely presentational — all map/draw glue lives in DrawControl, so this
 * renders and is unit-tested from plain props with no map dependency.
 */
export default function DrawingHud({
  isDrawing,
  partCount,
  acres,
  corners,
  onStartDrawing,
  onReplace,
  onDone,
  onStartOver,
}: DrawingHudProps) {
  // Not drawing: show one clear, SAFE entry point (the #1 fix — staff couldn't find how to
  // start/finish). The action is part-count aware so it is always honest and never wipes
  // multiple parts: 0 -> draw the boundary; exactly 1 -> redraw (replace that single boundary);
  // 2+ (an imported multi-part field) -> add another part (additive, never destructive).
  // Removing a part is done granularly via the native trash control / the per-part list in the form.
  if (!isDrawing) {
    const single = partCount === 1;
    const empty = partCount === 0;
    const label = empty ? 'Draw field boundary' : single ? 'Redraw boundary' : 'Draw another part';
    return (
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10">
        <button
          type="button"
          onClick={single ? onReplace : onStartDrawing}
          className="flex items-center gap-2 bg-crx-green text-white rounded-lg shadow-md px-4 py-2.5 text-sm font-semibold hover:bg-crx-green/90 transition-colors"
        >
          {empty || single ? <Pencil className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
          {label}
        </button>
      </div>
    );
  }

  const ready = corners >= MIN_CORNERS;

  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 w-[min(92%,28rem)]">
      <div className="bg-white rounded-lg shadow-lg border border-gray-200 overflow-hidden">
        {/* Instructions */}
        <div className="px-3 py-2 bg-crx-green-light border-b border-crx-green/20">
          <p className="text-xs text-crx-green font-medium">
            Tap each corner of the field, then double-tap the last point to finish.
          </p>
        </div>

        {/* Live acreage + corner count */}
        <div className="px-3 py-2.5 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-nav-dark">
              {acres > 0 ? (
                <>Drawing ~ {acres.toFixed(1)} ac</>
              ) : (
                <>Drawing field boundary...</>
              )}
            </p>
            <p className="text-xs text-secondary">
              {corners} {corners === 1 ? 'corner' : 'corners'} placed
              {!ready && ` (need ${MIN_CORNERS} to finish)`}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onStartOver}
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-secondary hover:bg-gray-50 transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Start over
            </button>
            <button
              type="button"
              onClick={onDone}
              disabled={!ready}
              title={ready ? 'Finish this boundary' : `Place at least ${MIN_CORNERS} corners`}
              className="flex items-center gap-1.5 rounded-lg bg-crx-green px-3 py-1.5 text-xs font-semibold text-white hover:bg-crx-green/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Check className="w-3.5 h-3.5" />
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
