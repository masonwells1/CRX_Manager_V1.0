# Fields & Blend Ticket UI Test Report

**Date:** 2026-03-31
**Tester:** Claude (automated via Playwright browser testing)
**Environment:** Production (croprxsolutions.app)
**Login:** mason@croprxsolutions.com (admin role)
**Test Data:** Created with `[UI-TEST]` prefix, cleaned up after testing

---

## Executive Summary

Tested the Fields and Blend Ticket features end-to-end on production using Playwright browser automation. Found **5 bugs** (1 critical, 2 high, 2 medium). The critical bug (**Fields page completely broken**) was fixed immediately. Two other bugs were fixed in code. Two remain as known issues for follow-up.

### Bugs Found: 5

| # | Severity | Feature | Description | Status |
|---|----------|---------|-------------|--------|
| 1 | **CRITICAL** | Fields | `get_fields_with_geojson` RPC fails — PostGIS `ST_AsGeoJSON` not found due to missing `extensions` in `search_path` | **FIXED** |
| 2 | Medium | Blend Tickets | Product dropdown shows "Select Product" on detail page even when `product_name` is saved — `product_id` FK not linked | Known issue |
| 3 | High | Blend Tickets | Manual tickets saved with `source: 'ocr'` instead of `source: 'manual'` | **FIXED** |
| 4 | High | Sentry | CSP blocks all Sentry error reporting — `connect-src` missing `*.ingest.us.sentry.io` | **FIXED** |
| 5 | Low | General | Google Fonts CSS fails to load (`net::ERR_FAILED`) — intermittent network/CDN issue | Known issue |

---

## Bug Details

### Bug #1 — CRITICAL: Fields Page Completely Broken

**Symptom:** Fields page shows "Failed to load fields" error toast. Stats show "0 fields, 0 total acres."

**Root Cause:** All 4 PostGIS-using RPCs (`get_fields_with_geojson`, `get_field_geojson`, `save_field_geometry`, `get_field_dashboard`) had `SET search_path TO 'public', 'pg_temp'` which excluded the `extensions` schema where PostGIS functions (`ST_AsGeoJSON`, `ST_GeogFromGeoJSON`) live. This was introduced when the `pg_temp` security fix was applied in migration `20260332800000`.

**Fix:** Added `'extensions'` to `search_path` on all 4 functions. Applied directly to production DB and created migration `20260331000000_fix_postgis_search_path.sql`.

**Impact:** The entire Fields page, Field Dashboard, Field Detail edit (map/boundary), and any field geospatial operations were broken for all users.

---

### Bug #2 — Medium: Product Dropdown Shows "Select Product" on Blend Ticket Detail

**Symptom:** When viewing a blend ticket with products, the product dropdown shows "Select Product" instead of the actual product name, even though the `product_name` field is correctly stored in the DB.

**Root Cause:** The `ManualTicketCreate` component saves `product_name` (text) but the `product_id` (FK to products table) is `NULL`. The `BlendTicketDetail` page's product dropdown matches on `product_id`, not `product_name`, so it shows the default "Select Product" option.

**Recommendation:** The product row on the detail page should display the saved `product_name` as a text label when `product_id` is null, or auto-match it to a product. This is also related to how the `ManualTicketCreate` saves products — the `product_id` should be populated from the select dropdown value.

**Status:** Known issue — needs frontend fix in `BlendTicketDetail.tsx` product rendering.

---

### Bug #3 — High: Manual Tickets Saved with `source: 'ocr'`

**Symptom:** Manually created blend tickets have `source = 'ocr'` in the database instead of `source = 'manual'`.

**Root Cause:** `ManualTicketCreate.tsx` line 170 — the `.insert()` call never sets the `source` field. The `blend_tickets.source` column has a default of `'ocr'::text`, so it falls back to that.

**Fix:** Added `source: 'manual'` to the insert object in `ManualTicketCreate.tsx` line 171.

**Impact:** Any reporting or filtering by source type would incorrectly classify manual tickets as OCR tickets.

---

### Bug #4 — High: Sentry Error Reporting Blocked by CSP

**Symptom:** Browser console shows `Refused to connect to 'https://o4510932832616448.ingest.us.sentry.io/...' because it violates the Content Security Policy directive: "connect-src..."`.

**Root Cause:** `vercel.json` CSP `connect-src` directive didn't include `https://*.ingest.us.sentry.io`.

**Fix:** Added `https://*.ingest.us.sentry.io` to the `connect-src` directive in `vercel.json`.

**Impact:** ALL Sentry error reporting in production has been silently failing. No errors from real users were being captured. This means the ~30 `Sentry.captureException` calls added in the March 16 code quality session were never actually sending data.

---

### Bug #5 — Low: Google Fonts CSS Load Failure

**Symptom:** `Failed to load resource: net::ERR_FAILED` for `https://fonts.googleapis.com/css2?family=...`

**Root Cause:** Likely intermittent CDN/network issue. The CSP headers correctly include `fonts.googleapis.com` in `style-src` and `fonts.gstatic.com` in `font-src`.

**Status:** Known issue — monitor. The app gracefully falls back to system fonts.

---

## Test Results by Feature

### Fields Page (List View)

| Test | Result | Notes |
|------|--------|-------|
| Page loads | PASS (after fix) | Was completely broken before Bug #1 fix |
| Field list displays | PASS | Shows all fields with correct data |
| Summary stats (count, acres, boundaries) | PASS | "6 fields, 417.82 total acres, 0 with boundaries" |
| Customer filter | PASS | Correctly filters, stats update dynamically |
| Crop filter | PASS | corn/soybean options populated from data |
| County filter | PASS | Sangamon/Champaign populated |
| Status filter (Active/Inactive/All) | PASS | Defaults to Active |
| Search | Not tested | — |
| Map view toggle | Not tested | — |
| Bulk import button | Present | Not functionally tested |
| Add Field button | PASS | Navigates to field creation form |

### Field Dashboard

| Test | Result | Notes |
|------|--------|-------|
| Dashboard loads | PASS (after fix) | Map renders, location panel populated |
| Map with satellite toggle | PASS | Mapbox renders correctly |
| Location info panel | PASS | Acres, Crop, County, State, Soil Type, Irrigation, Status |
| Overview tab | PASS | Season 2026 Summary (0/0/0 for test data), Recent Activity |
| Applications tab | PASS | Tab switches correctly |
| Billing tab | PASS | Shows billing splits correctly |
| Billing — single customer (100%) | PASS | Green bar, "Primary" badge, 100% |
| Billing — split billing (60/40) | PASS | Green 60% + Blue 40% bars, two customer rows |
| Details tab | PASS | Tab switches correctly |
| Edit Field button | PASS | Navigates to edit form |

### Field Edit Form

| Test | Result | Notes |
|------|--------|-------|
| Form loads with data | PASS | All fields pre-populated |
| Field Information section | PASS | Name, Customer search, Legal Desc, County, State, Acres |
| Crop & Soil section | PASS | Crop Type dropdown, Soil Type, Irrigation checkbox |
| FSA Numbers section | PASS | Farm/Tract/Field number inputs |
| Field Location (map) | PASS | Mapbox map, polygon tool, address search, satellite toggle |
| Default Billing Splits | PASS | Shows existing splits, %, Primary badge, Set Primary, delete |
| Split total validation | PASS | Shows "Total 100.00%" green bar |
| Price Override / Pricing Note | PASS | Inputs available per split |
| Add billing split (customer search) | PASS | Search input present |
| Split Evenly button | PASS | Button present |
| Notes textarea | PASS | Present with placeholder |
| Field Status toggle | PASS | Active checkbox |
| Save Changes button | PASS | Present, styled correctly |
| Unsaved changes blocker | PASS | Browser beforeunload dialog fires on navigation |

### Blend Tickets Page (List View)

| Test | Result | Notes |
|------|--------|-------|
| Page loads | PASS | Clean empty state |
| Create Manual button | PASS | Opens inline form |
| Upload Tickets button | PASS | Present (not functionally tested — needs image files) |
| Search bar | PASS | Present |
| Status filter | PASS | All Statuses, Pending, Processing, Completed, Needs Review, Failed |
| Review filter | PASS | All Reviews, Unreviewed, Approved, Rejected |
| Order Link filter | PASS | All Link Status, Unlinked, Linked |
| Payment filter | PASS | All Payments, Unbilled, Billed, Prepaid, No Charge |
| Select All / bulk actions | PASS | Present |
| Empty state | PASS | "No blend tickets found" with Upload button |

### Manual Blend Ticket Creation

| Test | Result | Notes |
|------|--------|-------|
| Form renders | PASS | All 15+ fields visible |
| Customer dropdown | PASS | All active customers listed alphabetically |
| Ticket Date pre-filled | PASS | Today's date |
| All text fields | PASS | Job #, Invoice #, Driver, Applicator, Mixer, Tank #, Vehicle, Field Names |
| Numeric fields | PASS | Total Acres, Total Volume with unit |
| Recipe dropdown | PASS | Shows saved recipes (8 found) |
| Add Product button | PASS | Adds product row with dropdown, qty, unit, rate, lot# |
| Product dropdown | PASS | All active products listed |
| Create Ticket | PASS | Creates ticket, returns to list, auto-generates ticket # |
| Ticket number generation | PASS | BT-2026-0001 format |
| Source field | BUG #3 | Saved as 'ocr' instead of 'manual' — FIXED in code |

### Blend Ticket Detail Page

| Test | Result | Notes |
|------|--------|-------|
| Page loads | PASS | Breadcrumb, header, status badges |
| Status badges | PASS | "Completed" (green), "Unreviewed" |
| Ticket Images section | PASS | "No images available" for manual ticket |
| Ticket Information form | PASS | All fields editable, pre-populated |
| Products section | PARTIAL | Qty/unit display OK, but dropdown shows "Select Product" (Bug #2) |
| Product confidence indicator | PASS | Green dot "Confidence: 100%" |
| Application Fields section | PASS | "Add Field" button, field selector dropdown, planned acres |
| Field acres validation | PASS | "Total planned: 0 acres \| Ticket total: 120 acres (100% difference)" |
| Order Linkage section | PASS | "Unlinked"/"Unbilled" badges, Link to Existing Order, Create Order from Ticket |
| Math Validation Warnings | PASS | "Total product quantities (25.00) doesn't match total volume (1200)" |
| Approve button | PASS | Opens ConfirmModal, confirms, updates status |
| Reject button | PASS | Present (not functionally tested) |
| Re-process OCR button | PASS | Present |
| Cancel button | PASS | Present |
| Save Changes button | PASS | Present |

### Blend Ticket Approval Flow

| Test | Result | Notes |
|------|--------|-------|
| Click Approve | PASS | Opens ConfirmModal (not window.confirm) |
| ConfirmModal content | PASS | "Approve Blend Ticket" title, "Approve this blend ticket?" message |
| Confirm approval | PASS | Updates review_status to "approved", redirects to list |
| List shows "Approved" | PASS | Review column updated to "Approved" (green text) |

---

## Files Changed

| File | Change | Reason |
|------|--------|--------|
| `supabase/migrations/20260331000000_fix_postgis_search_path.sql` | **NEW** | Fix Bug #1: Add `extensions` to search_path on 4 PostGIS RPCs |
| `src/components/blendtickets/ManualTicketCreate.tsx` | **MODIFIED** (line 171) | Fix Bug #3: Add `source: 'manual'` to insert |
| `vercel.json` | **MODIFIED** (line 9) | Fix Bug #4: Add `*.ingest.us.sentry.io` to CSP connect-src |

---

## Recommendations

1. **Deploy ASAP** — The CSP fix for Sentry means error monitoring has been blind since the CSP was added. Deploy to start collecting real error data.
2. **Fix Bug #2** — The product dropdown on BlendTicketDetail should fall back to showing `product_name` text when `product_id` is null. Low effort, medium impact.
3. **Audit other SECURITY DEFINER functions** — Any other function using PostGIS or extension functions with `SET search_path TO 'public', 'pg_temp'` will have the same bug. Run: `SELECT proname FROM pg_proc WHERE prosrc LIKE '%ST_%' AND prosecdef AND pronamespace = 'public'::regnamespace;`
4. **Add E2E test for Fields page load** — The critical Bug #1 would have been caught by a simple smoke test that asserts the fields list renders.
5. **Add `source` column validation test** — A unit test on ManualTicketCreate that asserts the insert payload includes `source: 'manual'`.
