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
| F3 | Per-field customer on import    | frontend-only                | ✅ SHIPPED LIVE | 7781b9e7 / dpl_BJnLLXsu… / dpl_AkUf5oqh… |
| F2 | Applicator mix-up flag (Branch B display) | frontend-only + investigate | GREEN — SHIPPING (auto-nudge PARKED) |    |

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
- **F3 plan (CONFIRMED — SOW assumptions hold, verified read-only):** The field importer
  (`BulkFieldImport.tsx`) is a 7-step wizard; step 4 ("Customer") today forces ALL imported fields onto
  ONE chosen customer (`selectedCustomerId`), and the per-field save loop already calls `save_field` with
  a per-field `pf.customer_id` (the customer rides inside the `p_field_payload` jsonb — verified the live
  RPC signature: `save_field(p_field_id, p_field_payload jsonb, p_billing_defaults jsonb, p_performed_by,
  p_idempotency_key)`, no separate customer arg). So F3 is a pure UI step that lets each parsed field's
  `customer_id` differ; the save path is untouched. Plan: a NEW presentational `FieldCustomerAssignment.tsx`
  (testable in isolation, F1's DrawingHud pattern) rendered in step 4 — an **"Apply to all"** customer
  picker (keeps today's one-click single-customer fast path) plus a per-field table (field name + acreage +
  a per-row customer picker that defaults to the applied customer; only the open row renders its option list
  so a 500-field county/co-op file stays snappy). `BulkFieldImport` holds a `fieldCustomerAssignments`
  (index→customer_id) map; `buildParsedFields()` resolves `customer_id = assignment[i] ?? selectedCustomerId`;
  `canAdvance(4)` requires every field to resolve to a customer; a field left without one stays invalid via
  the existing "No customer assigned" path (shown + skipped). Optional preview-map color-by-customer SKIPPED
  (not cheap — out of envelope). Frontend-only, no DB/RPC/migration. Files: NEW `FieldCustomerAssignment.tsx`
  (+ test), edit `BulkFieldImport.tsx`; small pure resolution helper + its test.
- **F2 investigation result + build-or-park decision → BRANCH B (display only; auto-nudge PARKED).**
  Verified read-only against the live schema + `FieldApplicationInvoice.tsx`: at billing time there is **no
  independent "acres actually applied" signal** that can differ from the field's system acres. The field-
  application invoice is built from FIELD SELECTIONS on the billing page; each row's `applied_acres` is
  *defaulted to the field's billable/system acres* (`handleLocationsSelected`, line 343) and is the only
  place it is ever entered. The `field_app_locations` table also has a `planted_acres` column, but it is
  never captured in this flow (always null). `application_records.total_acres` / `jobs.total_acres` exist
  but feed the separate generic (job/blend) editor, which this page redirects away — they are not an applied-
  vs-system signal here. So "applied == system" is just the normal expected case, and an auto-nudge on every
  full-field job would be noise. → **Build the safe DISPLAY improvement** (an explicit "matches the acres on
  file (full field)" vs "edited" badge beside the applied-acres input, so the biller can SEE at a glance
  whether they accepted the auto-fill or changed it — the existing ≥10% divergence flag never fires on the
  auto-fill case). **PARK the auto-nudge** (below) for Mason.

## Owner gates / parked items
- **⛔ PARKED FOR MASON — F2 applicator mix-up AUTO-NUDGE (a decision, not code).** What I shipped for F2
  is the safe DISPLAY improvement (each billing row now says "Full field — matches acres on file" when it
  bills the whole field's acreage unedited, or "Edited (field is X ac)" when you changed it). What I did
  **not** build — because it needs your call — is an *automatic* "this might be wrong, confirm before posting"
  nudge on a full-field bill. The reason: to flag a full-field bill as *possibly* wrong, the system needs an
  independent signal of *what was actually sprayed*, and **today there isn't one** — the "applied acres" are
  typed at billing time and default to the whole field, so "applied = whole field" is just the normal case;
  auto-nudging every full-field job would cry wolf. Your options (pick one when you're ready — I'll build it):
  1. **Capture it at application time.** Add a quick "Did you spray the whole field? ☑ Yes / ◻ I sprayed
     less → ___ ac" when an application is recorded, so billing has a real number to compare. **This needs a
     new data field = a database migration → owner-gated, I did NOT build it.**
  2. **A per-job "partial application" toggle** the biller flips, which then turns the advisory into a
     stronger confirm. Lighter than #1; still a small data addition.
  3. **Leave it as the clearer display only** (what shipped). No automatic nudge; the biller eyeballs the
     "Full field" label and edits when they know only part was sprayed.
  My recommendation: **option 3 for now** (it shipped, zero risk), and revisit #1 if/when you start
  recording applications in the field — that's the only place a trustworthy "actually applied" number can
  come from. None of these is urgent; all of #1/#2 wait for your word (they touch the database).
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
- **F3 — Per-field customer on import. SHIPPING (frontend-only).** Step 4 of the field importer now
  assigns a customer PER FIELD (county/co-op files cover many growers) with an "Apply to all" fast path
  (one pick = single-customer one-click, unchanged). Save path untouched (save_field already takes the
  customer inside `p_field_payload`; no DB change). Review fan-out (correctness/regression/conventions +
  verify): **0 confirmed findings**; 3 LOWs addressed anyway — adopted a single-source design (apply-to-all
  sets only the fallback + clears overrides; the UI, the step gate, and the save all resolve via one
  `resolveFieldCustomerId`) and added aria-labels to the per-row pickers. NEW pure helpers
  `lib/fieldImportCustomers.ts` (+ tests) + `components/fields/FieldCustomerAssignment.tsx` (+ tests);
  edited `BulkFieldImport.tsx`.
  - commit: **7781b9e7** on `main`. Vercel prod deploy: **dpl_BJnLLXsufAX6V9kMp6YUw64r6A3F** — READY on
    croprxsolutions.app. Rollback target: **dpl_AkUf5oqhtrnSc7bNPDmMShpZLEmG** (prev prod c2cccbc6 = F1 state).
  - Mason does the in-app click-test with a real multi-grower `.zip` (auth wall → no logged-in smoke here).
- **F2 — Applicator mix-up flag → Branch B display (SHIPPING; auto-nudge PARKED).** Investigate-first
  concluded there is no independent "actually applied" signal (see plan above), so per Mason's pre-made
  decision I built ONLY the safe display: a per-row "Full field — matches acres on file" vs "Edited (field
  is X ac)" badge on the field-application billing page, making the common auto-fill case visible (the ≥10%
  divergence flag never fires on it). NEW pure helper `fieldGeometry.appliedMatchesSystem` (+ tests); badge
  in `FieldApplicationInvoice.tsx` (+ 2 page render tests proving both states). Focused adversarial review:
  **CONFIRMED-CLEAN** (mutually exclusive with the existing flag, null-safe, display-only, no billing-logic
  change). The auto-nudge is PARKED for Mason (see Owner gates above). _(commit / deploy / rollback filled
  after push.)_

## Final summary
- _(fill at end: what shipped, what parked, what Mason still needs to do - in-app click-tests, any
  parked owner decisions)_
