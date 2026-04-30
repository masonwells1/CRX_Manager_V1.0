# Field Mapping + Sprayer Application Map Upgrade Plan

Date: 2026-04-29  
Status: Planning only. No app code or migrations were changed in this pass.  
Audience: Mason Wells and implementation agents.

## Business Summary

The field application workflow is close to supporting the right business process, but the sprayer/operator side is not ready yet.

The highest-value improvement is to make the selected fields obvious on a map and then turn that map into a clean sprayer packet. The operator should be able to answer five questions without calling the office:

1. Which fields do I spray?
2. What number is each field on the map?
3. How many acres are being sprayed?
4. What mix/rate/product am I applying?
5. What copy should be printed for the sprayer versus the office/customer?

This should be built in phases. The first phase can be mostly user-interface work. Later phases may need new database fields for weather, applicator, equipment, gates, hazards, sensitive areas, and mobile/share-link features.

## Current State Summary

### Field Picker Map

- `src/components/field-app/SelectLocationsModal.tsx` already has a map inside the field picker.
- The picker filters fields by owner/customer, search text, and crop.
- The table supports selecting fields and assigning applied acres.
- The map currently receives only `selectedFields`, so it only shows selected fields instead of all filtered fields.
- `src/components/map/FieldBoundaryLayer.tsx` already has click handling support through `onFieldClick`, but the field application picker does not use it yet.
- `FieldBoundaryLayer` currently draws all included field boundaries with one visual style. It does not yet support selected versus unselected styling.
- Map labels currently use the field name. The sprayer workflow needs stable map numbers that match the printed field list.
- The field picker row and checkbox both toggle the same selection. The checkbox can bubble its click up to the row, which creates a double-toggle risk.

### Field Application Page

- `src/pages/FieldApplicationInvoice.tsx` already supports a field application invoice builder with fields, products, customer shares, applied info, preview, save, post, and a print button.
- The current print button is still a placeholder.
- The current server-side workflow is moving in the right direction: preview and save RPCs keep billing math in PostgreSQL instead of the browser.
- `CustomerSharesTable` already accepts preview data and can display the server-calculated split preview.
- `FieldAppChemicalEntry` already accepts `primaryCustomerTier` and can show the customer tier used for pricing context.
- The page still needs workflow polish so Preview, Save, Post, and Print feel like one guided office process instead of separate technical actions.

### Print/PDF

- `src/lib/invoicePdf.ts` already has a field application invoice layout.
- Existing invoice PDFs support product lines, EPA number display when selected, price-per-acre display when selected, and customer share display.
- `src/components/invoices/InvoicePrintDialog.tsx` currently has generic invoice options only:
  - show customer shares
  - show price per acre
  - show EPA registration
- There is no sprayer/operator print packet yet.
- Existing PDF generation does not include a large application map, numbered field boundaries, a field list by map number, a loader/tank worksheet, or an operator copy that intentionally hides prices.

### Database And Data

- `supabase/migrations/20260406100000_field_app_workflow_v2.sql` introduced the field application invoice workflow tables and RPCs.
- `supabase/migrations/20260429140635_field_app_workflow_phase1.sql` appears to extend this workflow with grouped invoices, application service fees, preview RPC support, customer-share derivation, and posting grouped invoices.
- Existing `field_app_locations` data includes useful print fields such as field, map number, acres, crop, wind direction, and sort order.
- Existing types also show related application record concepts like applicator, vehicle, weather conditions, and notes, but the current field application page does not appear to persist a complete compliance-ready application record yet.

## Gap List Ranked By Business Value

| Rank | Gap | Business Impact | Recommended Direction |
| --- | --- | --- | --- |
| 1 | Field picker map shows only selected fields | The office cannot visually choose from all candidate fields, which increases the chance of missing or selecting the wrong field. | Show all filtered fields on the map, highlight selected ones, and allow map click to select/deselect. |
| 2 | No real sprayer print packet | The operator does not get a field-by-field map packet with mix, acres, and application instructions. | Add a dedicated field application print flow, separate from generic invoice printing. |
| 3 | No price-hiding operator copy | A sprayer copy may expose customer pricing when the operator only needs application instructions. | Add copy type and print options that can hide dollars by default. |
| 4 | Map numbers are not a first-class print concept | The map and field list can drift or become confusing if numbers are not stable and visible. | Persist and display map numbers consistently from field picker through print. |
| 5 | Page workflow still feels technical | Office users may not know when they should preview, save, post, or print. | Make the action flow obvious and block unsafe steps when data is stale. |
| 6 | Weather, applicator, equipment, and notes are incomplete | Compliance records and operator instructions may be missing important application details. | Decide which fields belong on the invoice, field application locations, job applied info, or a dedicated application record. |
| 7 | No loader worksheet | The person mixing the tank still has to calculate loads and per-load product amounts manually. | Add a later worksheet phase after the base print packet is correct. |
| 8 | No mobile/share view | Operators may need map access from a phone or tablet instead of paper. | Evaluate a secure share link or QR code after print is stable. |
| 9 | No gate, hazard, sensitive-area support | Operators may miss important field instructions that are not captured in the current field record. | Plan new data model only after Mason chooses which field notes matter operationally. |

## Recommended Phases

### Phase 1 - Fix The Field Picker Map

Business outcome: the office user can confidently select the right fields from a complete map.

Likely files touched:

- `src/components/field-app/SelectLocationsModal.tsx`
- `src/components/map/FieldBoundaryLayer.tsx`
- `src/components/map/CRXMap.tsx` only if map behavior or fitting needs a small shared helper
- Focused test file near the picker if one already exists, or a new focused component test

Recommended work:

- Pass all filtered fields to the map, not only selected fields.
- Pass selected field IDs into the map layer.
- Add selected and unselected boundary styling:
  - selected fields: stronger fill, thicker outline, high contrast
  - unselected fields: lighter fill, thinner outline
- Use the existing `onFieldClick` support in `FieldBoundaryLayer` to toggle field selection from the map.
- Stop checkbox clicks from bubbling to the table row so one user click toggles selection exactly once.
- Fix "select all" logic so it checks whether all visible filtered fields are selected, not whether total selected count equals filtered count.
- Show map numbers for selected fields in a stable way.
- Keep field numbers stable when filters change, when the modal is reopened, and when the user saves.
- Preserve the existing table workflow for users who prefer selecting by list.

Database migration expected: no.

### Phase 2 - Define The Sprayer Packet Data Model And Read Path

Business outcome: printing uses one trustworthy saved record instead of rebuilding instructions from temporary browser state.

Likely files touched:

- `src/types/index.ts`
- `src/lib/db.ts` usage sites only if new typed helpers are needed
- `src/pages/FieldApplicationInvoice.tsx`
- Possibly a new read-only RPC migration if saved packet data is too hard to assemble safely from existing tables
- Docs references if a new RPC or schema field is added

Recommended work:

- Decide the saved source for each print field:
  - field name
  - map number
  - customer/grower
  - crop
  - total acres
  - applied acres
  - application service
  - equipment
  - applicator
  - application date
  - weather/wind
  - notes
  - products, rates, units, EPA numbers
- Prefer a single read model for print packet generation. This can be a typed client query if simple, or a read-only RPC if grouping and shares make the query complex.
- Keep billing totals server-authoritative. The browser may format and print data, but it should not calculate final billable totals.
- Make grouped field application invoices print as one coherent packet for the whole application group.

Database migration expected: maybe. If needed, create a new migration only. Do not edit old migrations.

### Phase 3 - Build The Sprayer Application Print Flow

Business outcome: the office can print the right packet for the right audience.

Likely files touched:

- `src/components/invoices/InvoicePrintDialog.tsx` or a new field-app-specific print dialog
- `src/lib/invoicePdf.ts` for shared helpers only
- New likely file: `src/lib/fieldAppPrintPacketPdf.ts`
- `src/pages/FieldApplicationInvoice.tsx`
- `src/pages/InvoiceDetail.tsx` if existing saved field application invoices need the same print packet
- `src/components/map/CRXMap.tsx`
- `src/components/map/FieldBoundaryLayer.tsx`

Recommended work:

- Add a field application print dialog with these options:
  - Map only
  - Map plus field list
  - Include mix/product details
  - Include EPA/regulatory details
  - Include customer/grower names
  - Hide prices for sprayer/operator copy
  - Office/customer copy can include dollars when appropriate
  - Include loader/tank worksheet when available
- Make operator copy hide money by default.
- Make office copy allow money by permission and context.
- Generate a large map page with numbered field boundaries.
- Add a matching field list by map number.
- Add mix/product details with product name, EPA number, rate per acre, total applied, and unit.
- Include application service/equipment, applicator, date, notes, and wind/weather when available.
- Reuse the existing jsPDF and invoice PDF style where possible, but keep the sprayer packet separate enough that invoice printing does not become fragile.
- Capture the map in a print-friendly way using the existing Mapbox/CRXMap foundation. If direct map canvas capture is unreliable, build a dedicated print map render path and verify it in browser before generating the PDF.

Database migration expected: no for the first packet if current saved data is enough. Maybe later if missing weather/applicator/equipment fields need persistence.

### Phase 4 - Polish The Field Application Page Workflow

Business outcome: a non-technical office user can build, verify, save, print, and post the field application without guessing.

Likely files touched:

- `src/pages/FieldApplicationInvoice.tsx`
- `src/components/field-app/CustomerSharesTable.tsx`
- `src/components/field-app/FieldAppChemicalEntry.tsx`
- `src/components/field-app/ApplicationServicePicker.tsx`
- Any focused tests for the field application page

Recommended work:

- Keep `CustomerSharesTable` wired to server preview data.
- Keep `FieldAppChemicalEntry` wired to the primary customer tier.
- Make the button flow clear:
  - Preview calculates server totals and share breakdowns.
  - Save persists the current draft.
  - Print uses the latest saved packet or clearly warns if the page has unsaved changes.
  - Post locks the final invoice/group after the user has reviewed the preview.
- Show the current workflow state in plain language:
  - "Needs preview"
  - "Ready to save"
  - "Saved draft"
  - "Ready to print"
  - "Posted"
- Use server preview totals when available instead of relying only on browser-estimated totals.
- Keep the page focused on office workflow, not implementation details.

Database migration expected: no unless newly captured application fields need persistence.

### Phase 5 - Add Loader Worksheet And Mobile-Friendly Operator View

Business outcome: the mixing/loading process becomes repeatable and less error-prone.

Likely files touched:

- New or existing field application print packet PDF file
- `src/pages/FieldApplicationInvoice.tsx`
- Application service/equipment data files or RPCs
- Possibly a mobile route if Mason approves share-link work

Recommended work:

- Loader worksheet inputs:
  - tank size
  - spray rate, such as gallons per acre
  - total applied acres
  - calculated load count
  - acres per load
  - product amount per load
  - final partial load amount
- Use equipment tank capacity from the selected vehicle when available.
- Allow manual override for real-world equipment differences.
- Evaluate an applicator/mobile-friendly read-only view after the print packet is stable.
- Evaluate QR code/share link to open the packet map on a phone.

Database migration expected: likely for durable worksheet settings or share links.

### Phase 6 - Compliance-Ready Application Record

Business outcome: CRX can produce a stronger application record, not just a billing document.

Likely files touched:

- New migration files under `supabase/migrations/`
- `src/types/index.ts`
- Field application page and print packet files
- Docs references for schema/RPC changes

Recommended work:

- Decide whether the compliance record belongs to existing `application_records`, `job_applied_info`, `field_app_locations`, or a new field application record table.
- Capture or connect:
  - applicator
  - equipment
  - application date/time
  - wind speed
  - wind direction
  - temperature
  - humidity
  - weather notes
  - field-specific notes
  - gates/entrances
  - hazards
  - sensitive areas
  - product regulatory details
- Add RLS policies for any new tables.
- Add idempotency keys for any mutating RPCs.
- Keep `SECURITY DEFINER` functions locked to `SET search_path = public, pg_temp`.

Database migration expected: yes, if Mason approves compliance/mobile/field-note features.

## Print Packet Design

### Recommended Print Modes

1. Sprayer/operator copy
   - Default: hide all prices and dollar totals.
   - Include: map, field list, acres, mix, rates, EPA details if selected, applicator notes, weather/wind when available.
   - Purpose: tell the operator what to spray and how.

2. Office copy
   - Default: include the operational packet plus internal billing context if the user has permission.
   - Include: prices and totals only when appropriate.
   - Purpose: filing, review, and office confirmation.

3. Customer copy
   - Default: show customer-facing product and application details.
   - Include: dollars only according to current invoice/customer rules.
   - Purpose: customer record and invoice support.

### Recommended Packet Sections

1. Cover/header
   - Customer or invoice group name
   - Field application invoice/job number
   - Application date
   - Applicator
   - Application service/equipment
   - Total applied acres
   - Notes

2. Large map
   - Numbered field boundaries
   - Clear selected-field styling
   - Optional basemap roads/satellite setting
   - North/up orientation and enough zoom to see all selected fields

3. Field list by map number
   - Map number
   - Field name
   - Customer/grower
   - Crop
   - Total acres
   - Applied acres
   - Optional per-field notes

4. Mix/product details
   - Product name
   - EPA number when selected
   - Rate per acre
   - Total applied
   - Unit
   - Optional regulatory details if available

5. Weather and application conditions
   - Wind direction
   - Wind speed if available
   - Temperature if available
   - Humidity if available
   - Weather notes if available

6. Loader/tank worksheet
   - Tank capacity
   - Spray rate
   - Total acres
   - Number of loads
   - Product per load
   - Final partial load

### Map Rendering Recommendation

Use the existing `CRXMap` and `FieldBoundaryLayer` foundation. Add the minimum map-layer improvements needed for selected styling and numbered labels. For PDF output, create a controlled print map rendering path that can be captured into an image and inserted into jsPDF.

The implementation should verify that the map image is not blank before building the PDF. Map rendering is asynchronous, so the print flow should wait until Mapbox has finished drawing.

## Data And Schema Questions

Mason should decide these before database work starts:

1. Should the printed "customer/grower" be the field owner, the billing customer, the grower share customer, or all customers attached to that field?
2. Should an operator copy ever show customer names, or should some operator copies hide customer names and show only field names/map numbers?
3. Should the application packet print from a draft, or only after the draft has been saved?
4. Should printing be allowed after posting only, or should draft packets be allowed for pre-application review?
5. Who is the applicator: a typed name, a user account, an employee record, or a vendor/contact?
6. Which equipment should print: selected application service, vehicle, implement, sprayer, or all related equipment?
7. Which weather fields are required for CRX's real compliance needs?
8. Does CRX need REI, PHI, restricted-use pesticide flag, signal word, or other label details beyond EPA number?
9. Should field gates, entrances, hazards, and sensitive areas be stored per field, per application, or both?
10. Should temporary locations be printable but not saved as permanent fields?
11. Should QR/share links be public with a hard-to-guess token, login-only, or disabled until operator accounts exist?
12. Should loader worksheet math be saved for audit history, or recalculated each time from saved acres/products/equipment?

## Acceptance Criteria

### Phase 1 Acceptance Criteria

- The field picker map shows all fields matching the current filter.
- Selected fields are visually obvious on the map.
- Clicking a field boundary on the map selects or deselects that field.
- Clicking a checkbox toggles that field once, not twice.
- Clicking a row toggles that field once.
- The select-all checkbox correctly reflects only the currently filtered/visible fields.
- Selected map numbers stay stable while filtering and saving.
- Map labels are visible enough for office users and print planning.
- No billing math is moved into React.

### Print Packet Acceptance Criteria

- Field application invoices have a real Print action.
- The print dialog offers:
  - Map only
  - Map plus field list
  - Include mix/product details
  - Include EPA/regulatory details
  - Include customer/grower names
  - Hide prices for sprayer/operator copy
  - Office/customer copy with dollars when appropriate
- Operator copy does not show prices, dollar totals, or hidden billing columns.
- The map page shows numbered field boundaries.
- The field list matches the map numbers exactly.
- The packet includes field name, customer/grower when selected, crop, total acres, and applied acres.
- The packet includes application service/equipment when selected.
- The packet includes applicator, date, notes, wind, and weather when available.
- Mix/product rows include product name, EPA number when selected, rate per acre, total applied, and unit.
- Grouped field application invoices print as one coherent packet.
- Existing normal invoice printing still works.

### Page Polish Acceptance Criteria

- Preview, Save, Post, and Print read as one clear workflow.
- The user can tell whether totals are estimated, previewed, saved, or posted.
- Customer share preview data appears in the customer table after Preview.
- Product entry shows the relevant primary customer tier when available.
- Print is disabled or clearly warns when the packet would not match unsaved page changes.
- Posted records cannot be changed through the draft workflow.

## Test Plan

### Manual Tests

1. Open a field application invoice draft.
2. Open the field picker.
3. Filter by customer, crop, and search text.
4. Confirm the map still shows all filtered fields.
5. Select and deselect fields from the table.
6. Select and deselect fields from the map.
7. Confirm checkbox clicks toggle exactly once.
8. Confirm selected fields keep their map numbers after filters change.
9. Preview customer shares.
10. Save the draft.
11. Print operator copy with prices hidden.
12. Print office copy with money shown when appropriate.
13. Confirm the printed field list matches the map numbers.
14. Confirm grouped invoices print one packet for the group.
15. Confirm existing non-field-application invoice printing still works.

### Automated Tests

- Component test for `SelectLocationsModal` selection behavior.
- Component test for checkbox click not double-toggling.
- Component test for select-all behavior with filters.
- Unit test for print option mapping, especially hiding prices on operator copy.
- Unit test for field packet data transformation from saved invoice/group data.
- PDF smoke test that verifies a generated operator packet contains no dollar signs when prices are hidden.
- PDF smoke test that verifies EPA numbers appear only when enabled.
- E2E test for office workflow: choose fields, preview, save, print.

### Checks To Run During Implementation

- `npm run typecheck`
- Focused unit tests for changed components
- Focused E2E test for the field application flow
- `npm run build`

Run broader tests if database/RPC behavior changes.

## Specific Files Likely Touched By Phase

| Phase | Likely Files |
| --- | --- |
| Phase 1 - picker map | `src/components/field-app/SelectLocationsModal.tsx`, `src/components/map/FieldBoundaryLayer.tsx`, possibly `src/components/map/CRXMap.tsx` |
| Phase 2 - print data | `src/types/index.ts`, `src/pages/FieldApplicationInvoice.tsx`, possible new migration for read-only packet data if needed |
| Phase 3 - print packet | `src/components/invoices/InvoicePrintDialog.tsx` or a new field-app print dialog, `src/lib/fieldAppPrintPacketPdf.ts`, `src/lib/invoicePdf.ts`, `src/pages/InvoiceDetail.tsx`, `src/pages/FieldApplicationInvoice.tsx` |
| Phase 4 - page polish | `src/pages/FieldApplicationInvoice.tsx`, `src/components/field-app/CustomerSharesTable.tsx`, `src/components/field-app/FieldAppChemicalEntry.tsx`, `src/components/field-app/ApplicationServicePicker.tsx` |
| Phase 5 - loader/mobile | Print packet files, application service/equipment files, possible mobile/share route |
| Phase 6 - compliance record | New migration files, `src/types/index.ts`, field application page, print packet, docs reference files |

## Mason Decision Points

Before coding starts, Mason should decide:

1. Should Phase 1 and Phase 3 be separate releases, or should the picker map and print packet ship together?
2. Should operator copies hide customer names by default, or only hide prices?
3. Should the first print packet require a saved draft, or allow printing from unsaved page state?
4. Should the office copy include prices by default?
5. Which weather fields are required on the first print version?
6. Is a loader worksheet required for the first release, or can it be Phase 2 after the basic packet works?
7. Should QR/mobile map access wait until operator security is designed?
8. Should temporary locations be part of this project, or a separate project after permanent field maps are reliable?

## Implementation Notes For The Next Agent

- Start with Phase 1. It is the fastest path to reduce field-selection mistakes.
- Do not edit old migrations.
- If database work becomes necessary, create a new migration and update reference docs.
- Reuse existing `CRXMap`, `FieldBoundaryLayer`, and jsPDF invoice patterns where possible.
- Keep billing calculations in Supabase RPCs and saved invoice data.
- Treat sprayer/operator print as an operational packet, not just another invoice layout.
- Preserve unrelated uncommitted changes in the repo.
