# Phase 2: Field map → measured acres → override → bill (IMPORT-FIRST)

**CRX Manager · execution-ready build design · 2026-06-22**
**Parent:** [`2026-06-22-field-mapping-billing-BUILD-SPEC.md`](2026-06-22-field-mapping-billing-BUILD-SPEC.md) (Phase 2) · **Grounded in:** a read-only verification workflow that read the current draw/import/acreage code + live DB (citations inline below).

**Goal (the whole phase in one line):** a grower's field boundary (imported from a shapefile / Ops Center / FieldView export, or hand-drawn as a fallback) produces a **server-measured acreage** that becomes the **default billable acres** on a field-application invoice — with a **typed override** the user can set anytime that keeps the boundary and is the number that actually bills.

> **The big correction this design makes:** drawing (`CRXMap`/`DrawControl`/`DrawLayer`), import (`shpjs`/`proj4`/`@tmcw/togeojson` via `BulkFieldImport` + `fieldImportParser`), and PostGIS geometry storage (`fields.boundary geography(POLYGON,4326)`, populated) are **already live**. Phase 2 is therefore *small*: two acre columns, one server-side acreage RPC, a `.zip` import entry path, and a one-line billing tie-in. It is **not** greenfield.

> **Parallel-session caution (re-verify at build time):** a separate field-app session may be editing `FieldApplicationInvoice.tsx`, `save_field_app_invoice`, and `preview_field_app_invoice_split`. Before touching Section 6, re-grep the exact seams below (`applied_acres: f.total_acres`, the save fallback, the server `COALESCE`) — they are load-bearing and may have shifted. Treat all line numbers here as "as of 2026-06-22," not gospel.

---

## 1. Reuse vs build

**Reuse as-is (live & proven — do NOT rebuild):**

| Already built | Where | Use it for |
|---|---|---|
| PostGIS 3.3.7 + `fields.boundary geography(POLYGON,4326)` + `fields.centroid geography(POINT,4326)`, populated | `20260213000000`; written by `save_field_geometry`/`save_field_polygons` | The boundary store. **Don't re-enable PostGIS or re-add geography columns.** |
| Proven idiom `ST_GeomFromGeoJSON(text)::geography`, `search_path = public, extensions, pg_temp` | `20260611002114` (plpgsql_check=0) | The exact pattern the new acreage RPC copies. **Never `ST_GeogFromGeoJSON` — it doesn't exist.** |
| `save_field(uuid,jsonb,jsonb,uuid,text)` — idempotent, `require_admin_or_sales_rep()`, 100%-split validation, owns `total_acres` | `20260320100000` | Extend, don't replace. |
| `save_field_geometry` / `save_field_polygons` (idempotent, admin/sales-gated) | `20260214000000`, `20260334900000` | The bolt-on point for server `measured_acres`. |
| Client import parser: `shpjs` + `proj4` + `@tmcw/togeojson` + `turf` + `normalizeToPolygons` + `validateFeatureGeometry` | `src/lib/fieldImportParser.ts` | The `.zip` importer reuses all of this. |
| 7-step `BulkFieldImport` wizard + `ImportPreviewMap` + `AttributeMappingStep` | `src/components/fields/BulkFieldImport.tsx` | Reuse the whole UX shell. |
| Map stack `CRXMap`/`DrawControl`/`DrawLayer`/`FieldBoundaryLayer` | `src/components/map/*` | Field-map UI; turf stays **on-screen preview only**. |
| `field_billing_defaults` (split_pct + `price_override_cents` + pricing_note, sums-to-100) | `20260213000000` | The per-grower split layer acres feed into. |
| Read RPCs `get_fields_with_geojson`/`get_field_geojson`/`get_field_polygons` (emit `ST_AsGeoJSON`) | live | Surface measured acres + boundaries. |
| Applied-acres default + editable per-location input + re-derive-on-change | `FieldApplicationInvoice.tsx` | Reuse unchanged; **only the default source line changes** (§6). |
| `save_field_app_invoice` `COALESCE(applied_acres,total_acres,0)` → `derive_customer_shares_from_fields` | live | The per-acre billing engine — reuse; only acres precedence changes. |

**Net-new (the minimum to deliver import → measured → override → bill):**
1. Two `fields` columns: `measured_acres` + `override_acres` (+ `boundary_geom` + `acres_source`).
2. `fields.boundary_geom geometry(MultiPolygon,4326)` so a full multi-part field has one measurable geometry.
3. New SECURITY DEFINER RPC `set_field_boundary(...)` — the **only** writer of `measured_acres` (server-side `ST_Area` + validation).
4. A `.zip` entry path in the parser (small).
5. A canonical-field dedupe check on import.
6. One-line default-source change + 5 precedence threadings on the field-app invoice.
7. An acreage-change audit entry.
8. Backfill `measured_acres`/`boundary_geom` for existing fields that already have a `boundary`.

---

## 2. Data model (two-acre model — confirmed)

A measured number (machine, from the polygon) + an override (human, what bills). **No `fsa_acres`. All acreage writes go through RPCs — never a client `.update()`.**

```sql
ALTER TABLE public.fields
  ADD COLUMN IF NOT EXISTS measured_acres numeric(10,2),              -- server-computed; NEVER client-trusted
  ADD COLUMN IF NOT EXISTS override_acres numeric(10,2),              -- human-typed billable acres; NULL = use measured
  ADD COLUMN IF NOT EXISTS boundary_geom  geometry(MultiPolygon,4326),-- canonical full-field geometry for ST_Area
  ADD COLUMN IF NOT EXISTS acres_source   text
        CHECK (acres_source IN ('measured','override','legacy') OR acres_source IS NULL);
```

**Billable-acres rule (the only formula that bills):** `billable_acres = COALESCE(override_acres, measured_acres, total_acres)`
- Typed override wins; else server-measured; else legacy `total_acres` (existing fields keep working untouched).
- **`total_acres` is NOT dropped** — it stays as the back-compat fallback the legacy single-polygon RPCs already write. New code reads `billable_acres`; old rows flow through `total_acres` until backfilled. Avoids a risky one-migration rewrite of every field reader.
- `boundary_geom` (a true `geometry`, not `geography`) holds the union of all parts → `ST_Area(boundary_geom::geography)` measures multi-part fields correctly. The existing `boundary geography(POLYGON)` (single) and `field_polygons` (jsonb) stay fed for back-compat.

**RLS:** unchanged — new columns inherit the existing `fields` policies; the migration adds **no new table and no new policy**. **Index:** `CREATE INDEX IF NOT EXISTS idx_fields_boundary_geom ON public.fields USING GIST (boundary_geom);` (for dedupe overlap, §3). **Types:** add `measured_acres`/`override_acres`/`acres_source` to `Field` (~`src/types/index.ts:1315`), `ParsedImportField` (~:1416), and `FieldLocation`.

**Backfill (same migration):**
```sql
UPDATE public.fields f
SET boundary_geom  = ST_Multi(ST_MakeValid(f.boundary::geometry)),
    measured_acres = round((ST_Area(f.boundary::geography)/4046.8564224)::numeric, 2),
    acres_source   = CASE WHEN f.override_acres IS NOT NULL THEN 'override' ELSE 'measured' END
WHERE f.boundary IS NOT NULL AND f.boundary_geom IS NULL;
```
Multi-part fields (geometry in `field_polygons`) get a second backfill: `ST_Collect(ST_GeomFromGeoJSON(geojson))` per `field_polygons` row grouped by `field_id` — verify against a couple of known multi-part fields before trusting it.

---

## 3. Import pipeline (priority #1)

**One importer covers all three sources** — shapefile, John Deere Operations Center, Climate FieldView — because **Ops Center and FieldView both export plain WGS84 shapefiles.** A shapefile is a shapefile; nothing source-specific to build.

```
[1] Upload .zip (or .shp+.dbf+.prj, or .kml, or .geojson)   browser-only, 25 MB, MAX_FEATURES=500
[2] Browser parse (fieldImportParser.ts): .zip→shpjs / loose→existing path / .kml→togeojson / .json→JSON.parse
       → reproject to EPSG:4326 (proj4 from .prj) → normalizeToPolygons (KEEP multi-part) → turf area = PREVIEW ONLY
[3] Preview (ImportPreviewMap) + AttributeMappingStep + dedupe overlap check
[4] Per field: save_field(...) → then set_field_boundary(...)  [SERVER validates geom + computes measured_acres]
[5] Done — measured_acres is the billable default (override NULL)
```

- **The `.zip` entry path** (the one real parser addition): `shpjs` already accepts a zip ArrayBuffer → GeoJSON (unzips + combines `.shp/.shx/.dbf`, reprojects from `.prj`). Add a `.zip` branch that feeds the existing `normalizeToPolygons`/`validateFeatureGeometry`; keep the loose-file path as fallback; add `.zip` to accepted extensions in `BulkFieldImport.tsx`.
- **Multi-part fix:** `normalizeToPolygons` today reduces a MultiPolygon to its **largest** ring (drops acres on multi-part fields). Change: preserve the full MultiPolygon for `boundary_geom`; the **server** measures the whole thing so the billed number is right regardless of UI split. (Safe interim if risky vs the parallel session: keep largest-poly for legacy `boundary`, but always send the **full** FeatureCollection to `set_field_boundary`.)
- **Bulk import:** wizard loops rows, `save_field` then `set_field_boundary` per row, each idempotent → a mid-import failure is re-runnable.
- **Canonical-field dedupe:** at preview, `find_overlapping_fields(p_geojson, p_customer_id)` returns existing fields with >80% area overlap (uses the GIST index). Wizard shows "looks like existing field **<name>**" with per-row **Skip / Replace boundary / Import as new** (default Skip) → a careless re-import never silently duplicates a billed boundary. v1 advisory only (no attribute auto-merge).

---

## 4. Acreage RPC (server-authoritative — the missing safety floor)

One new SECURITY DEFINER RPC is the **only** writer of `measured_acres`/`boundary_geom`. Replaces `save_field_geometry` as the import/draw save target (old RPC stays for back-compat).

```sql
CREATE OR REPLACE FUNCTION public.set_field_boundary(
  p_field_id uuid, p_boundary_geojson text, p_performed_by uuid, p_idempotency_key text DEFAULT NULL
) RETURNS jsonb     -- { field_id, measured_acres, billable_acres, was_clamped }
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$ ... $$;
```
**Body, in order:** (1) `require_admin_or_sales_rep()` + strict-actor (`auth.uid()`, reject mismatched `p_performed_by` → `ACTOR_MISMATCH`). (2) idempotency lookup `AND operation='set_field_boundary'`. (3) `v_geom := ST_Multi(ST_GeomFromGeoJSON(...))`; `ST_MakeValid` if invalid; reject empty. (4) **`v_measured := round((ST_Area(v_geom::geography)/4046.8564224)::numeric, 2)`** — the `::geography` cast = geodesic m² (never `ST_Area` on raw 4326 = square degrees). (5) **sanity band:** reject `< 0.1` or `> 5000` ac (`AREA_OUT_OF_BAND`) — stops a fat-fingered/self-intersecting polygon minting a bad bill. (6) write `boundary_geom`, keep legacy `boundary`/`centroid` fed, `measured_acres = v_measured`, `total_acres = COALESCE(override_acres, v_measured)`; verify `FOUND`. (7) audit + `logActivity`. (8) store idempotency result + return.

Companion RPCs in the same migration: `set_field_override_acres(p_field_id, p_override_acres, p_performed_by, p_idempotency_key)` (validate `> 0`; `NULL` clears) and `find_overlapping_fields(...)` (read-only dedupe).

---

## 5. Override model (makes the typed acre survive a redraw — the core defect fix)

Today `FieldSetup.tsx:854-857` **unconditionally overwrites `total_acres`** on any polygon change → a typed override is clobbered by a redraw. On a billing system, that means **a re-imported boundary can quietly change what a grower is charged.** Two columns fix this structurally.

- **Default:** new boundary → `override_acres` NULL → billable = `measured_acres` (shown as the default, no action needed).
- **Set override:** `set_field_override_acres` validates `> 0` (ties to the "0 acres → reject" decision), sets `override_acres` + `acres_source='override'` + mirrors `total_acres`, logs the change. `NULL` clears → reverts to measured.
- **Keeps the boundary:** override never touches `boundary_geom`/`measured_acres`. Re-draw/re-import recomputes `measured_acres` but **leaves `override_acres` untouched.** That's the defect this fixes.
- **Editable anytime:** the FieldSetup "Total Acres" input becomes **"Billable Acres (override)"** bound to `override_acres`, next to a read-only **"Measured: X ac"** label; editing calls `set_field_override_acres`. **Remove the `onPolygonsChange` unconditional overwrite (854-857).**
- **Audit:** every measured recompute + override change → `activity_feed`/`logActivity` `event='field_acres_changed'` (no new table).

---

## 6. Wire into the bill (one default line + 5 threadings)

**The one load-bearing change** — `FieldApplicationInvoice.tsx:313` (verify at build time):
```diff
- applied_acres: f.total_acres,
+ applied_acres: f.override_acres ?? f.measured_acres ?? f.total_acres,
```
This precedence = `billable_acres`. The per-location **Applied Acres input stays editable** (the as-applied override "on top"), so a partial application still types the real number and that bills.

**The 5 places the same precedence must be threaded** (so nothing falls back to bare `total_acres`): `:105` total sum · `:326`/`:339` `acresMap` builders · `:363` preview · `:414` save fallback (`l.applied_acres || l.override_acres || l.measured_acres || l.total_acres`) · the **server `COALESCE`** in `save_field_app_invoice` **and** `preview_field_app_invoice_split` (`COALESCE(applied_acres, override_acres, measured_acres, total_acres, 0)`). *Re-read live `pg_get_functiondef` for those two RPCs before editing — parallel-session territory.*

**Picker:** `SelectLocationsModal` already `select('*')` → gets the new columns; show **billable_acres** with a "measured: X" hint.

**Reject 0 applied acres:** client disables Save + message if any resolved applied_acres ≤ 0; **server** (authoritative) `RAISE EXCEPTION 'ZERO_APPLIED_ACRES'` in `save_field_app_invoice` after building the acres map.

---

## 7. Draw tool (secondary — already built, just repoint)

Hand-draw is the fallback for fields without a file — `FieldSetup` + `CRXMap` + `DrawLayer` + `DrawControl` already capture a polygon + turf preview. On `draw.create`/`draw.update`, call **`set_field_boundary`** with the drawn FeatureCollection instead of `save_field_geometry` → server measures it, same validation/band/audit as import. Turf stays a live preview; the server number is saved and billed. Draw and import converge on the one RPC.

---

## 8. Verification plan ("Done = ran and proven")

- **A. Migration/columns** (rolled-back `BEGIN…ROLLBACK`): backfill populates `measured_acres` for existing boundaried fields; `billable_acres` matches with/without override; `plpgsql_check`=0; one overload of each new fn.
- **B. `set_field_boundary`** (rolled-back smoke): 40.00-ac polygon → `40.00 ±0.02`; self-intersecting → `ST_MakeValid` (no garbage); 9,999-ac → `AREA_OUT_OF_BAND`; 0.05-ac → `AREA_OUT_OF_BAND`; double-submit key → one write + replay; wrong actor → `ACTOR_MISMATCH`.
- **C. Import** (UI, the priority): import a real **.zip shapefile**, a real **Ops Center export**, a real **FieldView export** (Mason supplies one each) → measured acres match the source within rounding, boundary draws right; re-import same farm → dedupe flags → Skip → no duplicate; multi-part field → acres = sum of all parts.
- **D. Override** (UI): type override 38.5 over measured 40.0 → persists with "Measured: 40.0" shown; **redraw → measured updates, override stays 38.5** (the regression this fixes); clear → reverts; enter 0 → rejected.
- **E. Bill** (UI, end-to-end): field-app invoice → Applied Acres defaults to 38.5 (override) not 40.0; edit to 20 → shares re-derive from 20; save → `field_app_locations.applied_acres=20`; no-override field → defaults to measured; legacy field → defaults to `total_acres` (no regression); 0 applied → `ZERO_APPLIED_ACRES`.
- **F. Advisors/docs:** `get_advisors` unchanged; `check-doc-drift` green; `lint`+`build`+`test` clean.

---

## 9. Files + migrations + Mason-OK gates

**Migrations (new only):** (1) `…_fields_two_acre_model.sql` — columns + GIST index + backfill. (2) `…_set_field_boundary_rpc.sql` — `set_field_boundary` + `set_field_override_acres` + `find_overlapping_fields`. (3) `…_field_app_acres_precedence.sql` — patch `save_field_app_invoice` + `preview_field_app_invoice_split` COALESCE + `ZERO_APPLIED_ACRES`. **(3 migrations.)**

**Frontend/TS:** `src/types/index.ts` (Field/ParsedImportField/FieldLocation) · `fieldImportParser.ts` (.zip + multi-part) · `BulkFieldImport.tsx` (.zip + `set_field_boundary` + dedupe UI) · `FieldSetup.tsx` ("Billable Acres (override)" + "Measured" label + remove 854-857 overwrite + draw→`set_field_boundary`) · `FieldApplicationInvoice.tsx` (default line + 5 threadings + 0-acre guard) · `SelectLocationsModal.tsx` (billable + measured hint) · docs (`database-schema.md`, `rpc-functions.md`, `migration-history.md`, CLAUDE.md Snapshot, CHANGELOG) + `regenerate-schema-registry.mjs`.

**Mason-OK gates:** (1) plan approval (the build spec). (2) **explicit OK before applying each of the 3 live migrations** (after `/explain-migration` + rls/drift/types reviewers + rolled-back smokes). (3) standard `/ship` green before prod push; Mason supplies the 3 real export files so import is proven on real data. (4) no edge-fn/data-deletion gates apply.

**Build-time re-verify (parallel field-app session):** re-grep `applied_acres: f.total_acres` + save fallback; re-read live `save_field_app_invoice` + `preview_field_app_invoice_split` before patching; confirm `field_polygons`/`save_field_polygons` behavior before changing multi-part handling.

---

## Headline takeaways
- **Highest-value structural fix = the `override_acres` column.** Today a typed acre is silently clobbered by any redraw (`FieldSetup.tsx:854-857`) — on a billing system, a re-imported boundary can quietly change a grower's charge. Two columns make the billable number immune to boundary edits.
- **Import needs almost no new code** — Ops Center + FieldView both export WGS84 shapefiles, so the existing `shpjs` parser covers all three; only a `.zip` entry branch is new.
- **The bill tie-in is genuinely one line** + 5 fallback threadings — the per-acre engine and editable applied-acres UX are already complete.
- **Server-side `ST_Area` is the missing safety floor** — acreage is 100% client turf with zero validation today; the new RPC's geodesic cast + `ST_MakeValid` + 0.1–5000 band stops a bad polygon from minting a bad bill.
