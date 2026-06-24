# Phase 0 — Grounding results (durable; read before building A1/A2/A4/A5)

> Written by the build loop, 2026-06-23. On-disk grounding of the PHASE2 design against the
> CURRENT code on `feat/field-acre-billing`. **No live DB was accessed** (Supabase MCP is
> unauthenticated + `read_only=true` this session). Verdict from the completeness critic: **GO**
> — on-disk grounding is solid enough to build A1 once a DB proof path exists.

## Environment (all green)
- Worktree `C:/CRX_FieldMapping`, branch `feat/field-acre-billing`, 1 commit ahead of `origin/main` (the harness), 0 behind, clean tree. `node_modules` present (npm ci marker present).
- Codex CLI 0.140.0, logged in (exit 0). `codex exec` = helper (`-s read-only`), `codex review` = reviewer.
- **`feat/as-applied-invoices` is ALREADY MERGED to main** (`20260622030000` on `origin/main`; no remote branch). So Track A has **no active parallel session** to collide with. (Track B stays BLOCKED until the OWNER explicitly unblocks it.)

## THE GATE (why the loop stopped here)
The loop's proof method (Supabase **dev branch** apply, or a rolled-back `BEGIN…ROLLBACK` smoke) needs a **write-capable** Postgres+PostGIS connection. This session's Supabase MCP is **unauthenticated AND `read_only=true` against prod** (OAuth scopes are all `:read`). So I can neither create a dev branch nor run a write-in-transaction smoke. Owner decision required (see STATE.md "Open issues"). Docker IS available locally (a free, lower-fidelity fallback exists).

## Confirmed facts (on-disk, with citations)

### `fields` table (A1 target) — all 4 new columns are clean net-new
- `fields.boundary geography(POLYGON,4326)` — `20260213000000_phase1_fields_foundation.sql:27`
- `fields.centroid geography(POINT,4326)` — `:26`
- `fields.total_acres numeric(10,2)` — `:19`
- `measured_acres` / `override_acres` / `boundary_geom` / `acres_source` / `billable_acres` — **ZERO matches** anywhere in migrations or src → genuinely net-new, no collision. Only post-foundation `fields` change is `parent_field_id` (`20260334900000:6`).
- `field_polygons` multi-part store exists — JSONB (`polygon_geojson jsonb`), NOT PostGIS geometry — `20260334900000_field_grouping_multi_polygon.sql:17-25`.

### Geometry save RPCs (the bolt-on point for `set_field_boundary`)
- `save_field(p_field_id uuid, p_field_payload jsonb, p_billing_defaults jsonb, p_performed_by uuid, p_idempotency_key text)` — `20260320100000_add_idempotency_to_remaining_rpcs.sql:11-125`. SECURITY DEFINER, `search_path='public, pg_temp'` (no extensions — no PostGIS), idempotent, `require_admin_or_sales_rep()`. **Owns `total_acres` (writes from payload :60/:77) + validates 100% split (:39-46). Writes NO geometry.**
- `save_field_geometry(p_field_id, p_centroid_geojson, p_boundary_geojson, p_idempotency_key)` — latest at `20260611002114_field_geo_search_path_fix.sql:117-146`. Writes ONLY `boundary`+`centroid`. **Persists IMPORTED boundaries today** (`BulkFieldImport.tsx:362`, always).
- `save_field_polygons(p_field_id, p_polygons, p_performed_by, p_idempotency_key)` — latest at `20260611002114:148-177`. DELETE+reinsert `field_polygons`, **OVERWRITES `total_acres` = sum of polygon acres (:167)**, sets boundary/centroid from first polygon. **Persists DRAWN boundaries today** (`FieldSetup.tsx:349`). `p_performed_by` is a declared-but-UNUSED dead param.
- `set_field_boundary` does NOT exist anywhere — net-new (A2).

### PostGIS idiom `set_field_boundary` must copy (and the trap)
- COPY the FIXED idiom: `ST_GeomFromGeoJSON(<text>)::geography` + `SET search_path TO 'public', 'extensions', 'pg_temp'` — `20260611002114:44,121,133`. `extensions` MUST be in search_path or `ST_*` → 42883.
- **DO NOT** copy the broken `ST_GeogFromGeoJSON` (does not exist in any schema) still present as executable code in 4 superseded migrations: `20260214000000:115/119`, `20260320100000:158/162`, `20260331000000:59/63`, `20260334900000:96-97`.
- **NO `ST_Area` anywhere** → server acreage is net-new; convert geography m² → acres by `/4046.8564224`.

### A4 — the #1 defect (confirmed verbatim)
- `FieldSetup.tsx:854-862` `onPolygonsChange` **unconditionally** `update('total_acres', …)` on every draw create/update/delete → a redraw silently changes a billed acre. The "Total Acres" input (`:545-550`) binds the SAME `field.total_acres`. Legacy single-poly path (`handleBoundaryChange:398-404`) is already guarded (`if (!field.total_acres)`); only the multi-poly path is unguarded.
- Draw stack: `CRXMap`(container) > `DrawLayer`(computes acres/centroid) > `DrawControl`(emits draw.create/update/delete). Fix is entirely in `FieldSetup.tsx` — DrawLayer need not change.

### A5 — import parser
- `fieldImportParser.ts` uses shpjs (piecemeal `parseShp/parseDbf/combine` — NOT the `.zip` `shp()` entry yet), proj4, @tmcw/togeojson (lazy), turf. Three entry paths: `parseShapefileBundle` (loose .shp+.dbf+.prj), `parseGeoJSONFile`, `parseKMLFile`. **No `.zip` branch.** Reproject via proj4 from `.prj` (loose path only).
- **`normalizeToPolygons` reduces every MultiPolygon to its LARGEST ring (`:287-302,328-344`)** — destructive; whole pipeline is typed Polygon-only (`:36`). A5 must widen to MultiPolygon, extend `validateFeatureGeometry` (`:383-412`, validates `coordinates[0]` only), and **update the existing test `fieldImportParser.test.ts:113`** which asserts the reduction.
- `BulkFieldImport.tsx`: 7-step wizard; `ACCEPTED_EXTENSIONS` (`:48`) + input `accept` (`:516`) omit `.zip`; per-field write loop `handleUpload:327-381` (save_field → save_field_geometry). No dedupe UI exists.

### Canonical building blocks for A2 (`set_field_boundary`)
- idempotency: `INSERT INTO idempotency_keys (idempotency_key, operation, result)`; scope replay read by `operation`. Example `20260622030000:88-89`. (Ignore pre-2026-03-15 `key/entity_type/entity_id` inserts — superseded bugs.)
- **`require_admin_or_sales_rep()` has NO on-disk CREATE** (lives only in live DB; used in ~30 PERFORM sites). For a source-verifiable gate, ALSO use the inline strict-actor block (verbatim `20260611002226:87-90`): `v_actor := auth.uid(); IF v_actor IS NULL → AUTH_REQUIRED; IF p_performed_by DISTINCT FROM v_actor → ACTOR_MISMATCH; IF NOT EXISTS(profiles WHERE id=v_actor AND is_active AND role IN ('admin','sales_rep')) → INSUFFICIENT_ROLE`.
- Audit = direct `INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)` — table is **`activity_feed`, NOT `activity_log`** (activity_log → 42P01 aborts txn). No jsonb column; fold detail into `description`. Example `20260611002226:162-167`.
- `field_app_locations.applied_acres numeric(12,2)` — `20260406100000:17`.

### Track B seams (confirmed intact post-merge; NOT Track A's job)
- `FieldApplicationInvoice.tsx`: applied_acres default now `:314` (design said :313); save fallback `:414`; acresMap builders `:326/:339`; preview rpc() now `:357` (in-payload fallback at `:363`); total useMemo `:105`.
- Authoritative `save_field_app_invoice` = `20260616191740` (COALESCE applied→total_acres→0 at `:532/:535`). `preview_field_app_invoice_split` + `derive_customer_shares_from_fields` latest defs in `20260429140635`. B2 must extend COALESCE → `applied→override→measured→total→0` in BOTH RPCs + 5 client threadings.

## Design refinements to FOLD INTO the build (from the Codex helper + critic)

### CRITICAL
1. **A1 backfill must preserve current bills.** Populating `measured_acres` makes `COALESCE(override, measured, total_acres)` stop preferring the old `total_acres` for already-boundaried fields → a re-measured polygon silently changes the billed number. **Fix:** in the backfill set `override_acres = total_acres` for legacy fields that have a `total_acres` (billable stays identical); `measured_acres` populated for display; clearing the override later *adopts* measured. (`acres_source='override'` for those rows.)
2. **Geometry normalization, not bare `ST_Multi(ST_MakeValid(...))`.** `ST_MakeValid` can emit lines/GeometryCollections. Pipeline: parse → `ST_Force2D` → set/verify SRID 4326 → `ST_MakeValid` → `ST_CollectionExtract(...,3)` → `ST_UnaryUnion` → `ST_Multi` → **reject empty/non-polygonal**.
3. **MultiPolygon can't cast into legacy `boundary geography(POLYGON,4326)`.** Store full shape only in `boundary_geom`; write the largest/first polygon to legacy `boundary`; centroid from the full geometry.
4. **RPC input contract:** `ST_GeomFromGeoJSON(text)` takes a Geometry, NOT a Feature/FeatureCollection. Require a Polygon/MultiPolygon geometry from TS (or extract/combine server-side). The design's "send the full FeatureCollection" won't parse as-is.
5. **`||` → `??` for acres** so a typed `0` survives to be rejected (not coerced to old acres). (Mostly B2, but the A4 override input must treat 0 as reject.)

### HIGH
- **`total_acres` ownership collision (top Track-A risk):** 3 writers touch it (`save_field` payload, `save_field_polygons` sum, `FieldSetup:857` clobber). Removing the `:857` clobber is NOT enough — `save_field_polygons` (`FieldSetup:349`) re-overwrites `total_acres` on the next save and defeats the override. **A4 must route the draw save through `set_field_boundary` (per §7) and decide deliberately who owns `total_acres` after the two-column model lands.**
- **`set_field_boundary` must be the SINGLE writer for BOTH drawn (was save_field_polygons) and imported (was save_field_geometry)** — else billable acres depend on entry method. A4 + A5 both repoint to it.
- A1 multi-part backfill from `field_polygons` must **overwrite** rows (don't gate on `boundary_geom IS NULL` after the single backfill); compute acres from the cleaned `boundary_geom`; group/extract/union per `field_id`; empty checks.
- Enforce "only writer of measured_acres": column-level REVOKE or trigger guard, and ensure `save_field` can't clobber measured/override via `total_acres`.
- Import dedupe idempotency: stable per-row keys (NOT a fresh `randomUUID()` per retry → duplicates).
- `set_field_boundary`: `SELECT … FOR UPDATE` the field row; re-check/claim idempotency inside the lock (concurrency).
- `find_overlapping_fields`: overlap = `intersection_area / LEAST(new, existing)`; GIST bbox → exact intersection → geography area.
- Source-file acre attributes are "reported acres" (display), NOT auto-billable override.

### MED
- `acres_source` drift if mutable — prefer derive-on-read or enforce transitions.
- 0.1–5000 ac band reasonable; improve the rejection message (split field / admin override path); reject out-of-range lon/lat cleanly (don't "fix" state-plane by just setting SRID 4326).
- Saved invoices keep their stored `applied_acres`; only NEW location selection uses current billable.

## Citation drifts in the design doc (use CURRENT lines)
- `applied_acres: f.total_acres` is `FieldApplicationInvoice.tsx:314` (design said :313).
- preview rpc() call is `:357` (design's ":363" is the in-payload fallback).
