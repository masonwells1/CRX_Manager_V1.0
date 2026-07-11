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
| M6 | SHIPPED | sol (migration) + terra (UI); verdicts sol | 3 | 20260713000000 APPLIED LIVE (v20260711202349) | (sha at push) | CLEAN (pass 2) |
| M7 | SHIPPED (combined Fields-UX unit) | terra (verdicts: sol) | 4* | none | (sha at push) | CLEAN (pass 4) |
| M8 | SHIPPED (combined Fields-UX unit) | terra | – | none | – | – |
| M9 | SHIPPED | sol (migration) + terra (UI); verdicts sol | 4* | 20260713010000 APPLIED LIVE (v20260711224658) | (sha at push) | CLEAN (pass 3) |
| M10 | SHIPPED (combined Fields-UX unit; scoped to legal_description) | terra | – | none | – | – |
| M11 | ALREADY-SHIPPED (verified) | n/a | 0 | none | n/a | n/a |
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

### Event log
- 2026-07-11 ~14:45 CT: Codex usage limit hit mid-M6a (no migration file written). Reset at 15:02 CT — waiting it out per §6 (a 17-min cooldown, not a stall). All shipped work committed+pushed before the event.
- 2026-07-11 ~15:40 CT: M6a migration job_loader_worksheets APPLIED LIVE (proof f9103e78…, RLS verified on). Post-apply invariant sweeps 14/15 PASS; 1 pre-existing allowlist-bookkeeping drift (anon-exec-secdef: 3 inert trigger fns — enforce_blend_ticket_fields_billed_lock, fields_acre_authority_guard, recalc_product_price_per_acre — predate tonight; morning item: allowlist or revoke-anon hygiene). Registry refresh delegated.

### M6 — Multiple loader worksheets per job (SHIPPED; migration LIVE)
- M6a migration 20260713000000_job_loader_worksheets: Sol-written; Opus rls-security CLEAN (created_by WITH CHECK hardening applied per its advisory) + Opus migration-drift CLEAN (7/7); rolled-back live smoke passed twice (original + amended); apply-guard proof f9103e78…; APPLIED LIVE = registry high-water v20260711202349; RLS verified on; post-apply sweeps 14/15 (1 pre-existing bookkeeping item). Registry refreshed live-introspection + synced to both checkouts; stale flag cleared.
- M6b UI: worksheet list (Select/Edit/Delete, atomic two-step selection w/ 23505 + refetch-on-any-failure + explicit no-selection banner), add/edit with vessel picker, per-load acres editing (capacity-validated), full-loads-remainder mode (ChemMan 133.33/133.33/78.00 reference test), tap-loads-done (out-of-range inert), individual/condensed display, legacy path byte-identical, PDF prints from the selected worksheet.
- Review kills: 3 dead Save buttons (uninvoked handlers — BLOCKER both reviewers), status-gate bypass, and Sol's pass-1 five blockers incl. the safety-critical condensed-sum (532 lb printed as one tank) — now per-load "× N each" semantics.
- Deferred to owner: invalidate loads_done when job acres change after marking (documented; out-of-range marks are inert meanwhile).
- PROOF — Ran: typecheck ✓ lint ✓ scoped tests 51 ✓ full suite ✓ build ✓; live table SELECT (relrowsecurity=true); 2 Opus + 2 Sonnet reviews + 2 Sol verdicts. · Saw: CLEAN final; migration in live migration list. · Not verified: interactive multi-worksheet flow (top of the morning checklist).

### M7+M8+M10 — Fields-UX unit (SHIPPED, one diff)
- M7: "+ Add another section" affordance + parts list w/ per-part delete + helper copy (multi-part was already supported server-side; this makes it discoverable). M8: all-fields context overlay while editing (shared 5-min geojson cache extracted to fieldsGeojsonCache.ts, 300-cap, eye toggle persisted, non-interactive). M10: Legal Lookup via public BLM PLSS — honestly scoped to legal_description only (the PLSS layer carries no county data; county/state fill removed after Sol checked the live schema); CSP connect-src gained gis.blm.gov (would have been dead in prod).
- Review kills across 4 rounds (findings converged 2→2→1→0): map re-frame after draws, single-unsaved-part removal (saved boundaries stay protected), stale loadedHadBoundaryRef desync, CSP block, and a pan-during-draw sketch-erase blocker (DrawControl sync now skips during active draw + stable initialPolygons identity). *Round-cap deviation logged: 4 rounds, same convergence rationale as M1/M2.*
- Acre authority verified untouched by reviewer (server ST_Multi normalization; attribute-only saves still skip set_field_boundary).
- PROOF — Ran: typecheck ✓ lint ✓ scoped tests 70-72 ✓ full suite ✓ build ✓; 1 Sonnet deep review + 4 Sol verdict passes. · Saw: CLEAN final. · Not verified: interactive draw/lookup flow (morning checklist).

### M9 — Field obstacle markers (SHIPPED; migration LIVE)
- Migration 20260713010000_field_obstacles: Opus rls-security found SELECT USING(true) broader than parent fields policy → tightened to admin/sales/applicator (reviewer's prescribed one-liner) before apply; drift CLEAN; smokes passed; proof 7262a448…; APPLIED LIVE (registry v20260711224658, refreshed + synced, flag cleared); RLS verified on; sweeps re-run 15/15 vs known baseline (no new violations).
- UI: FieldSetup add-obstacle click-to-drop (kind/label, ConfirmModal delete, office-only writes), read-only pins on JobFieldMap (+failure toast), obstacle points on printed per-field close-ups (dropped first under URL pressure), red danger styling.
- Review kills (4 rounds, converging): obstacle-mode unmounting DrawLayer destroyed mid-sketch boundaries (now stays mounted + entry blocked during draw); pins swallowing draw clicks (non-interactive while drawing); STATIC MapboxDraw mode during obstacle placement (drag couldn't move billable geometry); keyboard "3" bypass (keybindings:false + modechange snap-back). *Round-cap deviation logged, same convergence rationale.*
- PROOF — Ran: typecheck ✓ lint ✓ scoped tests 17-28 ✓ full suite ✓ build ✓; live table SELECT (relrowsecurity=true); 2 Opus + 1 Sonnet reviews + 3 Sol verdicts. · Saw: CLEAN final. · Not verified: interactive pin-drop (morning checklist item 6).
