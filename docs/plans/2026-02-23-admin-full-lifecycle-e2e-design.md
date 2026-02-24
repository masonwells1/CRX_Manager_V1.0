# Admin Full-Lifecycle E2E Test Design

> **Date:** 2026-02-23
> **Purpose:** Pre-launch gate test — verifies the complete admin workflow from quote creation through delivery, return, inventory tracking, and team board communication.

## Architecture

- **File:** `tests/e2e/workflow-admin-full-lifecycle.spec.ts`
- **Runner:** Playwright with `test.describe.serial()` — tests run sequentially, each depending on the previous
- **Data strategy:** Hybrid — uses existing customers & products, creates fresh quotes/orders/deliveries/returns
- **Auth:** Admin login (`mason@croprxsolutions.com` via `E2E_TEST_EMAIL`)
- **Viewport:** 1280x720

## Three Test Suites

### Suite 1: Quote-to-Return Lifecycle (15 tests)

| # | Test | Action | Verification |
|---|------|--------|-------------|
| T1 | Create new quote | `/quotes/new` → select customer, add 2 products, save draft | Q-XXXX number captured, status=Draft |
| T2 | Send quote | Click "Send Quote", confirm | Status=Sent |
| T3 | Convert to order | Click "Convert to Order", confirm | Redirect to `/orders/:id`, ORD-XXXX captured |
| T4 | Verify order detail | Check line items | 2 items match quote products |
| T5 | Snapshot inventory before | `/inventory` → capture qty_available for both products | Baseline recorded |
| T6 | Schedule partial delivery | From order → "Create Delivery", half qty product 1, full qty product 2 | DEL-XXXX, status=Scheduled |
| T7 | Start delivery | "Start Delivery" → confirm modal | Status=In Progress |
| T8 | Complete delivery | Signature + "Complete Delivery" | Status=Completed, remainder rows for product 1 |
| T9 | Verify inventory after | `/inventory` → check deductions | Product 1 down by half, product 2 fully deducted |
| T10 | Verify invoice created | `/invoices` → find order's invoice | Invoice visible, correct amount |
| T11 | Post invoice | "Post Invoice" on detail | Status=Posted |
| T12 | Complete remainder delivery | Create follow-up from remainder, start + complete | Second delivery done, order=100% fulfilled |
| T13 | Verify final inventory | Product 1 fully deducted | Total matches original order qty |
| T14 | Create partial return | `/returns` → new return, partial qty product 1, reason=Overstock | RMA-XXXX, status=Requested |
| T15 | Approve + receive return | Approve, then receive (restocks inventory) | Status=Received, inventory increased |

### Suite 2: Inventory Operations (5 tests)

| # | Test | Verification |
|---|------|-------------|
| I1 | Manual inventory add | "Add Inventory" modal → new row appears |
| I2 | Inventory adjust | "Adjust" modal → quantity changes |
| I3 | Low stock indicator | Warning appears when qty < reorder point |
| I4 | Inventory holds | Create hold → row visible → release hold → row gone |
| I5 | Delivered YTD | Column shows non-zero after deliveries |

### Suite 3: Team Board Communication (5 tests)

| # | Test | Verification |
|---|------|-------------|
| B1 | Create announcement | Card in Announcements column |
| B2 | Create assigned todo | Card in To-Do with assignee + due date |
| B3 | Add comment | Comment thread visible on note |
| B4 | Complete todo | Card marked completed |
| B5 | Activity feed | Recent actions visible in Activity tab |

## Data Requirements

**Pre-existing (stable):**
- 1+ customer with address
- 2+ active products with inventory records
- Admin account credentials in `.env`

**Created by test:**
- 1 quote → 1 order → 2 deliveries → 1 invoice → 1 return
- 1 inventory hold (created + released)
- 2 team notes + 1 comment

## Out of Scope

- Payment allocation (existing tests)
- Driver role (existing tests)
- Batch operations (separate concern)
- PDF generation (unit tested)
- OCR uploads (external API)
