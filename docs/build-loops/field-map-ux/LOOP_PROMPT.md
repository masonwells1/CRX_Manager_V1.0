# Field-Map UX Build Loop - Entry Prompt

You are running an autonomous build loop to ship three field-mapping UX features for
CRX Manager. Read this whole file, then read `STATE.md` (the live tracker) and the three
`SOW-*.md` files in this folder, then begin.

To launch: a fresh session, opened in this repo, says "run the field-map UX build loop"
(or pastes this file). The loop works task-by-task until all three features are SHIPPED or
PARKED.

## What you are building (3 features, in this order)
1. **F1 - Guided map drawing** (frontend-only) -> `SOW-F1-guided-map-drawing.md`
2. **F3 - Per-field customer assignment on shapefile import** (frontend-only) -> `SOW-F3-per-field-import-customer.md`
3. **F2 - Stronger applicator mix-up flag** (investigate first; may PARK) -> `SOW-F2-applicator-mixup-flag.md`

F2 is last because it may need an owner decision.

## Owner decisions already made (do NOT re-ask Mason)
- **GO-LIVE: ship each feature live as it passes its gate** - auto-push to main + deploy per
  feature (Mason authorized auto-push 2026-06-16; one-click Vercel rollback). Do NOT batch-hold.
- **F2 mix-up flag: investigate the data first.** If a clean "what was actually applied" signal
  exists, build the flag. If not, build only the safe display improvement and PARK the auto-nudge
  with a plain-English writeup for Mason.

## Hard gates - NEVER auto-cross; STOP and hand off to Mason
- A live **migration / DB schema change**, an **edge-function deploy**, or **deleting data**.
  None of these three features should need a migration (verified at scoping: F1 reuses the existing
  `@turf/area` calc; F3's importer already saves field-by-field via `save_field` which takes a
  per-field `customer_id`). If one turns out to need a DB change, PARK that feature: write the
  migration UNAPPLIED, explain it in plain English in STATE.md, stop that feature, keep going on
  the others.
- F2's auto-nudge if there is no clean partial-spray signal (per the decision above).

## The per-feature cycle (repeat for each feature)
1. **Verify ship-state first** (fresh/resumed session): `git fetch`, confirm local HEAD vs
   origin/main, check live state if relevant. Only ONE session runs this loop at a time - if another
   session is active in this checkout/worktree, stop.
2. **Scope**: read the REAL current code for this feature (the SOW lists the files). Confirm the
   SOW's assumptions still hold. Write a 1-paragraph plain-English plan into STATE.md.
3. **Implement**: surgical, frontend-only, match existing style. Add/extend component tests for new UI.
4. **Prove it RUNS**: `npm run lint` (0 errors) + `npm run typecheck` + `npm run build` (clean) +
   targeted `npx vitest run <changed files>` (render tests). NOTE: the app is behind a login wall and
   prod has no field data, so a logged-in browser smoke is impossible - the component render-tests ARE
   the "ran" proof here (same as the Bundle A+B ship). Mason does the in-app click-test after.
5. **Review fan-out**: run a scoped review workflow (compliance + correctness + regression lenses)
   over the diff. Fix real findings. Hard cap 3 rounds.
6. **Full gate**: `git commit` runs the pre-commit hook = lint + build + the full ~2,100-test suite.
   It must pass.
7. **Ship**: push to main (auto-push: frontend-only + green). Confirm the Vercel deploy reaches READY
   on croprxsolutions.app; record the deploy id + rollback target in STATE.md.
8. **Record**: update STATE.md (feature -> SHIPPED) + the memory file
   `project_field-acre-ui-improvements-2026-06-24.md` (or a new one), then move to the next feature.

## Known gotchas (these cost real time - do not rediscover them)
- Fresh worktree needs `npm ci` once, or the pre-commit **verify-deps** check false-FAILs
  ("vitest (not installed)").
- `assertRpcCoverage.test.ts` needs `const { data, error } = await supabase.rpc('x')` in the SAME
  file as its `assertRpcResult` - do NOT bury an rpc call inside `Promise.all([...])` (it becomes an
  "orphan-assert" regression). Keep rpc calls sequential.
- If you add a new export to a module a test file mocks via `vi.mock('../lib/db', ...)`, add it to
  the mock too, or the error path throws `No "X" export is defined on the mock`.
- ESLint `no-unused-vars` fires on intermediate edit states (import added before its usage) - it
  clears when the usage lands; confirm with a final `npm run lint`.
- New money storage is bigint cents; legacy PostgreSQL numeric-dollar storage is approved only after
  exact numeric math, clean finite whole-cent values, and an active finite whole-cent CHECK are verified;
  dirty or unconstrained columns remain findings. Existing approved columns retain
  exact `numeric` arithmetic. The shared helpers in `src/lib/parseCents` REFUSE inputs with more
  than two fractional digits by returning `null` (since 2026-09-03); check for `null` and show
  `MONEY_PRECISION_MESSAGE`, never coerce `null` to `0`. Any other money parsing path must reject
  excess precision or apply one approved exact decimal rounding rule first. Never use
  binary floating-point rounding for money.
- In NEW code avoid raw em-dashes (the file-write pipeline can mangle them) - use ASCII "-" or the
  `—` escape / `&mdash;` in JSX text.
- `npm run typecheck` (tsconfig.app.json) is the only real typecheck.

## Setup (first cycle only)
- Work in a dedicated worktree/branch off current origin/main: branch `feat/field-map-ux`.
- `npm ci` in the worktree.
- Read the just-shipped Bundle A+B for patterns: `billableAcres` / `acreDivergence` /
  `acreDivergencePct` in `src/lib/fieldGeometry.ts`, the divergence alert on
  `src/pages/FieldApplicationInvoice.tsx`, and the memory
  `project_field-acre-ui-improvements-2026-06-24` (+ `project_field-acre-billing-trackA/trackB`).

## Begin
Start with F1. Update STATE.md as you go. When all three are SHIPPED or PARKED, write a final
summary in STATE.md and stop.
