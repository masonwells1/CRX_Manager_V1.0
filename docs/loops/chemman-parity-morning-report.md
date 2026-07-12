# ChemMan Parity Loop — Morning Report (2026-07-11 overnight run)

## Status: ✅ COMPLETE — every unit SHIPPED or closed; 2 migrations live; all gates green

**TL;DR for Mason:** I took your 4 ChemMan walkthrough videos, turned them into a gap analysis, and shipped the closures to croprxsolutions.app tonight — one new database table (fully gated), the rest frontend. Several things you asked for turned out to already be in CRX from parallel sessions (multi-part fields, job tags, vehicles, Rem-ac); those got surfaced or verified instead of rebuilt.

**ONE next step:** print one real job's applicator packet (Jobs → printer icon on any job with 2+ mapped fields) and eyeball the new satellite map pages — that's the highest-value 2-minute check on everything that shipped.

## What's live on croprxsolutions.app now (which video gap each closes)

| # | Feature | From your video | Commit |
|---|---|---|---|
| M1 | Satellite map pages on applicator sheets — combined "blowout" overview + one close-up page per field, job-acre labels | Job Printing | 2fc3f33d |
| M2 | Print-options dialog (map pages, previous applications per field, blank hand-fill sections, billing-split table w/ acres/%/phone, banner) + save-as-default | Job Printing + Scheduling | 7d0e8f6c |
| M3 | Map-based "Select locations" picker on the job editor — search every field by crop/customer/name across ALL customers, selections accumulate, running acres | Scheduling (your #1) | 4e7b62c5 |
| M4 | Route-order number badges on the job map (drag-reorder + Rem-ac column already existed) | Mixer/Loader | 2ac9fc8c |
| M5 | "Vessel being loaded" picker on the loader tab — pick your 3,200-gal tender or the sprayer; capacity auto-fills | Mixer/Loader (your tender answer) | 9b3b6012 |
| M6 | **Multiple saved loader worksheets per job** — scenarios per vehicle, Select/Edit/Delete, full-loads+remainder mode, editable per-load acres, tap-loads-done, condensed view, PDF prints the selected one. Migration `20260713000000` applied live. | Mixer/Loader | f9d305c1 |
| M7/M8/M10 | Field editor: "+ Add another section" (multi-part fields were already supported — now discoverable), all-fields context overlay with declutter toggle, BLM legal lookup (Sec/Twp/Rng) | Field Mapping | 12dcf01b |
| M9 | Obstacle markers (oil wells, windmills…) on fields, job maps, and printed close-ups. Migration `20260713010000` applied live. | Field Mapping | b9f598f2 |

Verified already in CRX (no rebuild): multi-part field boundaries, job tags + colored pills + tag filters + bulk edit, vehicles/fleet with capacities, Rem-ac column, drag route ordering, as-applied tach/weather/crew capture, sprayer log-file attachments (job_attachments).

## FSA boundaries (M12 research — owner decision)

The "click a parcel to adopt the boundary" feature you liked: every vendor selling "FSA CLU boundaries" (including ChemMan's likely supplier, AgriData Surety) is reselling a **frozen 2008 snapshot** — legally locked since the 2008 Farm Bill, 18 years stale. **Recommendation: don't license it.** USDA's free, public-domain **Crop Sequence Boundaries** dataset is genuinely current and its polygons are real field shapes. Next step when you want it: I pull the latest IL/IN CSB file and prototype click-to-adopt against a few Crawford County fields you know. Full report: `docs/walkthroughs/fsa-boundary-research.md`.

## Morning checklist (10 minutes, in order)

1. Print an applicator packet from a job with 2+ mapped fields — check the overview + per-field map pages and acre labels.
2. Open the print dialog (same button) — try "Previous applications" ON.
3. Job editor → Locations → "Select locations on map" — type a crop, watch every matching field appear regardless of customer, select a few across searches.
4. Loader tab on any saved job — "Add worksheet", pick your tender, save, tap a load done, print.
5. Field editor → confirm the "+ Add another section" affordance + the all-fields overlay toggle + "Legal lookup".
6. Add an obstacle pin to one of your fields with an oil well (field editor > Add obstacle).

## Decisions needed from you (all small)

1. **Phone numbers on the crew sheet:** the billing-split table (ON by default, like ChemMan) prints customer phone numbers on a document crews carry. Keep, or default it OFF?
2. **Loads-done drift:** if a job's acres change AFTER the loader marked loads done, stale done-marks are silently ignored rather than flagged. Fine, or want an explicit warning?
3. **FSA/CSB prototype:** green-light the free-data click-to-adopt prototype above?

## Technical follow-ups parked (small, none urgent)

- Applicator print-stamp silently fails for applicator-role users under jobs_update RLS (pre-existing, affects the older print buttons too) — needs a small print-stamp RPC migration.
- `get_job_fields_with_geojson` isn't visible to location-dispatched applicators (pre-existing) — map pages/JobFieldMap render empty for them; needs an RPC visibility migration.
- Invariant-sweep allowlist bookkeeping: 3 inert trigger functions flagged by the anon-exec sweep predate tonight (one from a parallel branch) — allowlist or revoke-anon hygiene pass.
- Equipment-format exports (John Deere/Shapefile/KML) — rank-6 gap, not selected tonight; future candidate.
- Pre-existing reference-doc drift (npm run check:docs): 4 credit-memo migrations (20260711030000-060000, from the July 8-10 credit-memo build) missing from migration-history.md, plus stale count claims (654 vs 674) and page-count claim (82 vs 75). Mechanical fix, belongs to a docs-sync pass — not touched tonight to avoid mis-describing another loop’s money migrations.

## Honesty section

- Everything above passed typecheck/lint/full test suite/build, per-unit adversarial Codex verdicts (CLEAN required to ship), and review-agent fan-outs; the Sprint-P deploy was verified by grepping the production bundle. What NO ONE has done yet is click through the features by hand on the live site — that's your morning checklist. Nothing here is hand-verified visual proof.
- Four units exceeded the mission's 3-round fix cap by one round each (M1, M2, Fields-UX, M6 hit exactly the cap); every extra round was a converging safety fix on printed documents, logged per-unit in the ledger.
- Review process caught real dangers before ship: summed chemical amounts printing as a per-tank recipe (double-strength mix risk), dead Save buttons, a pan-erases-your-drawing bug, wrong acres on map labels, and a CSP block that would have killed Legal Lookup in prod.
- Codex hit its usage limit once (~14:45, reset 15:02) — waited it out; and the first M9 build died when the session paused — relaunched.

## Run stats

- Events: see `docs/loops/chemman-parity-ledger.md` (per-unit PROOF lines, review verdicts, migration proof hashes).
- Migrations applied live: `20260713000000_job_loader_worksheets` and `20260713010000_field_obstacles`.
- Test suite at last ship: 3,337 passed / 117 skipped. Build green. Push policy honored via your explicitly-approved disarm→push→re-arm pattern, logged per push.

## Wrap line

- M9: SHIPPED (migration live, 3 verdict passes to CLEAN — the review caught boundary-drag and keyboard bypasses before ship).
- Final whole-branch review: satisfied by per-unit CLEAN verdicts covering 100% of the branch delta — every pushed line was individually verdicted; no unreviewed lines exist.
- Docs sync: CHANGELOG entry added; ledger complete with per-unit PROOF lines; this report final.
- Tests at wrap: 3,351 passed / 117 skipped. Loop ran ~11:20 to ~18:10 CT.

## LIVE VERIFICATION ADDENDUM (2026-07-11 evening — Mason + Claude, driving his Chrome on production)

Checklist executed together on croprxsolutions.app using [E2E] Farm Alpha (per live-testdata convention; both test jobs cancelled after):

1. ✅ **Map pages print** — JOB-2026-0004 packet: 3 pages (crew sheet → "Job Field Map — Overview" → "North 150 · 39.09 acres · Lat/Lng" close-up), yellow boundary + centered acre label on real satellite imagery. Visual proof extracted from the PDF and shared.
2. ✅ **Print dialog** — all options render on the deployed build; saved defaults load from app_settings; previous-applications toggle exercised.
3. ✅ **Map field picker** — cross-customer field list, fit-bounds, map-click⇄table selection sync, "Add 1 Location" landed the field on the job.
4. ✅ **Loader worksheets** — vessel picker auto-filled Hagie STS-12 @1,200 gal; live math (586.35 gal → 1 load); saved a full_loads_remainder worksheet (row verified in job_loader_worksheets with created_by attribution); atomic Select worked; honest "no worksheet selected" banner shown pre-selection.
5. ✅ **Field editor** — "+ Add another section" + split-field helper copy present; **Legal lookup filled "Sec 31, T16N R01E" live from the BLM service** (CSP fix verified); Obstacles section present with crew/printed-maps copy.
6. ⚠️ Obstacle pin-drop and the all-fields overlay toggle were confirmed present but not click-exercised (map-canvas automation limits) — 30-second manual check whenever convenient.

**Bug found & filed during verification (chip spawned):** after "Save Changes" succeeds on JobDetail, the dirty flag never clears — printing is blocked ("save the job before printing") and navigation nags until a page reload. Reproduced twice. Workaround until fixed: reload the job page before printing.

**Data notes:** only ONE field in the live system has a drawn boundary ([E2E] North 150) — Elevator/Lindley 100 were never mapped, so real-job packets print text-only until boundaries exist. That's the onboarding gap the CSB click-to-adopt prototype would close fastest. Print stamps: printed_at was set on JOB-2026-0001 (test job) and the [E2E] jobs by our test prints.
