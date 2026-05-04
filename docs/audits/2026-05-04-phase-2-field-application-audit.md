# Phase 2 — Field Application Workflow Audit

**Date:** 2026-05-04
**Auditor:** Claude (Opus 4.7, 1M context)
**Scope:** Read-only. No code changed. Independent rewrite of the Codex-authored Phase 2 file.
**Phase coverage:** Jobs, Dispatch Board, Blend Tickets, Field Application Invoices, Application Services, Application Records, Fields, Field Setup, Field Dashboard, Field-app components, the `process-blend-ticket` Edge Function, and the supporting RPCs (`save_field_app_invoice`, `preview_field_app_invoice_split`, `derive_customer_shares_from_fields`, `create_invoice_from_blend_ticket`, `post_invoice_group`, `save_job`, `complete_job`, `transfer_job_to_invoice`).

---

## Plain-English Summary

The field-application backbone is genuinely impressive. The hard parts — multi-customer field splits with per-acre overrides, two pricing modes side-by-side, server-computed previews before saving, atomic group posting, OCR ingest of paper blend tickets — all work and are wrapped in idempotent RPCs with append-only audit. Mason should not let any later phase undo that.

The friction is **not** in the math. It is in the **paper trail and the day-to-day flow**:

1. **The applicator never gets a printed packet.** The Print button on the field-application invoice is a TODO (`FieldApplicationInvoice.tsx:522`). Two of the three "save recipe / select recipe" buttons on the chemical entry are also TODOs (`FieldAppChemicalEntry.tsx:295` and `:298`). The applicator's "Loader Worksheet" lives only on `JobDetail.tsx` (`:846`) and is screen-only — there is no print mode and no field map. So the person actually driving the sprayer has nothing to carry into the cab except whatever was printed by hand.
2. **The same data is re-typed in three places.** `Jobs / JobDetail` collects fields, chemicals, applicator, vehicle, applied conditions. `BlendTicketDetail` collects fields (`blend_ticket_fields`), products, applicator name, mixer name, tank number, vehicle, application service. `FieldApplicationInvoice` collects locations, chemicals, applicator, wind, temperature. None of the three feed cleanly into the others, and the field-app invoice does not even *save* its wind/temp/applicator inputs (see P2-1).
3. **There is no link between Jobs and Deliveries**, even though both are "trips with chemicals to a customer's farm". Dispatch Board only shows jobs (`DispatchBoard.tsx:57-79`); deliveries don't appear on the same map. A driver and an applicator are scheduled in two different worlds.
4. **Application Records — the document Mason needs for state compliance — is a list with no detail page and no per-record PDF.** It captures wind/humidity/temperature when a job is completed, but there is no "print this for the file" path.
5. **The OCR auto-approve threshold is hard-coded in the Edge Function (`process-blend-ticket/index.ts:943`)** even though the rest of the app reads `useOCRThresholds()` from settings. Mason can tune the UI thresholds and the function will still fire at 70%.

Almost everything in this report is product-shaped, not engineering-rescue-shaped. The pipeline is correct; it just doesn't know how to hand work off between the desk and the cab.

---

## Evidence Reviewed

| Source | What I read | Why it mattered |
|---|---|---|
| `CLAUDE.md` | Hard red lines + business lifecycles (Job, PO, Return) | Confirmed Job lifecycle is `scheduled → in_progress → completed → cancelled → invoiced` |
| `docs/workflows/SAFE_DEVELOPMENT_RULES.md` | Mandatory pipeline-change rules | Confirmed any change here must touch types, RLS, idempotency, audit log |
| `docs/workflows/QUOTE_TO_DELIVERY.md` (Field Application Workflow section) | Multi-customer split RPC contract | Confirms `derive_customer_shares_from_fields`, Mode A vs Mode B, `invoice_group_id` semantics, posted-edit lock |
| `docs/audits/2026-05-04-phase-0-current-state-audit.md` | Baseline counts and routes | Re-cited route table, FieldDetail dead-code flag |
| `docs/audits/2026-05-04-ui-improvement-plan.md` (sections 8 & 9) | Existing field-app friction list | Avoid duplication; go deeper |
| `src/pages/FieldApplicationInvoice.tsx` (791 lines) | The multi-tab editor | Print TODO, unsaved Applied Info fields, tab structure, sibling banner, post flow |
| `src/pages/Jobs.tsx` (430 lines), `src/pages/JobDetail.tsx` (1001 lines) | Job list + detail | Save/start/complete/transfer, applied-info modal, Loader Worksheet |
| `src/pages/DispatchBoard.tsx` (360 lines) | Dispatch map | Date-only, no deliveries, applicator-assignment dropdown |
| `src/pages/BlendTickets.tsx` (719 lines), `src/pages/BlendTicketDetail.tsx` (1688 lines) | OCR review + linkage | OCR review flow, field assignments, three "create" outputs (order / invoice / app record) |
| `src/pages/ApplicationServices.tsx` (243), `src/pages/ApplicationServiceDetail.tsx` (178) | Per-acre service catalogue | Rate, cost, vehicle linkage |
| `src/pages/ApplicationRecords.tsx` (288) | Compliance records | List only, no detail, no PDF |
| `src/pages/Fields.tsx` (520), `src/pages/FieldSetup.tsx` (912), `src/pages/FieldDashboard.tsx` (691), `src/pages/FieldDetail.tsx` (767) | Field mgmt | Confirmed FieldDetail.tsx is dead — Fields → /fields/:id → FieldSetup |
| `src/components/field-app/SelectLocationsModal.tsx` (280) | Field picker | Half-screen, fixed split, no tablet variant |
| `src/components/field-app/FieldAppChemicalEntry.tsx` (320) | Chemical entry | Two TODOs, no print preview |
| `src/components/field-app/CustomerSharesTable.tsx` (139), `src/components/field-app/ApplicationServicePicker.tsx` (71) | Preview tables / service dropdown | Sound; preview is server-computed |
| `src/components/map/CRXMap.tsx`, `FieldBoundaryLayer.tsx`, `MapContainer.tsx` | Map plumbing | Used by Dispatch + SelectLocations + FieldSetup; consistent API |
| `supabase/functions/process-blend-ticket/index.ts` (1100) | OCR Edge Function | Hard-coded `>=70` confidence cutoff (line 943) |
| `supabase/migrations/20260430200000_field_app_workflow_phase8.sql` | `save_field_app_invoice` | Single-overload-verified |
| `supabase/migrations/20260430210000_field_app_workflow_phase9.sql` | Auth gate added | Adds permission gate to both write paths |
| `supabase/migrations/20260430230000_field_app_workflow_phase11.sql` | RLS for `application_records` | Applicators see only their own records |
| `supabase/migrations/20260430240000_field_app_workflow_phase12.sql`, `phase14.sql` | Posting + prepay credit math | Confirms group post + prepay handling |
| `src/App.tsx:181-219` | Route mounts | Confirmed `/jobs/new` *is* served by `JobDetail` (handled via `id === 'new'`); `/fields/:id` is served by `FieldSetup`, not `FieldDetail` |
| `src/hooks/usePageMeta.ts:12,17,24` | Page titles | `/jobs` → "Job Management" but the on-page heading says "Job Schedule" |

---

## Findings

### P2-1 — "Applied Info" tab on the field-app invoice doesn't actually save

**Business risk:** HIGH. State compliance, dispute defence, and applicator history all live in wind/temperature/applicator-name. The user has every reason to believe the boxes are saved (they look identical to the rest of the form, are styled with the same green focus ring, and do flip the dirty flag) — but the values are local React state only.

**Evidence:**
- `src/pages/FieldApplicationInvoice.tsx:89-91` declares the three pieces of state: `windDirection`, `temperature`, `applicator`.
- `src/pages/FieldApplicationInvoice.tsx:739-767` renders the three editable inputs under the "Applied Info" tab.
- `src/pages/FieldApplicationInvoice.tsx:331` and `:380` use `windDirection` only as a *fallback for per-location wind* in the Save and Preview RPC payloads (`l.wind_direction || windDirection || null`).
- `temperature` and `applicator` are **never read** anywhere except their own onChange handlers. They are not in `handleSave`'s payload (`:360-421`) and not loaded back in `fetchInvoice` (`:115-234`). After the user saves and reloads, both fields are blank.
- This is also the source of the misleading dirty flag: the user sees the leave-page warning fire, types into Applied Info, and (correctly, per the model the page implies) believes the data is saved.

**Fix direction:** Either (a) extend `save_field_app_invoice` to accept and persist invoice-level `wind_direction`, `temperature`, `applicator_name`, and load them back on read, or (b) hide the inputs entirely until they are wired (preferred near-term: the page should not pretend to capture data it discards). If a separate `field_app_applied_info` table is wanted to mirror `job_applied_info`, that's a migration on its own.

**Likely files:** `src/pages/FieldApplicationInvoice.tsx`, `supabase/migrations/<new>.sql`, `src/types/index.ts`.

---

### P2-2 — Print button on field-app invoice is a TODO; the applicator has no print packet at all

**Business risk:** HIGH. Mason's stated #1 deliverable for the applicator is the "print packet" — sprayer mix sheet, field map, spray instructions, signature line. The button exists, looks active, and does nothing.

**Evidence:**
- `src/pages/FieldApplicationInvoice.tsx:521-525` renders a Print button whose onClick is `() => { /* TODO: print */ }`.
- `src/lib/invoicePdf.ts` exists (3 layouts per `CLAUDE.md`) but Grep for `field-app|fieldApp|sprayer|packet|loader` shows zero references in `invoicePdf.ts` or anywhere else outside `JobDetail.tsx`'s on-screen-only Loader Worksheet (`JobDetail.tsx:845-866`). There is no field-application PDF generator.
- The `JobDetail` Loader Worksheet at `src/pages/JobDetail.tsx:845` is on-screen only — no print CSS, no print button, and the values are computed only when the job has a vehicle assigned.
- `FieldAppChemicalEntry.tsx:295` and `:298` carry two more TODOs ("Select Recipe", "Save As Recipe") — not a packet issue per se, but a related missing feature on the same screen.

**Fix direction:** Build the field-app print packet against the same shape as the existing invoice PDF generator. Minimum content (Mason should sign off on this list — see Open Questions): customer + farm, fields with map thumbnails (polygon SVG from `boundary_geojson`) and acres, chemical mix table with quantities and rate-per-acre, application service line and total, weather/wind/applicator boxes for the cab, signature block. Use `src/components/map/FieldBoundaryLayer.tsx` to render boundary thumbnails for print, OR generate static SVG from `boundary_geojson` (simpler — Leaflet inside a print PDF is awkward).

**Likely files:** `src/lib/fieldAppPacketPdf.ts` (new), `src/pages/FieldApplicationInvoice.tsx`, `src/pages/JobDetail.tsx` (mirror packet for jobs), `src/lib/invoicePdf.ts` if any layout is shared.

---

### P2-3 — Same field/chemical/applicator data captured in three unrelated places

**Business risk:** MEDIUM-HIGH. Re-typing causes errors and slows daily work. It also means "Did the applicator log this?" depends on which screen Mason looks at.

**Evidence:**
- **Jobs (`src/pages/JobDetail.tsx`)** captures: customer (`:140`), job_date / scheduled_time (`:141-142`), applicator_id (`:143`), vehicle_id (`:144`), recipe_id (`:145`), `job_fields` rows with `acres_to_treat` (`:151,247-254`), `job_chemicals` rows with quantity/unit/rate/cost/price (`:152,256-269`), `applied_info` (`:159-166`) on completion: wind speed, wind direction, temperature, humidity, gallons, notes.
- **Blend Ticket (`src/pages/BlendTicketDetail.tsx`)** captures: customer_id (`:88`), driver_name (`:94`), applicator_name (`:95`), mixer_name (`:96`), tank_number (`:97`), vehicle_info (`:98`), application_service_id (`:99`), `field_names` text (`:100`), total_acres (`:101`), application_rate (`:102`), products (`:42-53`), and a structured `blend_ticket_fields` table joined via `:151-201` with field_id, customer_id, planned_acres.
- **Field-App Invoice (`src/pages/FieldApplicationInvoice.tsx`)** captures: locations (`:85`) with applied_acres per field, chemicals (`:86`) with rate-per-acre, customer shares (`:87`), application_service_id (`:94`), wind direction (`:89`), temperature (`:90`), applicator (`:91`).
- All three carry "applicator name", "customer", "fields", "products with rate/acre", "application service". None of the three persists into the others — `BlendTicketDetail.tsx:310` accepts `selectedJobId` so a ticket *can* be linked to a Job, but there is no "Pre-fill the field-app invoice from this approved ticket" or "Pre-fill this job from this ticket". The closest thing is `transfer_job_to_invoice` (`JobDetail.tsx:455-476`) which creates an *order-style* invoice, not a field-app invoice.
- The "Field Names / Locations" input on the blend ticket (`BlendTicketDetail.tsx:969-978`) is a free-text comma list — typed by hand even when the structured `blend_ticket_fields` (`:1198-1293`) is also being filled in below it.

**Fix direction:** Three-step plan, each independently shippable:
1. **Pre-fill field-app invoice from approved blend ticket.** When user clicks "Create Invoice" on a blend ticket (`BlendTicketDetail.tsx:582`), if the blend ticket has `blend_ticket_fields` rows (a structured field/customer split), the resulting invoice should land directly on the field-app invoice editor with locations + chemicals already populated, not on the standard `/invoices/:id`. Today the RPC already produces grouped split invoices when fields are multi-customer; the UI is just routing to the wrong page.
2. **Drop the free-text `field_names` field on the blend ticket** in favor of the structured `blend_ticket_fields` (or keep as a read-only display synthesised from the structured rows). The double-entry is the source of confusion.
3. **Job-completion → field-app invoice path.** Add a "Generate Field-App Invoice" alternative to `transfer_job_to_invoice` for jobs whose customer has multiple billing splits or whose fields are billed to growers other than the contract-holder.

**Likely files:** `src/pages/BlendTicketDetail.tsx`, `src/pages/JobDetail.tsx`, `supabase/migrations/<new>.sql` (RPC additions), `src/pages/FieldApplicationInvoice.tsx`.

---

### P2-4 — Dispatch Board does not show deliveries and does not span dates

**Business risk:** MEDIUM. A real dispatcher's day includes deliveries and field-application jobs on the same map. Today the Dispatch Board sees only one of those two worlds, and only one day at a time.

**Evidence:**
- `src/pages/DispatchBoard.tsx:65-68` filters jobs to a single date: `gte('job_date', dateFilter).lte('job_date', dateFilter)`. The page header (`:184`) is just one date input — no range, no "this week".
- `DispatchBoard.tsx:57-79` queries `jobs`, `profiles`, `fields`. There is no `deliveries` query and no `delivery` markers on the map.
- The applicator-assignment dropdown (`:339-352`) is wired to write `jobs.applicator_id` directly via `handleAssign` (`:136-157`), bypassing the typed `save_job` RPC. It also writes `updated_at` directly. This works (jobs has `updated_at` per the schema) but it is the only field-app write path that doesn't go through an RPC, so it skips the auth gate added in `phase9.sql`. RLS does still cover it, but it's worth noticing as a one-off.
- The ChevronRight at `:325` is a static decoration; it does not navigate. Clicking the job number (`:312-317`) does navigate to `/jobs/:id` correctly.

**Fix direction:**
1. Add a date range or a multi-day view (today + next 7 days, with day separators).
2. Layer deliveries onto the same map: filter `deliveries` for the same date range, plot at the delivery's customer-default location or the `delivery_address`. Use a different marker shape so dispatchers can tell "field job" from "stop". This is a Phase 4-ish concern when Mason confirms the field-app team is also drivers.
3. Move the applicator-assignment write through a proper `assign_applicator` RPC that mirrors `assign_driver` patterns and respects period-open / role gates.

**Likely files:** `src/pages/DispatchBoard.tsx`, `supabase/migrations/<new>.sql` (add `assign_applicator` RPC).

---

### P2-5 — OCR auto-approve cutoff is hard-coded in the Edge Function and ignores the settings table

**Business risk:** MEDIUM. The UI lets Mason tune `auto_approve` and `needs_review` thresholds (`useOCRThresholds()` is read in `BlendTickets.tsx:36`, `BlendTicketDetail.tsx:33`, etc.) but the actual decision of whether a ticket lands in `completed` vs `needs_review` is made server-side at a fixed 70%.

**Evidence:**
- `supabase/functions/process-blend-ticket/index.ts:943`:
  `status: parsedData.overallConfidence >= 70 ? "completed" : "needs_review",`
- `src/hooks/useOCRThresholds` (referenced from `BlendTickets.tsx:29`) reads thresholds from the database — these flow into the on-page progress bars (`BlendTickets.tsx:418-424`, `BlendTicketDetail.tsx:786-791`), color-coding rules, and the manual-review affordance.
- Net effect: changing the settings record changes how the row is displayed but not which queue it goes into.

**Fix direction:** In `process-blend-ticket/index.ts`, fetch `system_settings` (or whatever row backs `useOCRThresholds`) at the top of the handler and use those values for the `completed` vs `needs_review` decision. Edge function already has admin-key access (line 925-928 reads `products` etc.). Default to 70 if the row is missing.

**Likely files:** `supabase/functions/process-blend-ticket/index.ts`, optionally `src/hooks/useOCRThresholds.ts` to expose its source-of-truth contract for documentation.

---

### P2-6 — `FieldDetail.tsx` is dead code

**Business risk:** LOW (engineering hygiene), but enough to confuse future agents and Mason.

**Evidence:**
- `src/pages/FieldDetail.tsx` (767 lines) defines a `default function FieldDetail()` with full save/edit logic.
- `src/App.tsx` route mounts: `fields/:id` → `FieldSetup` (`App.tsx:171`), `fields/:id/dashboard` → `FieldDashboard` (`App.tsx:172`). `FieldDetail` is not lazy-imported and not routed.
- Grep across `src/` returns exactly one match for `FieldDetail` outside the file itself: zero. (Phase 0 already flagged this.)
- Two divergent code paths now exist for "edit a field" — `FieldSetup.tsx` is the live one, `FieldDetail.tsx` is a stale copy. Anyone debugging field save logic and grepping for "save_field" will land on the wrong file 50% of the time.

**Fix direction:** Delete `src/pages/FieldDetail.tsx`. Any logic in it that's missing from `FieldSetup.tsx` should be reviewed first. Update `docs/reference/pages-routes.md` and the page count in `CLAUDE.md`.

**Likely files:** delete `src/pages/FieldDetail.tsx`, update `docs/reference/pages-routes.md` and `CLAUDE.md`.

---

### P2-7 — Application Records has no detail view and no per-record PDF

**Business risk:** HIGH for compliance. The records exist (`complete_job` writes them at `JobDetail.tsx:418` via the `complete_job` RPC, and `create_application_record_from_blend_ticket` writes them from approved blend tickets at `BlendTicketDetail.tsx:661`) but a state inspector or a customer who asks for the record has nowhere to print from.

**Evidence:**
- `src/pages/ApplicationRecords.tsx` (288 lines) is a list page only. The columns at `:141-201` show record_number, date, customer, field, applicator, acres, products count, vehicle, source. Clicking a row does nothing — no `onRowClick`, no Link wrappers around the `record_number` cell (`:146`).
- `App.tsx` mounts `/application-records` (`App.tsx:207`) but no `/application-records/:id`.
- `src/lib/reportPdf.ts` is used for the page-level CSV export only.
- Recent migration `20260430230000_field_app_workflow_phase11.sql` tightens RLS so applicators can only see their own records — good — but the read path is still "open the page, find your row, screenshot."

**Fix direction:**
1. Add `/application-records/:id` route + page that displays everything in `application_records` (header, fields, products, conditions, signatures if any) plus links back to source job/blend ticket.
2. Add "Print Record" PDF using the same engine as invoice PDF — the form is fundamentally the same shape: header + line items + conditions block.
3. Surface the record on the customer's `CustomerDetail.tsx` field tab so a sales rep can find it without going to a separate page.

**Likely files:** `src/pages/ApplicationRecordDetail.tsx` (new), `src/lib/applicationRecordPdf.ts` (new), `src/App.tsx`, `src/pages/CustomerDetail.tsx`.

---

### P2-8 — `SelectLocationsModal` is desktop-only by construction; tablet in the cab is unusable

**Business risk:** MEDIUM. The UI improvement plan has already flagged this as a Phase 4 mobile item, but it's worth pinning the structural reason here so Phase 2 scope doesn't accidentally lock it in.

**Evidence:**
- `src/components/field-app/SelectLocationsModal.tsx:139` hard-codes `w-1/2` for the map and `:158` for the table — the split is fixed, not responsive.
- The modal wrapper at `:136` is `fixed inset-0 z-50 flex items-stretch bg-black/50` with `m-4 rounded-xl shadow-2xl` — fine on a 27" monitor, awkward on a 10" tablet.
- The footer (`:262-275`) shows selected count and total acres, but the only Cancel/Select buttons are far from the table on a small screen.
- Click target: rows are clickable to toggle (`:230-244`) which is good for thumb-tapping, but the search input (`:172-181`) and the customer/crop filter selects (`:182-201`) are tiny.

**Fix direction:** Already covered by Phase 4 step 4.2 in the UI improvement plan. The Phase 2 owner should NOT introduce more `w-1/2` patterns into any new field-app screen until Phase 4 lands.

**Likely files:** `src/components/field-app/SelectLocationsModal.tsx` (Phase 4).

---

### P2-9 — `BlendTicketDetail.tsx` is 1688 lines and conflates seven distinct sub-jobs

**Business risk:** MEDIUM (maintenance, not user-facing). The page is one of the largest in the codebase and is the most-frequently-modified surface in field-app. Splitting it would make the next round of changes safer.

**Evidence:**
- `src/pages/BlendTicketDetail.tsx` is 1688 lines covering: header form, image carousel, OCR re-process, products list, blend math validator (calls `validateBlendMath`), structured field assignments (`blend_ticket_fields`), order-linkage modal + suggested-order banner, "Create Order from Ticket" modal, "Create Invoice from Ticket" affordance, "Create Application Record from Ticket" affordance, approve/reject, raw OCR text viewer.
- 11 distinct confirm-modal states are declared (`:75-86`), 6 distinct idempotency keys (`:34-39, :86`), 9 outbound RPC paths.
- Risk surface: any change to one of these flows (e.g., adding a field to the blend ticket header) requires re-reasoning about whether it interacts with any of the others.

**Fix direction:** Extract into 4 components: `BlendTicketHeader.tsx`, `BlendTicketProducts.tsx`, `BlendTicketFields.tsx`, `BlendTicketLinkage.tsx` (last one owns order/invoice/app-record creation). Page itself becomes orchestration only. Pure refactor — no behaviour change. Will pay for itself the next time Mason wants to add an OCR-able field.

**Likely files:** `src/pages/BlendTicketDetail.tsx` plus 4 new files in `src/components/blendtickets/`.

---

### P2-10 — Page title for `/jobs` reads "Job Management" but the page heading reads "Job Schedule"

**Business risk:** LOW (cosmetic), but indicative.

**Evidence:**
- `src/hooks/usePageMeta.ts:12` maps `/jobs` to `{ title: 'Job', accent: 'Management' }`.
- `src/pages/Jobs.tsx:308` renders `<SplitHeading title="Job" accent="Schedule" />`.
- Sidebar label is "Job Schedule" (`Sidebar.tsx`, "Job Schedule" / `CalendarClock`).

**Fix direction:** Pick one. The sidebar/header agreement says "Job Schedule"; update `usePageMeta.ts:12` to match.

**Likely files:** `src/hooks/usePageMeta.ts`.

---

### P2-11 — Manual `applicator_id` write in DispatchBoard skips the typed RPC path

**Business risk:** LOW (RLS does cover it) but worth noting because every other write in the field-app feature goes through a SECURITY DEFINER RPC with idempotency.

**Evidence:**
- `src/pages/DispatchBoard.tsx:136-157` does `supabase.from('jobs').update({ applicator_id, updated_at }).eq('id', jobId)` directly. There is no idempotency key, no `assertRpcResult`, and the auth gate added in `phase9.sql` does not apply.
- Compare to `save_job` (`JobDetail.tsx:353`) which goes through `supabase.rpc('save_job', { ... p_idempotency_key })`.

**Fix direction:** Add `assign_applicator(p_job_id, p_applicator_id, p_performed_by, p_idempotency_key)` SECURITY DEFINER RPC, mirror in DispatchBoard. Same shape as the existing `assign_driver` RPC for deliveries (if one exists; otherwise model on `save_job`).

**Likely files:** `supabase/migrations/<new>.sql`, `src/pages/DispatchBoard.tsx`.

---

### P2-12 — `JobDetail` has no breadcrumb back to the originating Quote section beyond a static blue banner

**Business risk:** LOW. A nice-to-have, not a bug.

**Evidence:**
- `src/pages/JobDetail.tsx:568-576` renders a "Created from Quote {quote_number}" banner with a button that navigates back. That's fine.
- The Breadcrumbs above (`:564-567`) say only `Jobs > {jobNumber}` — they don't include the parent customer. The same is true on `BlendTicketDetail.tsx:701-704` and `FieldApplicationInvoice.tsx:493-498`.
- The customer name appears nowhere in the JobDetail header until you scroll to the customer dropdown (`:637`) — for a sales rep working from a phone, "what farm is this job for?" is two scrolls down.

**Fix direction:** Add the customer name to the page heading on JobDetail, BlendTicketDetail, and FieldApplicationInvoice when the value exists. Possibly add it as a third breadcrumb.

**Likely files:** `src/pages/JobDetail.tsx`, `src/pages/BlendTicketDetail.tsx`, `src/pages/FieldApplicationInvoice.tsx`.

---

### P2-13 — Field-app invoice has no way to revisit the customer-share preview after a save

**Business risk:** LOW-MEDIUM. After save, the page's `previewData` is cleared (`:266`, `:313`) and the only way to see per-customer breakdown is to click Preview again. But Preview only works while editable — a posted invoice has no "Show me how this was split" view.

**Evidence:**
- `src/pages/FieldApplicationInvoice.tsx:316-358` — `handlePreview` calls `preview_field_app_invoice_split` and stashes the result in `previewData`.
- `:532-535` — Preview button is shown only when `canEdit` is true.
- `:566` — sibling banner shows the *invoices* in the group with their totals, but not the per-line breakdown that explains why each customer's number is what it is.
- Once posted, customer-share rows are read from `invoice_shares` (`:217-233`) which is the simplified "100% per-row-per-invoice" version, not the rich per-(field × customer) breakdown.

**Fix direction:** Always allow Preview on grouped/posted invoices in read-only mode. Either run the same RPC against the saved data, or persist the preview JSON to a `field_app_invoice_split_snapshot` column on save.

**Likely files:** `src/pages/FieldApplicationInvoice.tsx`, optionally `supabase/migrations/<new>.sql` for the snapshot column.

---

### P2-14 — Activity logging on field-app invoice deletes uses `entityType: 'invoice'`, but the page is the field-app surface — searching activity for "field_app" misses these

**Business risk:** LOW (data discoverability).

**Evidence:**
- `src/pages/FieldApplicationInvoice.tsx:476-481` writes `event: 'field_app_invoice_deleted'` (good — distinct event) but `entityType: 'invoice'` (not `'field_app_invoice'`).
- Compare with `BlendTicketDetail.tsx:374` which uses `entityType: 'blend_ticket'` consistently.

**Fix direction:** Either keep `'invoice'` (treating field-app invoices as a sub-type of invoice — defensible) but add a tag/extra field for sub-type, or introduce `'field_app_invoice'` and update activity-search filters. Pick one and apply consistently across all field-app activity events.

**Likely files:** `src/pages/FieldApplicationInvoice.tsx`, `src/lib/activityLogger.ts` (typed event tag list).

---

### P2-15 — `process-blend-ticket` Edge Function does not surface OCR errors back to the user

**Business risk:** LOW-MEDIUM. If OCR fails entirely (network blip, Vision API hiccup), the ticket sits in `pending` or `processing` forever and the user has no idea why.

**Evidence:**
- `supabase/functions/process-blend-ticket/index.ts:1051` carries an inline comment: "ticket stuck in pending/needs_review state until someone notices."
- Re-process exists (`BlendTicketDetail.tsx:432-450`) but only an admin/sales rep would know to click it.
- There is no "Failed OCR" filter chip on the BlendTickets list — `BlendTickets.tsx:521-571` has filter chips for "Needs Review", "Low Confidence", "Duplicates" but not "Stuck Processing".

**Fix direction:** Add a "Stuck > N hours in processing" filter chip on the BlendTickets list. Add an "OCR failed" status chip when `status='failed'`. Consider a pg_cron job (the codebase already uses these per `CHANGELOG.md`) that re-queues tickets stuck in `processing` for > 30 minutes.

**Likely files:** `src/pages/BlendTickets.tsx`, optionally `supabase/migrations/<new>.sql` for the cron.

---

## What's Already Working

These are correct and Mason should not let later phases regress them:

1. **Multi-customer field split → grouped invoices is end-to-end correct.** `derive_customer_shares_from_fields` + `save_field_app_invoice` + `post_invoice_group` produce one invoice per customer with consistent `invoice_group_id`. The sibling banner on `FieldApplicationInvoice.tsx:545-565` is a small, clear UI for it.
2. **Mode A (grower share, all-inclusive override) and Mode B (line-item) coexist on the same invoice.** Tested in the Phase 8 migration verification block.
3. **Posted-edit lock covers the whole group, not just one invoice.** `FieldApplicationInvoice.tsx:455-458` mirrors the server-side check.
4. **Server is the source of truth for pricing — chemical entry is preview only.** The italicised disclaimer in `FieldAppChemicalEntry.tsx:306-308` is honest with the user, and the `manual_override` flag is a clean way to record explicit overrides.
5. **OCR review UX is solid.** Per-product confidence badges, low-confidence/yellow callouts, "verify" status, raw OCR text viewer, re-process with confirm modal, batch approve/reject, suggested-order banner, duplicate ticket detection. This is genuinely good work.
6. **`blend_ticket_fields` structured table** is the right shape for multi-customer splits.
7. **Job lifecycle has correct state transitions and creates an application record on completion** (`complete_job` RPC creates an app record before deducting inventory — `JobDetail.tsx:419` toast confirms record number).
8. **Application Services pricing is per-acre with separate cost vs price** — supports margin reporting later.
9. **`recipe_id` linkage on jobs and `load_recipe_into_job` RPC** make recurring blends easy.
10. **Idempotency keys are everywhere they should be** in field-app — every mutating RPC the pages call has one. The one outlier is the direct `applicator_id` update in DispatchBoard (P2-11).
11. **Per-route ErrorBoundary** means a crash on, say, BlendTicketDetail does not nuke Dispatch Board — important since Mason runs both side-by-side.

---

## Open Questions for Mason

1. **What goes on the printed sprayer packet?** Confirm the contents:
   - Header (customer, job/invoice number, date, applicator name)
   - Fields with map thumbnails (polygon SVGs from `boundary_geojson`)
   - Chemical mix table with rate-per-acre, total quantity per chemical, EPA reg numbers, lot numbers if known
   - Tank loading instructions (gallons, loads needed — copy of the on-screen Loader Worksheet)
   - Spray conditions block (wind direction/speed, temperature, humidity — blank lines for the cab)
   - Signature block + date
   - Re-entry interval / restricted-entry warnings (from product label data?)
   Decide: one packet per Job, or one per Field-App Invoice, or both? Today the Job carries the operational data; the Invoice carries the billing data. The packet probably belongs on the Job.

2. **Should completing a Job auto-write to a Field-App Invoice instead of a regular Invoice for multi-customer fields?** Today `transfer_job_to_invoice` produces a single-customer invoice. If a job covers a field with two billing customers, the invoice is wrong.

3. **Is the OCR threshold something you actually tune?** If yes, P2-5 needs to land. If you've never moved it from 70, lower priority.

4. **Should the Dispatch Board show deliveries too, or are those two distinct workflows?** Drives whether P2-4 step 2 happens.

5. **Is `FieldDetail.tsx` actually orphaned?** Confirm the Phase 0 finding — if there's no plan to use it, delete it.

6. **Do applicators ever fill out an application record from scratch (no source job, no blend ticket)?** If yes, we need a `/application-records/new` route. If no, the list-only model is fine.

---

## Recommended Fix Order Within Phase 2

If Mason wants to ship Phase 2 in pieces, do them in this order — earliest items have highest pain reduction per hour of work:

1. **P2-1 — Persist Applied Info** (1-2 hours). Stop silently dropping wind/temperature/applicator. Either save them or hide the inputs.
2. **P2-5 — Read OCR thresholds from settings in the Edge Function** (1 hour). Tiny fix; removes a config-vs-reality drift.
3. **P2-6 — Delete `FieldDetail.tsx`** (15 min). Hygiene.
4. **P2-10 — Fix `usePageMeta` for `/jobs`** (5 min).
5. **P2-2 — Field-app print packet** (1-2 days). Highest user-visible value. Sign off Open Q #1 first.
6. **P2-3 — Pre-fill field-app invoice from approved blend ticket** (~1 day). Kills the worst of the re-entry pain.
7. **P2-7 — Application Record detail page + PDF** (1 day). Compliance.
8. **P2-13 — Always-available preview on saved/posted field-app invoices** (4 hours).
9. **P2-11 — Move `applicator_id` write through a typed RPC** (2 hours).
10. **P2-12 — Customer name in the page heading on Job/Blend/Field-App Invoice detail** (2 hours).
11. **P2-15 — "Stuck Processing" chip + cron** (3 hours).
12. **P2-14 — Activity event tag consistency** (1 hour).
13. **P2-9 — Refactor `BlendTicketDetail.tsx` into 4 components** (1 day, no behaviour change).
14. **P2-4 — Dispatch Board date range + delivery layer** (1-2 days). Wait until Open Q #4 is answered.
15. **P2-8 — Tablet `SelectLocationsModal`** — defer to Phase 4 per the existing UI plan.

Total Phase 2 work, bundled: roughly 6-8 working days, sequenced so the highest-impact items ship first and any one of them can be released independently.

---

*End of Phase 2.*
