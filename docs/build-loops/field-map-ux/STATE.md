# Field-Map UX Build Loop - STATE (live tracker)

Created 2026-06-24 by the planning session. Run by a fresh session. **Update this file every step.**

## Decisions (locked - see LOOP_PROMPT.md)
- **GO-LIVE:** ship each feature live as it passes (auto-push to main + deploy per feature).
- **F2 mix-up flag:** investigate-then-build-or-park.

## Base
- Branch off current origin/main as `feat/field-map-ux`. Latest main at creation: `d78c8a0`
  (Bundle A+B field-acre UI improvements).
- Builds on: `src/lib/fieldGeometry.ts` (billableAcres, acreDivergence, acreDivergencePct), the
  Track A two-acre model, the Track B billing engine, and Bundle A+B (price-box dollars,
  billable-acres on lists, map labels with acres, LocateMe/AddressSearch feedback).

## Feature status
| #  | Feature                         | Risk                         | Status        | Ship (commit / deploy / rollback) |
|----|---------------------------------|------------------------------|---------------|-----------------------------------|
| F1 | Guided map drawing              | frontend-only                | ✅ SHIPPED LIVE | af43b4ad / dpl_p4bBKSNZ… / dpl_4XMB3Uti… |
| F3 | Per-field customer on import    | frontend-only                | IN PROGRESS   |                                   |
| F2 | Applicator mix-up flag          | frontend-only + investigate  | TODO          |                                   |

## Session / worktree
- Running in worktree `C:\CRX_Manager\.claude\worktrees\modest-chatelet-7b2c74` on branch **`feat/field-map-ux`**
  (created off origin/main `5c09c297`; `npm ci` done). The build-loop harness commit IS on origin/main.
  Other worktrees (as-applied-invoices / ui-overhaul-v2 / field-acre-ui-improvements) are unrelated; I'm
  the only session on this loop.

## Per-feature plan (fill in during the scope step)
- **F1 plan (CONFIRMED — SOW assumptions hold):** Today the field-boundary map (right panel of
  `FieldSetup.tsx`) only exposes the bare mapbox-gl-draw polygon icon (top-left): you tap corners and must
  *double-click* to finish (nothing says so), the acreage that becomes the bill only appears after saving,
  and there's no map loading state. I'll add an on-map **DrawingHud** (a new presentational component,
  bottom-center so it clears the existing top-left/bottom-left controls) that: (1) shows a big **"Draw field
  boundary"** button when nothing is drawn (and **"Redraw boundary"** when a boundary already exists) so
  starting is obvious; (2) while drawing, shows a one-line instruction *("Tap each corner of the field, then
  double-tap the last point to finish")*, a **live acreage + corner-count chip** (so staff can sanity-check
  "~80 ac" as the shape forms), and explicit **Done** / **Start over** buttons. Done finishes the polygon
  programmatically (`draw.changeMode('simple_select')`, which fires the SAME `draw.create` the double-click
  does, so the saved geometry + `boundaryAcres` preview are unchanged); Start over clears and re-enters draw
  mode. The HUD is wired in `DrawControl.tsx` (which owns the mapbox-gl-draw instance) and driven by a new
  PURE, unit-tested helper `drawingRingMetrics(ring)` in `fieldGeometry.ts` (geodesic acres + corner count,
  reusing the same `@turf/area` / 4046.8564224 divisor). Also add a **map loading spinner + "couldn't load —
  tap to retry"** error state to `CRXMap.tsx` (only before first `load`; transient tile errors after load are
  ignored). Frontend-only — no DB/RPC/migration. Files: NEW `DrawingHud.tsx`, edit `DrawControl.tsx`,
  `CRXMap.tsx`, `fieldGeometry.ts`; tests: NEW `DrawingHud.test.tsx`, extend `fieldGeometry.test.ts`.
- **F3 plan:** _(…)_
- **F2 investigation result + build-or-park decision:** _(…)_

## Owner gates / parked items
- **(F1 review — confirmed + fixed, not parked)** The review caught a real footgun: because the field
  map always runs in "multi-part capable" mode, an early version of the new headline button would have
  wiped ALL parts of a multi-part field in one click. Fixed: the button is now part-count aware and
  never destructive to multiple parts — 0 parts = "Draw field boundary", exactly 1 = "Redraw boundary"
  (replaces that single boundary), 2+ (an imported multi-part field) = "Draw another part" (adds, never
  wipes). Removing one part of a multi-part field is still done with the trash icon / the per-part list.
- **(F1 pre-existing follow-up — NOT a blocker, no owner action needed now)** Hand-drawing a *brand-new*
  field is single-boundary by design (multi-part fields come from the shapefile importer, which preserves
  all parts). There's a long-standing gap where, on a fresh field, drawing a 2nd disjoint polygon with the
  raw map tool overwrites the 1st in the form's state (only the last saves). F1 does NOT make this worse —
  the new button never leads a user there (it offers "Redraw", not "add", at one part). Noting it as a
  possible future polish (promote the first hand-drawn boundary into the multi-part list) if hand-drawing
  multi-part fields ever becomes a real need. Today: drive multi-part via import.

## Ship log
- **F1 — Guided map drawing. ✅ SHIPPED LIVE 2026-06-24.** Frontend-only. Lint + typecheck + build + full
  suite (2192 pass / 113 skip) all green; 2 adversarial review rounds (fan-out: 5 raised / 1 confirmed MED
  + 3 LOW, all fixed; focused re-verify: all 4 fixes CONFIRMED-CORRECT, no new issues).
  - commit: **af43b4ad** on `main` (branch `feat/field-map-ux` also pushed).
  - Vercel prod deploy: **dpl_p4bBKSNZbH2mPKjh3jE4iTZMDD5C** — READY, aliased to **croprxsolutions.app**.
  - One-click rollback target: **dpl_4XMB3UtiuhnD1CuSHYF6LYE986sr** (prev prod, commit 5c09c297).
  - Files: NEW `src/components/map/DrawingHud.tsx` (+ test), edited `DrawControl.tsx` / `CRXMap.tsx`,
    NEW pure helper `fieldGeometry.drawingRingMetrics` (+ tests).
  - Mason still does the in-app click-test (auth wall → no logged-in browser smoke possible here).

## Final summary
- _(fill at end: what shipped, what parked, what Mason still needs to do - in-app click-tests, any
  parked owner decisions)_
