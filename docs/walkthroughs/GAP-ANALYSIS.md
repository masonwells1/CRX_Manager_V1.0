# ChemMan → CRX Manager Gap Analysis

Date: 2026-07-11. Sources: Mason's 4 narrated walkthrough videos of ChemMan (analyses in `extracted/*/analysis.md`) cross-referenced against a read-only survey of the current CRX codebase (`extracted/crx-current-state.md`).

Legend: ✅ CRX already has it · 🟡 CRX has part of it · ❌ CRX is missing it

---

## Area 1 — Field Mapping (video: "Field Mapping")

Mason's stated pain: *"Our app is too cluttered. You have to go to too many screens to see all the fields."* and *"You can only do one polygon [in our app]."*

| ChemMan capability Mason liked | CRX today | Verdict |
|---|---|---|
| One master list of every field, every customer, with typeahead customer filter | `Fields.tsx` has a global list + filters (customer/crop/county/status) + map toggle | 🟡 exists but he experiences it as cluttered/too many screens — UX problem, not a missing feature |
| Bulk map upload from John Deere / FieldView | 7-step shapefile/GeoJSON/KML import wizard exists | ✅ (parity; his may be a discoverability issue) |
| See EVERY customer's field on the map while adding/editing a field, with a declutter toggle | FieldSetup shows only the field being edited | ❌ all-fields context overlay while editing |
| Obstacle markers (oil wells, windmills) pinned on fields for sprayer guys | none | ❌ |
| Multiple basemap providers (Mapbox Sat / Google Sat / Road / Enhanced) | one provider (Mapbox) with satellite/roads/hybrid/terrain styles | 🟡 style variety exists; single provider |
| **FSA boundary click-to-adopt** — click a parcel, boundary + acres + lat/long auto-fill | manual draw or file import only | ❌ (flagship gap #1; note: true FSA/CLU parcel data is license-restricted — needs a data-source decision) |
| **Legal Lookup** — auto-fill Section/Township/Range/County from coordinates | FSA number text fields only | ❌ (BLM PLSS data is public — very buildable) |
| Vertex-editable auto boundary + freehand + multi-polygon in one field record | CRX **does support multi-part boundaries** (DrawLayer + `field_polygons`) with combined acreage | ✅ back-end parity — but Mason believes CRX is single-polygon, so either the UI hides it or it fails in practice. Must verify with him. |
| Multi-customer ownership with Shares % + auto-computed acres, flowing into jobs | `field_billing_defaults` (split % + price override) flows into per-acre billing | ✅ (parity) |

## Area 2 — Job / Application Scheduling (video: "Job Application Scheduling Layout" — his most important)

Mason's headline: *"Everything being on the same screen. That's about the biggest thing."* and Transfer-to-Invoice pro-rating is a *"phenomenal, phenomenal feature."*

| ChemMan capability Mason liked | CRX today | Verdict |
|---|---|---|
| One job record, 5 tabs (Locations / Chemicals / Loader / Applied / Notifications) | JobDetail has essentially the same tabs (Locations, Chemicals, Loader Worksheet, Applied, Map/Logs, Notifications) | ✅ structure parity — polish differences |
| **Map-based field picker searchable by CROP across ALL customers**, selections accumulate across searches | job locations are added per-customer; no global crop-first map picker | ❌ (flagship gap #2) |
| Split-owned fields (50/50 Mason/Clayton) auto-carried into the job | field billing defaults flow into jobs/invoicing | ✅ |
| Per-field planted vs applied acres, editable inline | `job_fields.acres_to_treat` + applied acres exist | ✅/🟡 (verify inline-edit UX) |
| Recipes: select / use-last-used / save-as | blend_recipes exist for blends; job chemical recipes = stub ("Filter by recipe" placeholder) | 🟡 |
| One-click GET WEATHER auto-fill (start+end) | weather auto-fill shipped 2026-06-30 | ✅ |
| Rem-ac column on the jobs grid (partial completion at a glance) | applied vs total acres tracked; no Rem-ac column on Jobs | 🟡 (small win) |
| Job tags (colored pills, mass edit, batches) | none | ❌ |
| Transfer to Invoice — pro-rate every product/charge by applied-acre share per customer | as-applied field invoices + per-acre billing splits SHIPPED (close_quote_as_applied etc.) | ✅ core parity — verify the one-click-from-job UX matches his mental model |
| Drag-and-drop Job Location Order that prints on the sheet | `job_fields.sort_order` exists; no drag-reorder UI; order does print in route order on sheets | 🟡 |

## Area 3 — Job Printing for the Sprayer Applicator (video: "Job Printing for sprayer applicator")

| ChemMan capability Mason liked | CRX today | Verdict |
|---|---|---|
| Configurable print packet (map type, field info, previous apps, blanks, banner, rate units) with save-as-default | Custom applicator sheet format has admin-configurable header/footer/columns | 🟡 config exists; far fewer options |
| **Printed MAPS: combined "blowout" overview page + one close-up page per field** | applicator sheets are text-only — no maps at all | ❌ (flagship gap #3 — likely the single most visible win) |
| Show previous application history on the packet | not on the sheet | ❌ |
| Loader worksheet auto-load-count reachable from the same screen | Loader Worksheet tab + PDF exist | ✅ |
| Per-customer billing-split table with % and phone numbers on the printed sheet | customer + acres print; no % / phone table | 🟡 |
| Equipment exports: John Deere / Shapefile / KML / Jobfile from the job map | none | ❌ (CRX can already parse these formats inbound; outbound export is new) |

## Area 4 — Mixer / Loader Sheet (video: "Mixer_Loader Sheet setup")

Mason's strongest quote: *"It already breaks out load one, load two, load three — it erases the manual errors with us making blend tickets."*

| ChemMan capability Mason liked | CRX today | Verdict |
|---|---|---|
| Auto load-count + per-load product breakdown + right-sized remainder load | `loaderWorksheet.ts` does exactly this, penny-exact, unit-tested | ✅ core math parity |
| Tank capacity auto-fills from a **Vehicle record** but editable (tender-tank scenarios) | capacity typed per job; **no vehicles/fleet table** | ❌ vehicles/fleet (flagship gap #4 — also unlocks ChemMan-style vehicle assignment everywhere) |
| **Multiple saved worksheets per job** (one per vehicle/tank scenario, Select/Edit/Delete) | one worksheet per job | ❌ |
| Per-load acres editable after generation; everything overridable | computed only | ❌ |
| Load-balance modes (Full Loads / Remainder) | fixed proportional-split behavior | 🟡 |
| "Click loads to mark done" checklist | none | ❌ (nice-to-have) |
| Individual vs condensed load display toggle | individual only | 🟡 |
| Ground crew + crew members on the worksheet | ground_crews exist for dispatch, not on worksheet | 🟡 |
| Operator-entered as-applied (name, vehicle, date, tach, weather) editable later | as-applied entry + weather auto-fill shipped; tach/flights/starts fields absent | 🟡 |
| Attach sprayer log files to a job | none | ❌ |
| Drag route order prints for the sprayer | sort_order prints; no drag UI | 🟡 |

---

## Ranked build candidates (Claude's recommendation, pre-interview)

1. **Printed job-packet maps** — combined blowout page + per-field close-up pages in the applicator PDF, plus a print-options panel (map type, previous-apps, blanks). Uses Mapbox Static Images API; frontend-only. The most visible daily win, and it upgrades an artifact Mason already prints.
2. **Map-based, crop-first field picker on the job editor** — search every field in the system by crop/customer/name on a satellite map, accumulate selections, land them as job locations. Closes his #1 "same screen" love on the most important video.
3. **Vehicles/fleet + loader-worksheet upgrades** — vehicles table (name, capacity, type), capacity auto-fill, multiple saved worksheets per job, per-load acre edits, mark-done checklist. Closes the blend-ticket-error killer feature end to end.
4. **Legal Lookup + fields UX pass** — PLSS section/township/range auto-fill (public BLM data), all-fields context overlay in FieldSetup with declutter toggle, obstacle markers, Rem-ac column, job tags.
5. **FSA parcel click-to-adopt** — needs a data-source decision first (true CLU data is USDA-restricted; state/county parcel alternatives vary). Park behind a research task.
6. **Equipment exports (Shapefile/KML/John Deere)** — outbound export of job/field boundaries. Valuable but fewer daily touches.

Items already at parity that Mason may not realize: multi-part (multi-polygon) fields, shapefile import, billing-split flow into invoices, weather auto-fill, loader math. The interview should demo-check these rather than rebuild them.
