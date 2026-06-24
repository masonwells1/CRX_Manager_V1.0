# SOW-F1 - Guided Map Drawing

## Goal
Make drawing a field boundary on the satellite map self-explanatory, with the acreage visible
**while** you draw. Today the draw tool is the bare `@mapbox/mapbox-gl-draw` polygon control: you
tap corners and must **double-click to finish** (undiscoverable, nothing tells you), the acreage
(which becomes the bill) only appears after saving, there is no undo / no explicit Done button, and
there is no map loading state.

## Why it matters
The drawn boundary's measured acres are what a field bills on (override ?? measured ?? legacy). A
user who can't figure out how to finish may save a field with **no boundary at all** (a real failure
mode the UX review found). Seeing acreage form live lets staff sanity-check "this should be ~80 ac".

## Risk
**Frontend-only.** No DB / RPC / migration. Enablers already present: `@turf/area` (used in
`DrawLayer.tsx`), `@mapbox/mapbox-gl-draw`, and a `boundaryAcres` turf preview in `FieldSetup.tsx`.

## Files (read these first; confirm current shape)
- `src/components/map/DrawControl.tsx` - the MapboxDraw control (polygon + trash, custom styles).
- `src/components/map/DrawLayer.tsx` - already computes `area(polygon)` sq meters via turf.
- `src/components/map/CRXMap.tsx` - the map wrapper (add loading/retry here).
- `src/pages/FieldSetup.tsx` - where a single field boundary is drawn; owns `boundaryAcres`.
- (likely NEW) `src/components/map/DrawingHud.tsx` - the on-map overlay (instructions + live acres +
  Done / Start-over buttons).

## Approach (concrete)
1. **Live acreage + corner count while drawing.** Subscribe to MapboxDraw events
   (`draw.render` / `draw.modechange`) or poll `draw.getAll()` during `draw_polygon` mode; compute
   live acres with `@turf/area` (sq meters / 4046.8564224, the same divisor used in
   `fieldImportParser.ts`). Show a small chip in a map corner: `Drawing... ~= X.X ac, N corners`.
   Reuse the existing acres-from-area helper if one exists in `fieldImportParser.ts`
   (`acreageOfGeometry`-style) rather than re-deriving the divisor.
2. **On-screen instructions.** When in draw mode, show a one-line banner:
   `Tap each corner of the field, then double-tap the last point to finish.`
3. **Explicit "Done" + "Start over" buttons.** "Done" finishes the in-progress polygon
   programmatically (e.g. `draw.changeMode('simple_select')` so finishing does not depend on the
   hidden double-click). "Start over" deletes the current shape (`draw.trash()` / `deleteAll`).
   These must drive the same `onDrawCreate` / `onDrawUpdate` callbacks FieldSetup already listens to,
   so the saved geometry + `boundaryAcres` preview stay correct.
4. **Map loading / error state (CRXMap).** Show a spinner overlay until the map's first
   `load` / `idle` event; on a tile/`error` event show `Map could not load - tap to retry`.
5. **Undo last point = STRETCH only.** `mapbox-gl-draw` has no clean built-in "remove last vertex"
   in `draw_polygon` mode; a true undo needs a custom draw mode. Do NOT burn the cycle on it - ship
   instructions + live acres + Done + Start-over + loading state as the core; note undo as a follow-up
   in STATE.md if it proves hard.

## Acceptance ("done" given the auth wall)
- A component/unit test (e.g. `DrawingHud.test.tsx` or extend an existing map test) proves: the live
  acreage chip renders and reflects a sample in-progress polygon's area; the "Done" button calls the
  finish handler; instructions render only in draw mode.
- `npm run lint` + `typecheck` + `build` clean; targeted tests green.
- The saved boundary + `FieldSetup` acreage preview are unchanged for an already-drawn field
  (no regression to the existing flow).
- Mason's in-app click-test (open Fields -> a field -> Edit boundary -> draw) is the final proof.

## Gates
Standard cycle (LOOP_PROMPT step 4-7). Frontend-only -> ship live when green.

## Owner gate
None expected. If the loading-state work touches map auth/token handling or anything non-cosmetic,
re-confirm it's still frontend-only before shipping.
