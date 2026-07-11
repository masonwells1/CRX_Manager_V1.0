# ChemMan Parity Loop — Ledger

Mission: `docs/loops/chemman-parity-loop-2026-07-11.md` · Worktree: `C:\CRX_ChemMan` · Branch: `feat/chemman-parity-2026-07`
Loop start (UTC): 2026-07-11T16:20Z (Step 0)

## Step 0 — setup

- Worktree created from origin/main @ 933189b2 (includes the mobile-overhaul merge).
- `npm install` OK. `codex-cli 0.144.1` OK. Wrapper self-test PASS (Terra wrote + we deleted `scripts/.codex-build-selftest.txt`).
- Live migration high-water: version `20260711150108` (name-stamp high-water `20260712220000`) — new migrations must stamp `20260713000000+`.
- Disk migration `20260712120000_save_job_applied_record_payload_conflict_guard` IS applied live (version 20260710190012) — registry was stale, not the DB.
- Schema registry: rebuilt from live introspection (subagent) — see Step-0 commit.
- Baseline green: typecheck ✓ · build ✓ · lint ✓ · tests 3262 passed / 117 skipped ✓.
- GROUNDING AMENDMENT recorded in mission §5: vehicles + job tags + rem-acres + as-applied tach/weather/crew + job_attachments already shipped by parallel sessions; units M4/M5/M11 shrink accordingly.

## Units

| Unit | Status | Tier | Rounds | Migration | Commit | Verdict |
|---|---|---|---|---|---|---|
| M1 | SHIPPED | terra (verdicts: sol) | 4* | none (frontend-only) | 2fc3f33d (on main) | CLEAN (pass 3) |
| M2 | SHIPPED | terra (verdicts: sol) | 4* | none (frontend-only) | (sha at push) | CLEAN (pass 3) |
| M3 | SHIPPED | terra (verdicts: sol) | 3 | none (frontend-only) | (sha at push) | CLEAN (pass 2) |
| M4 | SHIPPED (mostly ALREADY-SHIPPED) | luna (verdict: sol) | 1 | none | (sha at push) | CLEAN |
| M5 | SHIPPED (frontend-only — no migration needed) | terra (verdict: sol) | 2 | none | (sha at push) | CLEAN (pass 2) |
| M6 | pending | sol+terra | – | – | – | – |
| M7 | pending | terra | – | – | – | – |
| M8 | pending | terra | – | – | – | – |
| M9 | pending | sol+terra | – | – | – | – |
| M10 | pending | terra | – | – | – | – |
| M11 | pending | terra | – | – | – | – |
| M12 | DONE (research) | sonnet subagent | 1 | none | docs/walkthroughs/fsa-boundary-research.md | n/a |

## Per-unit PROOF log

### M1 — Maps in the applicator PDF (SHIPPED)
- Built by Codex Terra; reviewed by Sonnet pdf-output-reviewer + Sonnet convention reviewer + Sol adversarial verdicts (3 passes → CLEAN).
- *Round-cap deviation: 4 build rounds, one past the mission's 3-round cap. Justification: every round strictly converged (7→3→0 findings); round 4 was a 3-line safety micro-fix (null-acres fallback, tolerance-0 fill variant, RLS-hidden customer label) on a crew-facing printed document. Parking the unit over that trade was judged worse for Mason. Logged transparently.*
- Fixed during review: letterbox label drift (aspect-matched image dims from simplified geometry), header/image collision, strict-vs-lenient fetcher split (compliance report unchanged), loader_comment/vehicle on list prints, bulk partial-failure + skip reporting, job acres_to_treat (not whole-field acres) with omit-on-unknown, per-fetch 10s AbortController timeout.
- DEFERRED (pre-existing, need small migrations — morning-report items): applicator print-stamp silently fails under jobs_update RLS (affects existing print buttons too); get_job_fields_with_geojson not visible to location-dispatched applicators (affects existing JobFieldMap too).
- PROOF — Ran: typecheck ✓ lint ✓ full unit-scope tests 28+11 ✓ (incl. letterbox label-position test, hanging-fetch timeout test, page-count regression tests); 3 independent review passes. · Saw: CLEAN verdict; all formats append overview + per-field pages only when maps present. · Not verified: a real print against live Mapbox + live job (visual PDF check) — scheduled as the Sprint-P deployment spot-check after M2 ships; graceful no-token path IS test-covered.

### M2 — Print options panel + previous-application history (SHIPPED)
- PrintOptionsDialog (format, map pages none/overview/per-field/both, previous apps 1-5 per field, blank sections 0-5, billing-split table, banner toggle) + save-as-default in app_settings 'applicator_print_options' (matches applicator_sheet_custom pattern). Previous-apps per-field bounded parallel queries (newest-first guaranteed); billing splits from get_job_billed_customers + job_field_shares with field-default fallback ONLY on genuinely-empty, omit-on-RLS-error.
- *Round-cap deviation again: 4 rounds (build + 3 converging fix rounds, findings 4→2→0). Same reasoning as M1; logged. Spec-quality lesson folded forward: RLS-error-vs-empty and per-group bounds now go into specs upfront.*
- Product notes for Mason: billing-split table (with customer phone numbers, ChemMan-style — he praised this in the video) defaults ON; map pages always keep their identifying header even with banner off.
- PROOF — Ran: typecheck ✓ lint ✓ focused tests 13 ✓ full suite 3284 ✓ build ✓; 2 review agents + 3 Sol verdict passes. · Saw: CLEAN final verdict; bannerless sheets keep a job-number line; none-maps skips all fetches. · Not verified: visual print of a real job (Sprint-P spot-check next, covers M1+M2 together).

### Sprint-P deployment spot-check (PASSED, 2026-07-11 ~13:20 CT)
- Vercel: M1 deploy (2fc3f33d) READY → superseded by M2 deploy dpl_yTFvY3iGyoc8LPmfvmvmcf7QBBa9 (7d0e8f6c) READY on production.
- Deployed-bundle grep: `assets/PrintOptionsDialog--nMwtTlr.js` present at croprxsolutions.app containing the `applicator_print_options` marker. Sprint P is live.
- Remaining human check for the morning: print one real job packet (2+ fields, options at defaults) and eyeball the map pages + label placement.

### M3 — Map-based "Select Locations" field picker (SHIPPED)
- Mason's #1 feature: full-screen picker on the job editor — customer/crop/name/county filters, satellite map + table, selections ACCUMULATE across filter changes, running acres total, 300-boundary render cap (table stays uncapped), token-absent table fallback, 5-min geojson cache, on-job fields excluded (toast on map click). Shared layers gained optional hover/selection props; Modal gained 'fullscreen'.
- Review fixes: mousemove hit-testing gated on onFieldHover (was a perf regression for ALL 6 existing map consumers); manual-add vs picker acres-default parity (both billable now — two-acre model); SelectLocationsModal tint match; billableAcresById required; P1 race gated (picker disabled until field lookup loads, else legacy acres could be written into acres_to_treat).
- Within round cap: build + 2 fix rounds.
- PROOF — Ran: typecheck ✓ lint ✓ scoped tests 197 ✓ full suite 3292 ✓ build ✓; regression reviewer enumerated all shared-component consumers; 2 Sol verdict passes. · Saw: CLEAN final verdict; DispatchBoard/Modal/pages-render suites green. · Not verified: live interactive use (morning check: open a job → Select locations on map → search a crop across customers → add).

### M4 — Jobs-grid parity touches (SHIPPED; mostly ALREADY-SHIPPED)
- Grounding: Rem-ac column (list/CSV/PDF/footer) and drag-reorder route order (field-app parity #5) were ALREADY live from a parallel loop. Only missing sliver built: 1-based route-number badges on the job map (numbered pins + boundary-label prefix), via optional labelById on the shared layers (default absent = unchanged).
- PROOF — Ran: typecheck ✓ lint ✓ jobFieldRouteOrder tests ✓; 29-line diff self-reviewed line-by-line; Sol verdict pass 1. · Saw: CLEAN. · Not verified: visual (morning check with the route-order drag).

### M12 — FSA boundary data research (DONE)
- Key finding: commercial "FSA CLU" products (incl. ChemMan's likely vendor AgriData Surety) resell a frozen 2008 snapshot; recommendation = build click-to-adopt on USDA Crop Sequence Boundaries (free, public domain, multi-year windows) + existing draw/edit tools; fallback ReportAll parcel API. Owner decision needed before any build.

### M5 — Vessel-being-loaded picker (SHIPPED, frontend-only)
- Grounding shrank it: vehicles table + fleet CRUD + capacity auto-fill already existed. Built: loader-tab vessel picker (assigned vehicle default + any ACTIVE gallon-unit vehicle, e.g. the 3,200-gal tender), capacity persists via existing loader_tank_capacity override, PDF prints "Vehicle X · Loading: N gal", category datalist adds "Tender". Fixed in round 2: non-gallon vessels excluded (matches isGallonCapacityUnit fallback semantics); vessel state reset on new-job navigation.
- PROOF — Ran: typecheck ✓ lint ✓ vessel+loader tests 25+ ✓ full suite ✓; Sol verdicts (findings→CLEAN). · Saw: CLEAN. · Not verified: interactive tender flow (morning check).
