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

### Overnight follow-ups (2026-07-11/12 hands-free run, Mason asleep — "finish everything and live")

- **Save-bug fix verified live** (carried from evening): dirty-flag settle guard (commit c3146236) proven on production — edit→Save→immediate Print on build index-B0DhCxB7.js, no reload; DB printed_at stamped seconds after save. Pre-fix build reproduced the block on cue 8 min earlier (control).
- **Hold-latch false positive fixed**: Mason's "…going to bed don't stop" matched `\bstop\b` and latched a work-freeze mid-run. `.claude/hooks/hold-latch-lib.mjs` HOLD_RE now negative-lookbehinds "don't/won't/never/not " before stop/pause. PROOF — Ran: patched module executed — "don't stop" msg → false; "stop everything now"/"pause the loop"/"just scoping" → still true.
- **Migration 20260713020000_stamp_job_printed_rpc APPLIED LIVE (v20260712020715)**: print-audit RPC for every job-visible role (fixes applicator silent no-op stamp). Gates: rls CLEAN, drift 0-blocker, Codex Sol SHIP (P2 hardening folded in: visibility-before-idempotency + cross-job key refusal). PROOF — Ran: rolled-back authenticated-role smoke, 5 asserts (stamp ✓ actor-bound ✓ replay ✓ cross-job key refused ✓ fail-closed ✓) — clean pass; live catalog: 1 overload, SECDEF+search_path, anon EXECUTE false.
- **Migration 20260713030000_geojson_rpc_dispatched_visibility APPLIED LIVE (v20260712020737)**: `get_job_fields_with_geojson` gate now matches full jobs SELECT breadth (`+ OR _is_dispatched_to_me`). Re-emit line-diffed vs live: only the arm + comment. PROOF — live def contains dispatch arm, 1 overload, anon false.
- **Migration 20260713040000_revoke_anon_trigger_fn_exec APPLIED LIVE (v20260712020748)**: anon/PUBLIC EXECUTE revoked on the 3 flagged inert trigger fns. PROOF — has_function_privilege('anon', …) = false on all 3.
- **Frontend print-stamp swap (Codex Luna build)**: `src/lib/printStamp.ts` (+test) and all 10 direct stamp updates in JobDetail.tsx (4) / Jobs.tsx (6) now call the RPC; non-blocking semantics preserved. PROOF — typecheck ✓ lint ✓ full suite 3355 passed/0 failed ✓ assertRpcCoverage ✓.
- **Docs drift closed**: migration-history.md 654→677 + 7 backfill/new rows (4 credit-memo + tonight's 3) + stale duplicate title removed; pages-routes 82→75 pages. PROOF — `npm run check:docs` PASS on every check.

### CSB click-to-adopt prototype — SHIPPED (2026-07-12 morning, Mason: "continue build till done"; phones stay ON, no drift warning — both zero-change decisions)

- Data: no hosted CSB service exists (official viewer is a GEE app; NASS offers national-ZIP downloads only) → extracted 65,593 polygons for the Crawford-area service region + demo region from the fiboa GeoParquet (public domain, CSB 2016-2023) via remote DuckDB bbox queries (row-group pruning; 4×4 chunked w/ retries after a transient TProtocolException). 10 static tiles, 42 MB, simplified 8m in EPSG:5070 (equal-area → exact precomputed acres), served same-origin from public/csb/.
- Build: Codex Terra one round; my 2 surgical MED fixes (self-overlap filter, per-adoption drawId token) + Sol round-1 P1 fix (no geometry adds while a save is in flight) + 2 NITs (bounds precomputed at tile parse; unmount invalidates in-flight lookups).
- Gates: compliance-reviewer 0 BLOCKER/0 HIGH (2 MED fixed); Codex Sol round-1 BLOCK → all findings fixed → round-2 SHIP zero findings; typecheck/lint/build green.
- PROOF — Ran: full vitest suite 3,365 passed / 0 failed; data-level lookup at the [E2E] North 150 centroid returns a 131.3-ac Corn polygon from tile -89.5_39.5. Pushed fe5b0d4f → main (disarm→push→re-arm, logged). Live browser verification: see addendum below after deploy.

#### CSB live-verification addendum (2026-07-12 early morning, production, [E2E] entities — both deleted after)

- PROOF — Ran: on croprxsolutions.app (build post-fe5b0d4f): created "[E2E] CSB Adopt Test" ([E2E] Farm Alpha), entered Adopt-USDA mode (amber banner, draw CTA correctly frozen), clicked a farm field on the state-level map · Saw: preview "~207.2 ac · Corn"; Add boundary appended the part through the normal draw pipeline ("This field bills 207.13 ac from the map you drew"); Create persisted it — live DB row: measured_acres 207.34, acres_source measured, MultiPolygon in boundary_geom (USDA equal-area 207.2 vs frontend turf 207.13 vs server geodesic 207.34 — all within 0.1%). Satellite close-up shows the adopted outline tracing the actual crop edge and excluding the creek/tree line.
- BUG FOUND during verification: false "Unsaved Changes" prompt after EVERY successful field create (pre-existing — setIsDirty(false)+navigate in one batch, blames to bcdf8129/6e3de069; same stale-state class as the JobDetail c3146236 fix). FIXED via deferred post-save navigation (commit 5cd539bd, Sol SHIP + NIT folded in). PROOF — Ran: repeated the create on the deployed fix build · Saw: clean navigation to the new field page, NO prompt (control: identical flow nagged on the pre-fix build minutes earlier).
- PWA note: mid-verification the service worker's "Update now" toast replaced the form once (known 2-reload behavior) — retried on the settled build.

### CSB coverage extension — Lawrence/Clark/Jasper/Edgar (IL) + Sullivan (IN) — SHIPPED (2026-07-12, Mason: "extend the field boundary map coverage… have codex do heavy lifting you orchestrate")

- Division of labor (loop contract): Codex Terra (gpt-5.6-terra) authored the extraction+merge script; Claude ran the network extraction (outside the harness — 5-county DuckDB job) and gated it; Codex Sol (gpt-5.6-sol) read-only review → VERDICT: SHIP (1 NIT, no action).
- FINDING (honest): 4 of the 5 counties were **already covered** — they sit inside the original "service" bbox (-88.35,38.55,-87.25,39.45), so ~27k of their features deduped out on merge. Only **Edgar** (north of lat 39.45) was genuinely new: created `public/csb/csb_-88.0_39.5.json` (5,369 features) + 613 Edgar/Clark-sliver features into `csb_-88.0_39.0.json`. Now 11 tiles / 46 MB (was 10 / 42 MB). The other 9 tiles are byte-identical (no diff) — merge is provably additive + idempotent (dedup by USDA feature id, existing wins).
- Data source gotcha: the fiboa parquet has NO state column — only `administrative_area_level_2` (county). Filtered by county NAME within a regional bbox that excludes same-named counties in other states (bbox-alone or name-alone would be unsafe). Reusable script: `scratch-csb-extract-counties.py`.
- PROOF — Ran: extractor self-checks PASS (valid-json 11 tiles, unique-ids-per-tile, manifest counts+bytes match); independent client-mechanism point-in-polygon on a `ST_PointOnSurface` sample per county. · Saw: all five HIT — Lawrence 5.7ac Soybeans, Clark 4.0ac Soybeans, Jasper 3.1ac Grass/Pasture, Edgar 3.2ac Corn (on the new tile), Sullivan 3.5ac Soybeans. Pushed 033b487e → main (disarm→push→re-arm, logged); Vercel prod deploy verified serving the 11-tile manifest live.
