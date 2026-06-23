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

## Phase 1 — 🚩 Operations Command Center (route `/ops`)
### Build A — read-only board (autonomous, zero DB)
- [ ] New hub page + route + nav entry + dashboard card + visible TopBar Search
- [ ] To-Ship stream: By Product / By Customer / By Date, owed vs free vs inbound-PO, Ready-vs-Blocked, $ to ship, aging
- [ ] Today/▷ deliveries stream
- [ ] Inbound POs stream (ordered − received, by arrival)
- [ ] Delivery remainders stream (age + tier)
- [ ] Low-stock / inventory-pressure stream (% owed; reorder triggers)
- [ ] Expiring holds stream
- [ ] Findability: product/customer search + filter chips + group/sort + remember-last-view
- [ ] Proof: each stream screenshotted; remaining-qty cross-checked vs OrderDetail
### Build B — act-in-place (REVIEW-GATED, human-tested, zero migration)
- [!] Schedule delivery from owed list (`create_delivery_with_items`) — reviewed build
- [!] Reorder / create PO from short product — reviewed build
- [!] Print day pick list (`orderPickListPdf`) — reviewed build
- [!] Assign driver / priority / note (`reassign_delivery` + `team_notes`) — reviewed build
- [!] Bulk-select to act — reviewed build

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
