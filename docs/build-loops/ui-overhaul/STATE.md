# UI Overhaul — Live State

Branch: `feat/ui-overhaul` · Started: 2026-06-23 · Mode: hold-for-review (NO deploy, NO main push)
Loop reads + updates this file every tick. `[ ]` todo · `[~]` in progress · `[x]` done (committed, screenshot-proven) · `[!]` Needs Mason.

## Current focus
> Phase 0 — design-system foundation. Not started yet.

---

## Phase 0 — Design-system foundation
- [ ] Formalize Tailwind theme tokens (spacing/radius/shadow/neutral ramp/status colors)
- [ ] `PageHeader`, `StatStrip`, `EmptyState` shared components (create if missing)
- [ ] Restyle `Card`, `Button`, `Badge`
- [ ] Restyle `DataTable` / `EditableDataTable` (sticky header, zebra/hover, numeric align)
- [ ] Restyle `Modal`, `Breadcrumbs`, `Combobox`
- [ ] Polish `Sidebar`, `TopBar`, `AppLayout` shell
- [ ] Proof: before/after screenshots — Dashboard, Orders, OrderDetail

## Phase 1 — 🚩 Search + To-Ship command center
- [ ] Visible `Search…` button in `TopBar` (⌘K) wired to CommandPalette
- [ ] Product hit in CommandPalette links to `/to-ship?product={id}`
- [ ] New `ToShip.tsx` page + route `/to-ship` (admin+sales_rep)
- [ ] By-Product tab (frontend query; qty remaining + on-hand vs prebooked)
- [ ] By-Customer tab (to-ship value + products owed)
- [ ] Nav entry + dashboard card → To-Ship
- [ ] Proof: both tabs screenshotted; remaining-qty cross-checked vs OrderDetail

## Phase 2 — Navigation backbone
- [ ] New `src/lib/routesConfig.ts` (single source of truth)
- [ ] Derive `Sidebar` nav from routesConfig
- [ ] Derive `CommandPalette` ALL_PAGES from routesConfig
- [ ] Fix "Operations" label collision (home link → "Dashboard")
- [ ] Split 16-item Finance group into labeled sub-sections
- [ ] `usePageMeta` longest-prefix match
- [ ] `routesConfig.test.ts` drift guard

## Phase 3 — Stop losing context (deep-linking)
- [ ] Clickable customer name + AR context card on Order/Invoice/Delivery detail
- [ ] Payment context params (`?customer=&invoice=`) + PaymentAllocation reads them
- [ ] "+ Create Invoice ▾" deep-link dropdown + Orders/BlendTickets read filters
- [ ] TransactionThread lifecycle status micro-text
- [ ] Action-hierarchy pass (one primary CTA + More ▾)

## Phase 4 — Consolidate workspaces
- [ ] Merge 4 AR pages → one tabbed AR workspace (old routes redirect)
- [ ] CustomerDetail overview header strip (tabs untouched)
- [ ] Dashboard ActionQueue deep-links + surface overdue bills / blend approvals / AR 60+
- [ ] Verify-then-remove any proven-unused page (own commit)

## Phase 5 — Mobile / tablet polish
- [ ] Drawer breakpoint lg→xl
- [ ] Mobile card fallback for Deliveries + Jobs
- [ ] BlendTicketDetail thumb-first; SelectLocationsModal segmented control
- [ ] Field-app print packet TODO

---

## Needs Mason (gated — loop will NOT do these)
- _(none yet)_

## Commit log (newest first)
- _(none yet)_

## Morning summary
- _(written when the loop pauses)_
