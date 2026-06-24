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
| #  | Feature                         | Risk                         | Status | Ship (commit / deploy / rollback) |
|----|---------------------------------|------------------------------|--------|-----------------------------------|
| F1 | Guided map drawing              | frontend-only                | TODO   |                                   |
| F3 | Per-field customer on import    | frontend-only                | TODO   |                                   |
| F2 | Applicator mix-up flag          | frontend-only + investigate  | TODO   |                                   |

## Per-feature plan (fill in during the scope step)
- **F1 plan:** _(write your 1-paragraph plain-English plan here before implementing)_
- **F3 plan:** _(…)_
- **F2 investigation result + build-or-park decision:** _(…)_

## Owner gates / parked items
- _(none yet - record here anything that needs Mason: a required migration, the F2 auto-nudge if no
  clean signal, etc., each with a plain-English explanation)_

## Ship log
- _(per feature: commit sha, Vercel deploy id, rollback deploy id, what shipped)_

## Final summary
- _(fill at end: what shipped, what parked, what Mason still needs to do - in-app click-tests, any
  parked owner decisions)_
