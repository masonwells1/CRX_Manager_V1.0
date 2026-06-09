# Phase 8 — Mobile, Tablet, Performance & Recovery Audit

**Date:** 2026-05-04
**Auditor:** Claude (Opus 4.7, 1M context)
**Scope:** Read-only. Field-day reliability — phones, tablets, weak signal, big lists, failed saves, lost work. Overwrites the prior Codex draft of this file.
**Prior reading:** `docs/audits/2026-05-04-phase-0-current-state-audit.md`, `docs/audits/2026-05-04-ui-navigation-workflow-audit.md` (sections 9 + 11), `docs/audits/2026-05-04-ui-improvement-plan.md` (Phase 4).

---

## Plain-English Summary

The good news is real. CRX Manager already has the bones of a field-grade app: an IndexedDB offline queue, a signed-by + photo flow, image compression to ~1MB before upload, an idempotency-key hook used on **48 mutating screens**, an `OfflineBanner` that auto-syncs when signal returns, a `useUnsavedChanges` guard that blocks both in-app and tab-close, a `useFormDraft` hook that snapshots state to localStorage when an Android PWA gets backgrounded, and a service-worker update prompt that asks before reloading. None of this is fake; the building blocks are in the repo and wired up.

The bad news is that almost all of it is wired to **one screen — Delivery Detail.** The driver-completing-a-delivery flow is genuinely solid. Everything else has gaps:

1. **Only one place in the app calls `queueAction()`** — `src/pages/DeliveryDetail.tsx:761`. Every other "complete" / "post" / "save" flow assumes the device is online. If a job is completed (`JobDetail.tsx:409`), an applicator finishes a field-app invoice (`FieldApplicationInvoice.tsx`), or a driver does a Quick Receive, no offline queueing happens — they get a toast error and have to redo the work.
2. **Field selection on tablet is broken-by-design** — `SelectLocationsModal.tsx:139,158` hard-codes a 50/50 desktop split (map left, table right) with no responsive fallback. Mason confirmed in the UI plan that applicators use this in the field.
3. **Big lists rely on hard server limits with toast warnings.** Invoices fetches 2000 rows, Orders / Deliveries / Customers / Quotes / POs fetch 500 each, and when the limit hits, a toast (which disappears in 5 seconds) tells the user some rows are hidden. Once the business outgrows those numbers, work will silently disappear.
4. **`useFormDraft` exists but is wired into exactly one page** — `NewOrder.tsx`. QuoteBuilder, OrderDetail-edit, FieldApplicationInvoice, NewVendorBill, NewDelivery, JobDetail-edit all use only `useUnsavedChanges` (which warns but does not preserve content). If the iPad PWA gets killed mid-edit, that work is gone.
5. **Photo upload has zero retry.** `DeliveryDetail.tsx:618-676` uploads photos one at a time and on failure shows a toast — there is no second attempt and no offline fallback. A cab with one bar will lose photos.
6. **Sidebar drawer breakpoint is `lg` (1024 px)**, which means an iPad in landscape gets the cramped collapsible desktop sidebar instead of the friendlier mobile drawer.
7. **Idempotency key adoption is excellent on most mutations**, but a handful of high-traffic write paths (notably the inline delivery photo INSERT at `DeliveryDetail.tsx:649`, the `signature_url` update at `:798`, and the soft-delete updates on Jobs/FieldApp invoices) bypass the pattern and would double-write on a mid-action retry.

In Mason's actual sentence: the driver app is good. The applicator app is desktop software running on a tablet. The list pages are fine until they aren't.

---

## Evidence Reviewed

| Topic | Files / lines |
|---|---|
| Driver delivery view | `src/pages/Deliveries.tsx:639-823` (driver branch), `:669-722` (DriverCard), `:777-814` (Available Deliveries) |
| Delivery completion + signature + photos | `src/pages/DeliveryDetail.tsx:618-676` (photo upload), `:704-722` (start), `:739-943` (complete), `:782-810` (signature upload) |
| Offline queue / sync | `src/lib/offlineQueue.ts:1-152`, `src/lib/offlineSync.ts:117-136` |
| Online status hook | `src/hooks/useOnlineStatus.ts:1-25` |
| Offline banner + auto-sync | `src/components/ui/OfflineBanner.tsx:1-115` |
| Unsaved-changes guard | `src/hooks/useUnsavedChanges.ts:1-27` |
| Form-draft persistence | `src/hooks/useFormDraft.ts:1-138` (only consumed by `src/pages/NewOrder.tsx`) |
| Image compression | `src/lib/imageCompression.ts:1-112` (1920 px max, 1 MB cap, JPEG) |
| Service-worker prompt | `vite.config.ts:23-85` (`registerType: 'prompt'`) |
| Field picker (tablet/phone) | `src/components/field-app/SelectLocationsModal.tsx:136-279` |
| Field map | `src/components/map/CRXMap.tsx:1-80`, `src/components/map/FieldBoundaryLayer.tsx:71-74` |
| Dispatch board | `src/pages/DispatchBoard.tsx:241-356` |
| Field-application invoice | `src/pages/FieldApplicationInvoice.tsx:101` (uses `useUnsavedChanges`), `:521-525` (Print TODO), `:640-650` (locations modal trigger) |
| Job detail (complete) | `src/pages/JobDetail.tsx:405-428` (no offline path) |
| List-page row caps | `src/pages/Invoices.tsx:91-113` (2000 + toast), `src/pages/Orders.tsx:54-75` (500 + toast), `src/pages/Customers.tsx:34-48` (500), `src/pages/Quotes.tsx:73`, `src/pages/Jobs.tsx:102`, `src/pages/Deliveries.tsx:183`, `src/pages/PurchaseOrders.tsx:81`, `src/pages/BlendTickets.tsx:77,83` |
| Inventory math in browser | `src/pages/InventoryPage.tsx:156-326` (Net Free / Planned / On Order all client-side aggregation) |
| DataTable (no pagination) | `src/components/ui/DataTable.tsx:1-178` (in-memory filter + sort, no server pagination, no virtualization) |
| Sidebar mobile breakpoint | `src/components/layout/Sidebar.tsx:443,486` (`lg:hidden` / `hidden lg:flex`) |
| Bundle chunking | `vite.config.ts:90-101` (manual chunks for react/supabase/lucide/mapbox) |
| Dashboard ActionQueue | `src/components/dashboard/ActionQueue.tsx:140-152` (`get_dashboard_action_items` with `p_limit: 10`) |
| Idempotency hook | `src/hooks/useIdempotencyKey.ts:25-40`, `src/lib/idempotency.ts:19-22` |
| Idempotency adoption | 48 files import `useIdempotencyKey` (verified by Grep) |

---

## Findings

### P8-1 — Offline queue is wired to delivery completion only
**Business risk:** High. Mason confirmed (UI plan, Q3) that applicators, drivers, and pick-list staff all work on phones and tablets. A driver in a dead zone can finish a delivery and the work is queued correctly, but an applicator finishing a job in that same dead zone will get an error toast and lose the applied-info entry. Same for posting a field-app invoice, recording a quick payment from the truck, or doing a quick-receive on a tailgate.
**Evidence:**
- Only one call site: `src/pages/DeliveryDetail.tsx:761` (`queueAction({ operation: 'complete_delivery', ... })`).
- The sync map at `src/lib/offlineSync.ts:117-127` already declares the operation list — `complete_delivery`, `allocate_payment`, `receive_po_items`, `update_order_items`, `complete_job`, `cancel_delivery`, `cancel_order`, `confirm_delivery`, `match_quick_receive_items` — but **only the first one** has a UI that actually queues.
- `JobDetail.tsx:405-428` (`handleComplete`) is a plain `await supabase.rpc('complete_job', …)` with no `if (!isOnline)` branch.
- `FieldApplicationInvoice.tsx` does not import `useOnlineStatus` or `queueAction` (Grep confirmed: only 7 files do).
- `OfflineBanner.tsx:56-61` already auto-syncs whenever `isOnline && pendingCount > 0` — the plumbing is ready; only the producers are missing.
**Fix direction:** Add the `isOnline` + `queueAction` branch to `handleComplete` in `JobDetail.tsx`, the post/save handlers in `FieldApplicationInvoice.tsx`, and `QuickReceive.tsx`. Pattern is already proven in DeliveryDetail — paste-and-rename. Then teach `OfflineBanner` to surface a "View pending actions" link to a small dashboard so users can see what's queued (the count alone isn't enough when a job is sitting unsynced for 6 hours).
**Likely files:** `src/pages/JobDetail.tsx`, `src/pages/FieldApplicationInvoice.tsx`, `src/pages/QuickReceive.tsx`, `src/pages/PaymentAllocation.tsx`, `src/components/ui/OfflineBanner.tsx`.

### P8-2 — Field-picker modal has no tablet/phone layout
**Business risk:** High. Picking the wrong field is an expensive mistake — wrong product, wrong customer's bill, possible re-spray. The Codex audit flagged this and the UI plan (Phase 4.2) accepted it.
**Evidence:**
- Modal shell: `src/components/field-app/SelectLocationsModal.tsx:136` — `<div className="fixed inset-0 z-50 flex items-stretch bg-black/50">`.
- Map pane: `:139` — `<div className="w-1/2 relative">` (literally hard-coded half width, no `md:` / `lg:` breakpoint).
- Table pane: `:158` — `<div className="w-1/2 flex flex-col">`.
- Footer is sticky and shows selected acres correctly (`:262-275`) — the only piece that already works on small screens.
- On a 11" iPad portrait (820 px), the user gets a 410 px map and a 410 px table — both unusably narrow.
**Fix direction:** Replace the `w-1/2` split with a segmented Map / List / Selected control on screens below `lg` (or `xl` per the UI plan), keeping the existing 50/50 on desktop. Keep the sticky footer. The map uses `cursor: pointer` and a click handler (`FieldBoundaryLayer.tsx:71-74`) that already works on touch via Mapbox GL — no map rebuild needed.
**Likely files:** `src/components/field-app/SelectLocationsModal.tsx`.

### P8-3 — Sidebar drawer breakpoint cuts off iPad landscape
**Business risk:** Medium. iPad landscape (1180 px on 11" Pro, 1366 px on 12.9") is wider than 1024 px, so it gets the **desktop** sidebar — collapsed to a 64 px icon strip with hover-reveal labels. Anyone navigating with a finger has to tap a tiny icon and read a tooltip.
**Evidence:**
- Mobile drawer hidden at `lg` (1024 px): `src/components/layout/Sidebar.tsx:443` (`lg:hidden`).
- Desktop sidebar shown at `lg`: `:486` (`hidden lg:flex`).
- `AppLayout.tsx` reads `mobileOpen` with the same `lg` assumption (`:43`).
**Fix direction:** Move both gates from `lg` (1024) to `xl` (1280). iPad landscape gets the touch-friendly drawer; full desktops are unaffected. Already part of UI Plan Phase 4.1.
**Likely files:** `src/components/layout/Sidebar.tsx`, `src/components/layout/AppLayout.tsx`.

### P8-4 — Photo upload has no retry and no offline fallback
**Business risk:** Medium-high. Driver photos are evidence — wrong product, wrong totes, damaged box. Losing one is a costly dispute later.
**Evidence:**
- `src/pages/DeliveryDetail.tsx:618-676` — photo upload loop.
- On storage failure (`:640-642`): single `toast('error', …)` then `continue` to next file. No retry, no queue, no recovery surface.
- On insert failure after upload succeeded (`:657-660`): row is in storage but not in `delivery_photos` — orphaned. Toast goes away in 5 s.
- The offline-queue `params` field is JSON; storage uploads cannot be queued through it as currently designed (it's RPC-shaped).
- Compression (`src/lib/imageCompression.ts`) is good — 1920 px max, JPEG 0.8 down to 0.3 if needed, capped at 1 MB. That part is solid.
**Fix direction:** Two parts. (1) Wrap the storage upload in a 3-try retry with a 1-2-4 second exponential backoff, surface a per-file error chip in the photo area instead of a vanishing toast. (2) When `!isOnline`, save the compressed Blob to IndexedDB (separate object store from the RPC queue) and surface "3 photos queued for upload" in OfflineBanner; flush when online. The existing `compressImage` already returns a `File` so the blob persists cleanly.
**Likely files:** `src/pages/DeliveryDetail.tsx`, `src/lib/offlineQueue.ts` (add a photos store), `src/lib/offlineSync.ts`, `src/components/ui/OfflineBanner.tsx`.

### P8-5 — Signature upload after `complete_delivery` can leave a saved delivery with no signature
**Business risk:** Medium. The RPC succeeds first, then the signature is uploaded as a separate `storage.upload` + `deliveries.update` (not idempotent). If the truck loses signal between steps, the delivery is marked complete (auto-invoice fires), but the signature is missing — toast says "Signature could not be saved. Please try completing the delivery again." but the delivery is already complete and can't be re-completed.
**Evidence:**
- `src/pages/DeliveryDetail.tsx:776-779` — `complete_delivery` RPC succeeds, idempotency key reset.
- `:781-810` — signature upload in a try/catch; on error a toast fires and the function `return`s, but the delivery has already been completed server-side.
- The orphaned-signature recovery path is "complete it again", which won't work — the RPC will return the cached idempotent result without re-uploading.
**Fix direction:** Either (1) upload the signature to storage **before** calling `complete_delivery` and pass the storage path as an RPC param, or (2) keep the current order but on failure, queue a retry-only "attach signature" action via the offline queue. Pattern (1) is simpler and matches how the RPC params are structured.
**Likely files:** `src/pages/DeliveryDetail.tsx`, possibly the `complete_delivery` RPC if it doesn't already accept `p_signature_url`.

### P8-6 — Big list pages cap at 500–2000 rows with a disappearing toast
**Business risk:** Medium today, high next season. Once Mason crosses ~500 customers / 500 active orders / 2000 invoices in a season, work will silently fall off the list. A driver searching for a specific customer's pending delivery may see "no results" because the customer is row 503.
**Evidence:**
- Invoices: `src/pages/Invoices.tsx:94` (`QUERY_LIMIT = 2000`), `:111-113` toast warning.
- Orders: `src/pages/Orders.tsx:56` (`QUERY_LIMIT = 500`), `:73-75` toast warning.
- Customers: `src/pages/Customers.tsx:39` (`.limit(500)`) — **no warning at all** if the cap is hit.
- Deliveries: `src/pages/Deliveries.tsx:183` (`.limit(500)`) — also silent.
- Quotes: `src/pages/Quotes.tsx:73` (`.limit(500)`) — silent.
- Jobs: `src/pages/Jobs.tsx:102` (`.limit(500)`) — silent.
- Purchase Orders: `src/pages/PurchaseOrders.tsx:81` (`.limit(500)`) — silent.
- Blend Tickets: `src/pages/BlendTickets.tsx:77,83` (`.limit(500)`) — silent.
- `DataTable` (`src/components/ui/DataTable.tsx`) has no pagination, no virtualization, no `loadMore`. Filter + sort happen in-memory on the full result.
**Fix direction:** Add real server-side pagination (or at least a "Load 500 more" button) to Invoices, Orders, Customers, Deliveries first — they're the daily screens. Replace the toast with a sticky banner above the table when the cap is reached. Long-term, swap `DataTable` for a virtualized table on these specific pages (TanStack Table + `@tanstack/react-virtual`) before row counts pass ~5,000.
**Likely files:** `src/pages/Invoices.tsx`, `src/pages/Orders.tsx`, `src/pages/Customers.tsx`, `src/pages/Deliveries.tsx`, `src/pages/Quotes.tsx`, `src/pages/Jobs.tsx`, `src/pages/PurchaseOrders.tsx`, `src/pages/BlendTickets.tsx`, `src/components/ui/DataTable.tsx`.

### P8-7 — Inventory free/planned/on-order math runs in the browser with no row cap
**Business risk:** Medium-high. `InventoryPage.tsx` issues 4 parallel queries (holds, open POs, planned-quote items, season-to-date deliveries) and aggregates them client-side at `:205-225` to compute `freeQty` for every product. There's no `.limit()` on the inventory query (`:156-160`), the holds query (`:174-178`), the PO-items query (`:180-183`), the planned-quote-items query (`:185-189`), or the delivered-transactions query (`:195-199`). On a season with thousands of inventory transactions, the page will pull all of them on every load.
**Evidence:**
- `src/pages/InventoryPage.tsx:156-326` — full client-side aggregation.
- No `.limit()` on any of the 5 fetches.
- Phase 0 audit already flagged this as "Inventory math runs in the browser. Worth confirming. (Phase 4.)"
**Fix direction:** Move the aggregation to a single `get_inventory_overview()` RPC that returns the joined rows. Keep `quantity_available` authoritative in the table; compute `free_qty`, `planned_qty`, `on_order_qty` server-side. Frontend just renders.
**Likely files:** `src/pages/InventoryPage.tsx`, new migration for the RPC.

### P8-8 — `useFormDraft` exists but is used by exactly one page
**Business risk:** High on iPads in PWA mode. Android Chrome and iOS Safari both kill backgrounded PWAs aggressively to reclaim memory; when the user returns the page reloads from scratch. `useUnsavedChanges` (used by 22 pages) only blocks **deliberate** navigation — it does not survive a kill. `useFormDraft` (only used by `NewOrder.tsx`) does survive, by snapshotting state to localStorage on `visibilitychange`.
**Evidence:**
- `src/hooks/useFormDraft.ts:114-128` — visibility-change flush is correct (the reason the file exists).
- Only consumer: `src/pages/NewOrder.tsx` (Grep).
- Long-form pages that should use it but don't: `QuoteBuilder.tsx`, `OrderDetail.tsx` (item edit), `FieldApplicationInvoice.tsx`, `NewVendorBill.tsx`, `NewDelivery.tsx`, `NewPurchaseOrder.tsx`, `JobDetail.tsx`, `FieldSetup.tsx`, `ProductDetail.tsx`, `BlendTicketDetail.tsx`, `VehicleDetail.tsx`, `ApplicationServiceDetail.tsx` (all 12 currently use only `useUnsavedChanges`).
**Fix direction:** Add `useFormDraft('quote-builder', { … })` to QuoteBuilder, FieldApplicationInvoice, NewVendorBill, NewDelivery, NewPurchaseOrder first — these are the longest forms that crash hardest if killed. On mount, prompt "Restore unsaved changes from N minutes ago?" if a draft exists. The hook already handles 4-hour TTL and migration from sessionStorage.
**Likely files:** `src/pages/QuoteBuilder.tsx`, `src/pages/FieldApplicationInvoice.tsx`, `src/pages/NewVendorBill.tsx`, `src/pages/NewDelivery.tsx`, `src/pages/NewPurchaseOrder.tsx`.

### P8-9 — Idempotency keys are everywhere except the inline mutations on detail pages
**Business risk:** Medium. The hook is correctly used on all 48 RPC mutations Grep found, including the high-traffic ones (`complete_delivery`, `allocate_payment`, `confirm_delivery`, `post_invoice`, `complete_job`, `save_quote`, `convert_quote_to_order`). But several **inline writes** that are not RPCs bypass the pattern: a flaky double-tap can write twice.
**Evidence:**
- Photo INSERT: `src/pages/DeliveryDetail.tsx:649` — `supabase.from('delivery_photos').insert({...})` with no idempotency.
- Signature URL UPDATE: `:798` — `supabase.from('deliveries').update({ signature_url: filePath })` with no idempotency.
- Soft-delete invoice: `src/pages/FieldApplicationInvoice.tsx:468-472` — direct UPDATE.
- Bulk soft-delete jobs: `src/pages/Jobs.tsx:206-210` — direct UPDATE on `jobs.deleted_at`.
- These are not RPC calls so the idempotency-key contract doesn't apply, but they are still mutations that can be double-fired by a touch device.
**Fix direction:** Most of these can be wrapped in a small "in-flight" guard (a `useRef<boolean>` set true while the mutation is pending) — cheap and safe. For photo INSERT specifically, use a unique-per-photo `client_id` column so duplicate inserts collapse on a unique index. Photo storage path already uses `Date.now()` so storage de-dup is fine, but the DB row is at risk.
**Likely files:** `src/pages/DeliveryDetail.tsx`, `src/pages/FieldApplicationInvoice.tsx`, `src/pages/Jobs.tsx`, possibly a new migration if a `delivery_photos.client_id` column is added.

### P8-10 — Field-app Print Packet is a TODO; applicators carry paper
**Business risk:** Medium-high. Same finding as the UI audit (their Section 8) but worth keeping in Phase 8 because it ships with paper to the field, where signal is weakest.
**Evidence:** `src/pages/FieldApplicationInvoice.tsx:521-525` — `<Button variant="secondary" size="sm" icon={<Printer className="w-4 h-4" />} onClick={() => { /* TODO: print */ }}>Print</Button>`.
**Fix direction:** Wire to a new `lib/fieldAppPacketPdf.ts` (mirror the existing `lib/invoicePdf.ts` pattern) — locations, chemicals, customer split, applied info on one PDF. Pre-cache via the service worker so the applicator can re-download in the field after losing signal.
**Likely files:** `src/pages/FieldApplicationInvoice.tsx`, `src/lib/invoicePdf.ts` (extend), new `src/lib/fieldAppPacketPdf.ts`.

### P8-11 — Dashboard `ActionQueue` caps at 10 items per category, no "show more"
**Business risk:** Low-medium. `ActionQueue.tsx:143` calls `get_dashboard_action_items` with `p_limit: 10`. If a Monday morning has 30 overdue invoices and 20 unassigned deliveries, the user sees 10 + 10 and can dismiss them, but there's no way to see #11. The dismiss state is in `sessionStorage` (`:135-138`) — fine for a workday, but combined with the cap it can hide problems.
**Evidence:** `src/components/dashboard/ActionQueue.tsx:140-152`.
**Fix direction:** Show a "View all 23" link on each category that routes to the list page with a pre-applied filter (e.g., `/invoices?status=posted&overdue=true`). UI Plan Phase 3.2 already proposes this.
**Likely files:** `src/components/dashboard/ActionQueue.tsx`, `src/pages/Invoices.tsx`, `src/pages/Deliveries.tsx`.

### P8-12 — Search inputs are not debounced
**Business risk:** Low. `DataTable` (`src/components/ui/DataTable.tsx:41-70`) re-runs `filter` + `sort` over the full in-memory array on every keystroke. For 500–2000 rows on a phone, this is fine but noticeable. Only `InvoiceDetail.tsx:306` debounces, and that's a network search, not a local filter.
**Evidence:** Grep returned no `debounce` / `useDeferredValue` usage in `src/pages` other than InvoiceDetail.
**Fix direction:** Wrap the search-state setter in `useDeferredValue` (a one-line change inside `DataTable`). No other consumer changes needed. Pairs naturally with the virtualization change in P8-6.
**Likely files:** `src/components/ui/DataTable.tsx`.

### P8-13 — `Deliveries.tsx` driver dashboard is genuinely good — keep it
**Business value (not a fix):** Worth calling out so we don't break it later. The driver branch (`src/pages/Deliveries.tsx:639-823`) is a phone-first card layout with `active:bg-gray-700` press states, large touch targets, "Tap to start delivery →" / "Ready to complete →" affordance text, and an "Available Deliveries" claim flow that uses `runCriticalAction` + idempotency. This is the model to copy for the Applicator job-day view.
**Evidence:** `src/pages/Deliveries.tsx:669-722`, `:777-814`.
**Fix direction:** Don't fix — replicate. When P8-1 wires offline support into `JobDetail.tsx`, also build a parallel "My Jobs Today" cards view at `Jobs.tsx` for `role === 'applicator'`.

---

## Mobile vs Desktop Coverage Matrix

| Surface | Phone (driver/applicator) | Tablet (cab/field) | Desktop (office) |
|---|---|---|---|
| `Deliveries.tsx` driver branch | ✅ purpose-built cards, dark theme, large taps | ✅ same | n/a (drivers use phones) |
| `Deliveries.tsx` admin branch | ⚠ DataTable scrolls horizontally; filters wrap but cramped | ⚠ usable, schedule strip works | ✅ |
| `DeliveryDetail.tsx` driver view | ✅ offline queue, large green button, signature canvas, photos | ✅ same | ✅ |
| `DeliveryDetail.tsx` admin view | ⚠ many buttons in header; wraps but cluttered | ⚠ same | ✅ |
| `Jobs.tsx` | ❌ no card view; DataTable only | ❌ same | ✅ |
| `JobDetail.tsx` | ⚠ form pages with tabs; no offline path | ⚠ same | ✅ |
| `DispatchBoard.tsx` | ❌ split-screen 60/40 hard-codes `lg:col-span-3 / lg:col-span-2`; collapses to 1 col below `lg` but map and list compete for vertical space | ⚠ landscape OK, portrait poor | ✅ |
| `FieldApplicationInvoice.tsx` | ❌ desktop-only; 4-tab page, no offline path, Print TODO | ❌ same | ✅ |
| `SelectLocationsModal.tsx` (field picker) | ❌ hard `w-1/2` split | ❌ unusable on iPad portrait | ✅ |
| `BlendTicketDetail.tsx` | ⚠ photo upload OK (compresses), but long-form fields cramped | ⚠ usable | ✅ |
| `Invoices.tsx`, `Orders.tsx`, `Customers.tsx`, `Quotes.tsx` | ❌ DataTable is horizontal-scroll-only on phones | ⚠ usable in landscape | ✅ |
| `InventoryPage.tsx` | ❌ wide table; client-side math heavy | ⚠ usable | ✅ |
| `QuoteBuilder.tsx`, `NewOrder.tsx`, `NewVendorBill.tsx` | ❌ long forms, only NewOrder has draft persistence | ⚠ usable but at risk | ✅ |
| Sidebar / TopBar | ✅ drawer below 1024 | ❌ iPad landscape gets cramped collapsed sidebar | ✅ |
| Service-worker update prompt | ✅ never auto-reloads — preserves form data | ✅ | ✅ |
| `OfflineBanner` | ✅ visible, auto-syncs | ✅ | ✅ |

Legend: ✅ ready / ⚠ works but rough / ❌ needs Phase 8 work before field use.

---

## What's Already Working — Do Not Regress

1. **`vite.config.ts:23-85`** — `registerType: 'prompt'` on the service worker. Comment in the file specifically calls out that auto-reload was "wiping form data when switching away on mobile." Don't touch.
2. **`vite.config.ts:90-101`** — manual chunks split out `react-router-dom`, `@supabase/supabase-js`, `lucide-react`, `mapbox-gl`. These are the 4 biggest dependencies and they each get their own cache-friendly chunk.
3. **`useUnsavedChanges`** — uses `useBlocker` from React Router for in-app navigation **and** `beforeunload` for tab close (`:18-23`). Adopted by 22 pages.
4. **`useFormDraft`** — handles `visibilitychange` correctly (`:114-128`); the existing implementation is the right shape, it just needs to be called from more pages.
5. **`compressImage`** — pre-upload compression to ≤1 MB JPEG, falls back to original if compression makes it bigger (`:80-82`). Cell-data savings are real.
6. **`OfflineBanner`** — auto-syncs whenever `isOnline && pendingCount > 0`; shows pending count, re-checks every 5 s, surfaces success / failure. Polished.
7. **`useIdempotencyKey`** — adopted by 48 files for every RPC mutation. Phase 0 already noted this as a strength.
8. **Driver-branch UI in `Deliveries.tsx` and `DeliveryDetail.tsx`** — the gold-standard field-day flow.

---

## Open Questions for Mason

These are the things that decide which P8 items get done first.

1. **List sizes today.** Roughly how many active customers, active orders this season, and posted invoices this season do you currently have? If you're below ~300 customers / ~200 active orders / ~1500 invoices, P8-6 is preventative. If you're already brushing 500 / 1500 / 1800, it's urgent.
2. **Worst-signal location.** Where do drivers and applicators most often lose signal — specific farms, specific roads? That determines whether we invest in a "queued for sync" dashboard (P8-1 follow-up) or a slim retry banner is enough.
3. **Devices in actual use.** Are applicators using phones, iPads, or both? If iPads, are they typically held in landscape (sidebar question) or portrait (field-picker question)?
4. **Photos lost in the field — has it happened?** If yes, P8-4 (retry + offline blob queue) is a Sprint-1 item. If no incidents, the simpler retry is enough.
5. **Offline scope.** Is it OK that an applicator can complete a job offline (with a cached set of fields/products) and have it sync when they hit signal? Or do you want offline-write only after the user explicitly enters an "offline mode"?
6. **Signature missing after delivery.** Has anyone hit P8-5 in practice (delivery completed but no signature)? It's a small but real footgun.

---

## Recommended Fix Order Within Phase 8

Sequenced so each step is independently reviewable and shippable. Total estimate: 4–6 working days, no migrations except possibly P8-7 and P8-9.

1. **P8-3** Sidebar breakpoint `lg` → `xl`. *15 minutes.* Lowest risk, biggest tablet win.
2. **P8-2** Field-picker responsive layout. *Half day.* Already in the UI Plan; matches the ask Mason already approved.
3. **P8-12** `useDeferredValue` in `DataTable.tsx`. *15 minutes.* Free perf.
4. **P8-6** List-page pagination & persistent over-cap banner (Customers, Orders, Deliveries, Invoices first). *1 day.* No migrations; replace toast with banner + add server-pagination to top 4.
5. **P8-8** Wire `useFormDraft` into QuoteBuilder, FieldApplicationInvoice, NewVendorBill, NewDelivery, NewPurchaseOrder. *Half day.* Pattern is one-liner per page + a "Restore?" prompt on mount.
6. **P8-1** Offline queueing for `complete_job`, `post_invoice_group` (field-app), `match_quick_receive_items`, `allocate_payment`. *1 day.* Plumbing all exists in `offlineSync.ts`; only UI branches needed.
7. **P8-4** Photo upload retry + per-file error chips. *Half day for retry.* Offline blob queue is a bigger lift — defer to Phase 8b unless P8-Q4 says it's urgent.
8. **P8-5** Reorder signature upload to before `complete_delivery`. *2 hours.* Surgical fix.
9. **P8-9** Add `useRef` in-flight guards to inline mutations on DeliveryDetail / FieldApplicationInvoice / Jobs. *2 hours.* Ship with #8.
10. **P8-11** Action-queue "View all" deep links — already covered by UI Plan Phase 3.2. *Half day if not already done.*
11. **P8-10** Field-application print packet (TODO at `FieldApplicationInvoice.tsx:521`). *1 day.* Already approved in UI Plan Phase 4.6.
12. **P8-7** Move inventory aggregation to RPC. *1 day.* Migration + RPC + frontend swap. Lowest field-day urgency, but big perf win at scale.

After all 12, mobile/tablet field-day reliability is fully closed and Mason's crews can actually trust the app off-network.

---

*End of Phase 8.*
