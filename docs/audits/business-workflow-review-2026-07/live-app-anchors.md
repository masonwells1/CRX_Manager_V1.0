# Live-app anchors (croprxsolutions.app, admin session, 2026-07-04)

View-only walkthrough of deployed prod. Use these to confirm/correct workflow-agent claims during synthesis.

## Confirmed live
- **Sidebar** matches code map: Dashboard / Office Cockpit / To-Ship / Getting Started + collapsible Sales, Customers, Products & Inventory, Operations (11 links incl. /delivery-remainders), Finance + Team Board / Settings. Ctrl+K search + Notifications bell in top bar.
- **Office Cockpit tiles** link out via buttons: View all, Field Invoices, Manage, Schedule, Compliance, AR Aging, Inventory. Monitoring dashboard — no create-actions on it.
- **Quotes list**: search, status filter = Draft/Sent/Revised/Accepted/Declined/Expired/Cancelled — **NO `closed_by_application` ("Fulfilled (Applied)") option in the filter** (badge shipped, filter option missing?). "Planned Programs" toggle. Row actions: Duplicate. Several unlabeled icon-only buttons (a11y + discoverability).
- **Jobs list**: job # filter, ~30 unlabeled filter checkboxes (statuses/applicators?), date range, Today/This Week/This Season chips, per-job Print loader worksheet / Print chem application report / Open map+log files. Sort incl. Batch, Rem. ac. Live test jobs JOB-2026-0001/0002.
- **Dispatch board**: minimal step-1 job picker (search + Options + job rows).
- **Deliveries list**: **List view / Calendar view toggle**; filters Status (scheduled/in_progress/completed only), Driver, Priority, Customer, Date; **inline "Mark delivery DEL-xxxxx complete" one-click buttons on scheduled rows** — office fast path EXISTS at list level (verify: does it do confirm+complete atomically?). "Peek <customer>" row buttons.
- **Delivery Remainders page EXISTS** (in nav, search + status filter Pending/Scheduled/Fulfilled/Cancelled) → the "no page calls the remainders RPC" claim is WRONG. Page currently shows no rows (status=Pending default).
- **Field Invoices hub**: status filter draft/unposted/posted/paid/overdue/voided/cancelled; ~12 unlabeled icon buttons (likely tabs to unposted/posted/unbilled/summary).
- **Payments**: record-a-check flow front and center (customer search, method Check/Cash/Wire/ACH/CC/Other, ref, notes).
- **To-Ship**: tabs To-Ship/Low stock/Deliveries/Inbound + By product/By customer; rows have "Schedule a delivery for this order (pre-fills the remaining items)". NOTE: same order (ORD-2026-0148) appears ~10× as separate line-item rows each with its own schedule button — per-item granularity, arguably noisy.

## New live-only findings (not from agents)
1. **Customer-data hygiene for go-live**: customer dropdowns mix real customers with junk: "[E2E] Farm Alpha/Beta", "Test Farm Alpha", "A1 TEST FARM", "Crop Rx Solutions" (own company), "Purchase Orders for WELLS AG SUPPLY CHEMICAL" (a PO bucket as a customer), "Nutrien Ag Solutions West Union Branch" (supplier as customer), "SLS". Real customer list (~150) already loaded.
2. **Flat 150-option `<select>` dropdowns** for customers (Deliveries filter) — needs searchable combobox pattern at this scale.
3. **Quotes filter lacks the new closed_by_application status** (verify code: Quotes.tsx filter options).
4. **Unlabeled icon-only buttons** recur on Quotes/Jobs/FieldInvoices/Cockpit — new-hire discoverability + accessibility.
5. Service-worker "Update Now / Dismiss" toast persists across pages (deploy pending reload).

## Not verifiable live from this session
- Applicator-role phone menu (I'm on Mason's admin session; can't log in as test applicator — password entry prohibited). Covered by code (Sidebar role arrays) + role-applicator.spec.ts.
- Any write flows (view-only discipline on prod).
