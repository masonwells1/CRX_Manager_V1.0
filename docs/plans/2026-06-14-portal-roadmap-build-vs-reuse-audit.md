# Grower Portal Roadmap — Build-vs-Reuse Audit (G4–G15)

**Date:** 2026-06-14 · **Status:** READ-ONLY AUDIT — verified against the live DB + codebase. Informs sequencing; **nothing built.**
**Companion to:** [`2026-06-10-grower-portal-brainstorm.md`](2026-06-10-grower-portal-brainstorm.md) · [`2026-06-14-spray-compliance-data-model.md`](2026-06-14-spray-compliance-data-model.md)

Same exercise that reshaped G1/G2 (the 0%-populated label data), now across the rest of
Priority 0. **Method:** checked each proposed table for existence, field→cost linkage, the
`customer` role, existing `portal_*` RPCs, PostGIS/pg_cron, storage buckets, and the
frontend map/parser stack — all against the live system on 2026-06-14.

---

## Headline findings (these reshape sequencing)

1. **PostGIS is ALREADY enabled live.** The §5 open question ("enable PostGIS now or defer? — leaning defer") is **moot**: it's on. G10/G11 *can* do server-side spatial joins (yield grid × soil zones) from day one. GeoJSON+turf is now a simplicity *choice*, not a constraint.
2. **G5's "auto-pull costs from the grower's CRX invoices" is partially blocked.** `orders`, `invoices`, `quotes`, `deliveries`, `quote_items`, `order_items` have **no `field_id`** — `invoices` carries only a free-text `field_names`. Reliable field→cost linkage exists **only** via `application_records.field_id` and `blend_tickets.field_id` (+ `blend_ticket_fields`). So per-field cost auto-fill works for *applications/blends* but **not for invoice/order dollars** without a linkage decision (§G5 below).
3. **The portal security layer is 100% greenfield.** No `customer` role (profiles CHECK = `admin, sales_rep, driver, applicator, entity_recipient`), and **zero `portal_*` RPCs** exist. This is the slow, review-heavy gate the vision flags — nothing started.
4. **pg_cron + the whole notification stack are reuse.** `pg_cron` enabled; `send-email`, `notifications`, `email_log`, `ar_reminder_tracking` all live → G2 timers (§2.5 of the data-model doc) and G13 are *wiring*, not new infrastructure.

---

## Build-vs-reuse by roadmap item (verified live)

| # | Item | Data layer | Reuse assets (confirmed live) | Complexity | Notes / blockers |
|---|------|-----------|-------------------------------|------------|------------------|
| **G4** | Field seasons + breakeven | `field_seasons` **greenfield** | `fields` (customer polygons, `total_acres`); breakeven = arithmetic | **LOW** | No geo, no field-linkage problem. **Cleanest non-spray starter.** |
| **G5** | Field season costs + auto-pull | `field_season_costs` **greenfield** | `application_records.field_id`, `blend_tickets.field_id` (cost→field works); `field_billing_defaults` exists | **MED** | ⚠️ **Auto-pull from invoices/orders blocked — no `field_id`** (finding #2). 3 options below. |
| **G6/G7** | Soil / tissue testing | `soil_tests`, `tissue_samples` **greenfield** | `fields`, Storage bucket+RLS pattern, PostGIS (grid/zones) | **MED** | Design grids/zones spatially (PostGIS available). |
| **G8** | Nutrition / dry-fert program → quote | `nutrition_programs`, `program_items` **greenfield** | existing **quote machinery** (program→quote); **blend-ticket machinery** for dry fert | **MED** | Reuse, don't duplicate, blend tickets. |
| **G9** | Portal MVP (auth + read-only) | `customer_users` **greenfield**; `customer` role **NOT in CHECK**; **0 `portal_*` RPCs** | Supabase auth, profiles, RLS patterns | **HIGH** | The **security gate** — slowest, review-heavy. Defer until the internal model is proven. |
| **G10** | Spatial yield upload | `yield_datasets`, `yield_grid_cells` **greenfield** | `fieldImportParser.ts` (shapefile/KML/GeoJSON), Storage pattern (**new `grower-uploads` bucket**), Edge-Fn pattern, **PostGIS** | **MED-HIGH** | Better-supported than feared — parser + PostGIS both live. |
| **G11** | Profitability map | frontend **greenfield** | **Mapbox stack confirmed: 10 components** (`CRXMap`, `FieldBoundaryLayer`, `DrawControl`, `FieldMarkers`, `LayerToggle`…); PostGIS | **MED** | Genuinely "one more fill layer" on a working map. |
| **G12** | Grower financial tools | frontend **greenfield** | `field_billing_defaults` (splits → rented-ground); G4/G5 data | **LOW-MED** | Pure UI over G4/G5; what-if sliders are cheap. |
| **G13** | Notifications | — | `send-email`, `notifications`, `email_log`, `ar_reminder_tracking`, `pg_cron` | **LOW** | Mostly reuse; **SMS** (Twilio) is the only new piece. |
| **G14** | LLM assistant | — | Edge-Fn pattern; Claude API | **MED** | Greenfield Edge Function; customer-scoped context + guardrails (§10.5). |
| **G15** | Nutrient-removal engine | — | yield data (G10) + crop-removal rates | **MED** | Blocked on G10 yield data; then a calc. |

*(G1–G3 covered in the spray-compliance data-model doc. No breakeven/yield/profitability code exists today — G4/G11/G12 frontend is greenfield but sits on the confirmed map + `fields`.)*

---

## The G5 field-linkage problem (biggest finding)

The vision's moat — *"auto-suggest cost lines from the grower's own CRX invoices/applications tied to that field+season"* — assumes invoice/order dollars can be attributed to a field. **They can't today:** no FK from `orders`/`invoices`/`quotes`/`deliveries` to `fields` (only `invoices.field_names`, free text). Three ways forward:

1. **Application/blend-first (lowest lift):** auto-pull per-field cost from `application_records` + `blend_tickets` (which *do* carry `field_id`), and treat invoice/order $ as whole-farm (manually allocated). Ships the moat for the application-heavy cost categories now.
2. **Add field linkage (bigger lift):** add `field_id` to `order_items`/`invoice_items` (or an order_item↔field allocation table). Cleanest long-term; a real schema project.
3. **Allocate via applications:** distribute an invoice's total across fields using the linked application records' acres. Approximate but automatic.

Recommendation: **option 1 for v1** (matches "trust beats false precision"), with option 2 queued if per-field invoice accuracy becomes a selling point.

---

## §5 resolved: PostGIS is on

No decision needed — PostGIS is enabled live. G10/G11/G6 can use server-side spatial joins whenever it helps (soil-zone × yield overlays, point-in-polygon binning). v1 can still stay in the GeoJSON+turf lane for simplicity, but it's no longer forced.

---

## Sequencing impact

- **Cleanest non-spray starter = G4** (field seasons + breakeven): pure greenfield data + arithmetic, reuses `fields`, no geo, no field-linkage problem. Good "demo to growers" piece.
- **G5 needs the field-linkage decision** before the auto-pull moat is real — don't promise invoice-level per-field costs until option 1/2/3 is chosen.
- **G10/G11 are lower-risk than feared** — parser, map stack (10 components), PostGIS, and the storage pattern are all live; the geo arm is mostly new *tables* + a new bucket, not new *capability*.
- **G9 (portal) stays the slow gate** — `customer` role + `customer_users` + the entire `portal_*` RPC surface are greenfield and security-critical. Confirms **internal-first**: prove the data model inside CRX Manager, then build the portal wall once.

> Read-only audit. Nothing here mutates the DB or commits to a build.
