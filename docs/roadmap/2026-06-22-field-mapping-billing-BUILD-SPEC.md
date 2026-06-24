# Build Spec — Field Mapping + Per-Acre Billing (the "how")

**Created:** 2026-06-22 · **Companion to:** [`2026-06-22-field-mapping-and-per-acre-billing-roadmap.md`](2026-06-22-field-mapping-and-per-acre-billing-roadmap.md) (the "what/why")
**Status:** SPEC ONLY — nothing built. Execution is **blocked** until the parallel *Field Application Invoice* session lands (see Pre-flight).

> **Plain-English summary for Mason.** This document is the step-by-step build plan for everything we agreed to build: (1) the 5 hardening fixes Codex found in the billing engine, (2) the field-map → acres → bill feature you originally asked for, (3) polish items, and (4) the bigger grower-portal foundation. Each database change is small, reversible, and goes through the full safety pipeline (`/ship` reviewers + Codex gate + a rolled-back live test), and **needs your one-word OK before it touches the live database.** Nothing here runs until you say go.

---

## ⚠️ Pre-flight — DO THIS FIRST when the field-app session lands

Another session is actively editing the **Field Application Invoice** area (`save_field_app_invoice`, `FieldApplicationInvoice.tsx`, `post_invoice_group`, related migrations). **Almost all of Phase 1 lives in those exact files.** Before building anything:

1. **Confirm that session is merged to `main`** and its branch is done (ask Mason; verify with `git log origin/main` + `list_migrations`).
2. **Re-ground this spec against the LIVE code** — pull the current `pg_get_functiondef('save_field_app_invoice')` etc. fresh. Their work may have **already fixed some Codex findings** (e.g. the 0-acres guard) or **moved line numbers**. Do NOT trust this spec's citations blindly — re-verify each finding still exists before fixing it.
3. **One session writes the DB at a time.** Do not apply any migration here while that session is live. (CRX rule; prevents schema drift/corruption.)
4. Re-run the **rolled-back smoke** (the one proven 2026-06-22) against their final code to confirm the happy path still holds, then proceed.

---

## Cross-cutting conventions (every phase obeys these — CLAUDE.md red lines)

- **Money = `bigint` cents.** Never float/`parseFloat` on `*_cents`. Display ÷ 100.
- **Every mutating RPC:** `SECURITY DEFINER` + `SET search_path = public, pg_temp`, accepts `p_idempotency_key text DEFAULT NULL` and **uses it** (lookup scoped `AND operation = '<rpc_name>'`).
- **Strict actor:** bind `auth.uid()`, reject a mismatched `p_performed_by` (`ACTOR_MISMATCH`), role-gate (`is_admin()`/`is_sales_rep()`).
- **New tables:** RLS policies, no exceptions. **New columns:** update `src/types/index.ts`.
- **Frontend:** `checkMutationResult()` after `.update()/.delete()`, `assertRpcResult()` after an RPC, no `confirm()/alert()`, Lucide icons, Tailwind only.
- **Migration safety:** read the LIVE `CHECK`/overloads first; reproduce the existing function **byte-faithful** before patching; new enum lists must be a **superset** of old; never set `updated_at` on a table that lacks it.
- **"Done" = ran and proven:** every DB change gets a rolled-back live smoke (`scripts/smoke/`) + `npm run build` + `npm run test`; UI changes get opened and looked at. A green unit suite is **not** proof.
- **Gate:** each migration → `/ship` (rls-security + migration-drift + types-drift reviewers) → Codex review → apply-guard proof → **Mason's explicit OK to apply live** → post-apply sweeps. Code auto-pushes once green; **migrations never auto-apply.**

---

# PHASE 1 — Finish & secure the as-applied billing loop

*Collision risk: HIGH (same files as the active session). Build only after Pre-flight. Order: the two HIGH fixes first, then MED, then the job-shortcut convergence.*

Reference (verify fresh at build time): the canonical engine is `save_field_app_invoice` (latest def currently in migration `20260616191740_blend_and_fieldapp_invoice_audit_rows.sql`), `derive_customer_shares_from_fields` (`20260429140635`), `compute_application_service_fee`. Frontend `src/pages/FieldApplicationInvoice.tsx`.

### 1.1 (HIGH) Reject 0 / negative applied acres
- **Problem:** UI sends `applied_acres: l.applied_acres || l.total_acres` → a real **0 silently becomes full-field acres**; negatives pass unchecked → negative bill.
- **Server fix:** in `save_field_app_invoice`, in the location loop, after resolving each location's acres, `RAISE EXCEPTION 'INVALID_ACRES: applied acres must be > 0 for field %'` when `<= 0` or NULL. Also guard the override grower-share path against negative amounts.
- **Frontend fix:** `FieldApplicationInvoice.tsx` — replace `||` with explicit handling (`applied_acres` must be a positive number; don't coerce 0→total), add `min` on the input + a pre-save validation message.
- **CONFIRMED (Mason 2026-06-22):** **reject / block with a clear message** ("enter applied acres, or remove the field"). Never bill 0 and never silently fall back to full acres.
- **Files:** 1 migration (patched `save_field_app_invoice`), `FieldApplicationInvoice.tsx`.
- **Done =** rolled-back smoke: `applied_acres = 0` → rejected; `= -5` → rejected; UI: typing 0 is blocked with a message.

### 1.2 (HIGH) Make grouped delete/edit/post `deleted_at`-aware
- **Problem:** soft-deleting one customer's invoice in a split group leaves it visible to group operations — sibling-load, edit-reuse, and `post_invoice_group` select by `invoice_group_id` **without excluding `deleted_at IS NOT NULL`** → a deleted invoice can be reused or posted.
- **Fix:** add `AND deleted_at IS NULL` to every `invoice_group_id` select in `save_field_app_invoice`, `post_invoice_group`, and the frontend group-load query in `FieldApplicationInvoice.tsx`.
- **Verify first:** confirm `invoices.deleted_at` exists and `delete_invoices` soft-deletes (Codex cited `20260620140000`); confirm the UI can even soft-delete a single group member (if not, severity drops).
- **Files:** 1 migration (patched `save_field_app_invoice` + `post_invoice_group`), `FieldApplicationInvoice.tsx`.
- **Done =** smoke: group of 2 → soft-delete one → edit & post the group → the deleted one is NOT resurrected or posted.

### 1.3 (MED) Capture product cost on override (grower-share) acres
- **Problem:** the `v_chem_qty_a` ("included in grower share") line inserts `cost_cents = 0` and never adds to `v_invoice_cost` → **margin overstated** on override-acre invoices (the customer's **bill is correct**; only internal cost/profit is wrong).
- **Fix:** on the `v_chem_qty_a` insert, set `cost_cents = safe_cents_qty(v_unit_cost, v_chem_qty_a)` and add it to `v_invoice_cost`. Revenue stays $0 (the override $/ac line carries the revenue).
- **Files:** 1 migration (patched `save_field_app_invoice`).
- **Done =** smoke with an override field → `invoices.total_cost_cents` includes the product cost for the override acres.

### 1.4 (MED, low practical impact) Acre-rounding drift
- **Problem:** `derive_customer_shares_from_fields` rounds `share_acres` to 2 dp before billing → tiny over/under-bill on small splits.
- **Fix (optional):** compute `share_acres` for the **billing math** at higher precision (4 dp) while still **displaying** 2 dp; or largest-remainder reconcile per field so customer shares sum to the field's applied acres.
- **Files:** 1 migration (patched `derive_customer_shares_from_fields`).
- **Done =** smoke with a deliberately tiny split → billed-acre sum reconciles. *Lowest priority — flag and batch.*

### 1.5 (MED) Bind / admin-gate `salesman_id`
- **Problem:** `p_performed_by` is actor-bound (good), but `p_invoice.salesman_id` is taken from the client unchecked → a sales rep could attribute an invoice to another user.
- **Fix:** non-admin actors → force `salesman_id = v_actor` (or reject a mismatch); admins may set any. Mirrors CRX's strict-actor pattern.
- **Files:** 1 migration (patched `save_field_app_invoice`).
- **Done =** smoke as `sales_rep` setting a foreign `salesman_id` → forced to self / rejected; as admin → allowed.

### 1.6 Converge `transfer_job_to_invoice` onto the canonical engine
- **Problem:** the job→invoice shortcut emits **chemicals only** — drops the per-acre **service-fee line** and **doesn't bind the actor** to `auth.uid()` (actor-forgery).
- **Fix:** route `transfer_job_to_invoice` through (or mirror) `save_field_app_invoice` so it emits the `is_application_fee` line via `compute_application_service_fee` and applies the same actor binding + idempotency.
- **Verify first:** confirm `transfer_job_to_invoice` still has live callers (a sibling RPID `create_invoice_from_delivery` was retired as dead code 2026-06-17 — don't patch a corpse).
- **Files:** 1 migration; possibly the job→invoice button caller.
- **Done =** smoke: complete a job → transfer → invoice carries the service-fee line and a bound actor.

**Phase 1 packaging:** bundle 1.1–1.5 as **one reviewed migration** that reproduces the latest live `save_field_app_invoice`/`derive_customer_shares_from_fields` byte-faithful then applies all patches (fewer apply-gates, one smoke matrix). 1.6 can be a second migration. Both gated on Mason's OK.

---

# PHASE 2 — Field map → acres → bill (the original ask)

**📐 Full execution-ready design (grounded in current code by a read-only workflow):** [`2026-06-22-PHASE2-field-map-acres-design.md`](2026-06-22-PHASE2-field-map-acres-design.md). Corrected scope summary below.

> **Big correction (verified 2026-06-22):** drawing (`CRXMap`/`DrawControl`/`DrawLayer`), shapefile/KML/GeoJSON import (`BulkFieldImport` + `fieldImportParser` via shpjs/proj4/togeojson), and PostGIS geometry storage (`fields.boundary geography(POLYGON,4326)`, populated; PostGIS 3.3.7 enabled) are **ALL ALREADY LIVE.** Phase 2 is therefore **small** — not greenfield.

**Already live — do NOT rebuild:** hand-draw · shapefile/KML/GeoJSON import · `fields.boundary`/`centroid` geography columns · `save_field`/`save_field_geometry`/`save_field_polygons` RPCs · the proven `ST_GeomFromGeoJSON(text)::geography` idiom · the editable applied-acres UX on the field-app invoice · the `derive_customer_shares_from_fields` per-acre engine.

**Net-new (the whole of Phase 2 — 3 migrations):**
- **2.1 Two acre columns** — add `measured_acres` + `override_acres` (+ `boundary_geom geometry(MultiPolygon,4326)` + `acres_source`) to `fields`. **Billable = `COALESCE(override_acres, measured_acres, total_acres)`**; `total_acres` kept as legacy fallback (no risky one-migration rewrite). Backfill measured from existing boundaries.
- **2.2 Server-authoritative acreage RPC** — new `set_field_boundary` is the **only** writer of `measured_acres`: `ST_MakeValid` + geodesic `ST_Area(::geography)/4046.8564224` + a **0.1–5,000 ac sanity band** + strict-actor + idempotency. *(Today acreage is 100% client turf with zero server validation — this is the missing money-safety floor.)*
- **2.3 Override model** — the typed override gets its own column so it **survives a redraw**. **#1 structural defect this fixes:** today `FieldSetup.tsx:854-857` clobbers a typed acre on any polygon change → a re-imported boundary can silently change a grower's bill. Editable anytime; keeps the boundary; logged.
- **2.4 `.zip` importer + multi-part + dedupe** — one `.zip` branch in the parser covers shapefile **+ Ops Center + FieldView** (all export WGS84 shapefiles); preserve multi-part fields (today reduced to largest ring → drops acres); flag >80%-overlap duplicates on re-import (Skip/Replace/New).
- **2.5 Bill tie-in (one line + 5 threadings)** — change the field-app invoice default from `f.total_acres` to `f.override_acres ?? f.measured_acres ?? f.total_acres` (+ thread the same precedence through 5 fallbacks + the server `COALESCE` in `save_field_app_invoice`/`preview_field_app_invoice_split`) + the **0-acre reject** guard. The per-acre engine + editable applied-acres UX are reused unchanged.

**Collision:** 2.5 edits `FieldApplicationInvoice.tsx` + `save_field_app_invoice`/`preview_field_app_invoice_split` = the parallel session's territory (re-verify live before editing); 2.1–2.4 are lower-collision (fields/import). All migrations gated on Mason's OK to apply live.

---

# PHASE 3 — Polish

### 3.1 Recipe pricing
- **Problem:** `load_recipe_into_job` inserts `price_per_unit_cents = 0` → recipe-loaded jobs need manual re-pricing.
- **Build:** add optional `price_per_unit_cents` to `blend_recipe_items`; `load_recipe_into_job` seeds it (falling back to tier/quote pricing when null).
- **Files:** 1 migration, `src/types/index.ts`, recipe editor UI.
- **Done =** smoke: load a priced recipe → job lines carry the price, no manual re-price needed.

### 3.2 "Applied but not yet invoiced" reconciliation view
- **Build:** read-only page/query: completed jobs + approved-unbilled blend tickets + `application_records WHERE invoice_id IS NULL`. Zero write risk; high value (AR-leakage guard; pairs with existing Unbilled reconciliation).
- **Files:** 1 read-only RPC or view + a page (lazy-loaded per CLAUDE.md).
- **Done =** open the page → it lists known applied-but-unbilled work.

---

# PHASE 4 — Grower-portal foundation (bigger; design docs exist)

*These are larger and lean on the existing design docs (`docs/plans/2026-06-14-portal-roadmap-build-vs-reuse-audit.md`, `docs/audits/2026-06-10-grower-portal-brainstorm.md`, `…-spray-compliance-data-model.md`). Spec'd at outline level here; each gets its own detailed spec when we reach it.*

### 4.0 field_id linkage — RESOLVED (Mason 2026-06-22)
- **Decision:** **straight product sales do NOT need a field link — only what we apply.** So per-field cost comes from `application_records.field_id` + `blend_tickets.field_id` (which already carry the field). **We do NOT add `field_id` to `order_items`/`invoice_items`.** This removes the "blocker" — the lighter path is the chosen path, not just a v1 compromise.

### 4.1 Field seasons + breakeven + costs (internal-first, no portal needed)
- `field_seasons` (field × season × crop), whole-field **breakeven calculator** (`breakeven_yield = total_costs / price`), `field_season_costs` (auto-suggest lines from the grower's own CRX invoices/applications). Greenfield tables + arithmetic; reuses `fields`.

### 4.2 Field profitability map
- One more Mapbox fill layer (red/white/green `profit/ac`) on the existing draw stack. The "your worst 10% of acres cost you $X" sales hook → funnels into soil testing.

### 4.3 Spray compliance (Mason-priority)
- Chemical-shed inventory **auto-credited from CRX deliveries** (`delivered − applied = on-hand`); per-field spray checklist; **follow-up trip timers** (`spray_reminders` + pg_cron + `send-email`). **Prerequisite:** label data (REI/PHI/EPA#) is **0% populated** — load top-20 products first.

### 4.4 Yield upload, soil/tissue tests, nutrition programs
- `yield_datasets`/`yield_grid_cells` (mirror blend-ticket OCR pipeline shape); `soil_tests`/`tissue_samples`; `nutrition_programs` (reuse quote machinery). Per the brainstorm doc.

### 4.5 Portal security wall (LAST — heavy review)
- Separate portal app, same Supabase DB; `customer` role + customer-scoped `portal_*` RPCs. Internal-first: prove the data model inside CRX Manager, then build the wall once.

---

# PHASE 5 — As-applied AUTO-ingestion (DEFERRED per Mason)

- John Deere Operations Center + Raven monitor API → auto-pull as-applied acres (so Phase 1's manual entry becomes automatic). GeoJSON MultiPolygon / WGS84 canonical; shapefile/KML import already exists. Import spatial-overlap **dedupe** (canonical/merged field); USDA **CLU** where obtainable (§1619 caveat). Manual entry ships first.

---

## Build order & dependencies

```
Pre-flight (field-app session merged + re-verify)
  └─ Phase 1.1, 1.2 (HIGH) ─┐
       └─ 1.3, 1.4, 1.5 (MED, batch in one migration)
            └─ 1.6 (job-shortcut convergence)
  └─ Phase 2.1 → 2.2 → 2.3   (field map → acres → bill; can start in parallel once DB is free)
  └─ Phase 3.1, 3.2          (polish)
  └─ Phase 4.0 DECISION → 4.1 → 4.2 → 4.3 → 4.4 → 4.5
  └─ Phase 5 (deferred)
```

Each migration: `/ship` reviewers → Codex gate → apply-guard proof → **Mason OK** → apply → post-apply sweeps → rolled-back smoke proven → docs synced (`check-doc-drift`).

## Decisions — RESOLVED (Mason 2026-06-22)
1. ✅ **0-acre handling** (1.1): **reject / block with a message.**
2. ✅ **Acre model** (2.2): **two acres** — map-measured + typed override (no FSA acres); override keeps the boundary, editable anytime.
3. ✅ **Import-first** (Phase 2): Mason has many boundaries in **shapefiles + Ops Center + FieldView** → one shapefile importer first; draw secondary; live API deferred (Phase 5).
4. ✅ **field_id linkage** (4.0): **product sales don't link to fields; only applications/blends do** (already carry field_id). No `field_id` on order/invoice items.

## Still open (business, not code)
- **Satellite basemap commercial-license** (Phase 2): confirm imagery commercial terms / cost tier — a business check for Mason (free government-imagery path exists as a fallback).

## Estimate (rough, for sequencing — not a commitment)
- Phase 1: small. 2 migrations, mostly surgical patches + smokes. *(Days, not weeks.)*
- Phase 2: medium. PostGIS + acreage RPC + map wiring.
- Phase 3: small.
- Phase 4: large (multi-feature; the portal program). Sequenced over time, decision-gated.
- Phase 5: deferred.
