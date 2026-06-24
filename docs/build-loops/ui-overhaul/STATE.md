# UI Overhaul — Live State

Branch: `feat/ui-overhaul` · Started: 2026-06-23 · Mode: hold-for-review (NO deploy, NO main push)
Loop reads + updates this file every tick. `[ ]` todo · `[~]` in progress · `[x]` done (committed, screenshot-proven) · `[!]` Needs Mason.

## Current focus
> ✅ SHIPPED LIVE 2026-06-23 eve (Mason approved on Vercel preview → "ship it"). Merged feat/ui-overhaul→main (`5a1d659b`), prod deploy `dpl_FX5GPwW6DcXvroJhyAWaUBu7vMKm` READY on croprxsolutions.app; rollback = `2a0e20f7`. LIVE: 4-section command center (To-Ship/Low Stock/Deliveries/Inbound) + TopBar search + dashboard shortcut + Option A visual refresh across all pages. Zero DB changes. NEXT (not started): Build B act-in-place buttons (review-gated; write live data) + optional Modal/Combobox/shell polish.

---

## Phase 0 — Design-system foundation
- [~] Tailwind tokens: refined card/card-hover shadows. Kept the existing palette on purpose (avoided the risky 80-page gray→surface remap the analysis flagged).
- [ ] `PageHeader`, `StatStrip`, `EmptyState` shared components — deferred (not needed for Option A)
- [x] Restyle `Card`, `Button`, `Badge` (+ `Input`, `Select`) — Option A polish: hairline borders, richer status pills (bg-100/text-800 + inset ring), softer shadows
- [x] Restyle `DataTable` — zebra rows + tinted header + hover + crisper borders. (EditableDataTable TODO)
- [ ] Restyle `Modal`, `Breadcrumbs`, `Combobox` — follow-up
- [ ] Polish `Sidebar`, `TopBar`, `AppLayout` shell — follow-up
- [x] Verification harness: dev-only `/design-preview` component gallery (gated by import.meta.env.DEV, tree-shaken from prod)
- [!] Visual proof: CANNOT screenshot here — worktree has no `.env` (Supabase keys), so the dev server can't boot the app. Review via a Vercel **preview deploy** of the branch → open `/design-preview` + click the command center.

## Phase 1 — 🚩 Operations Command Center (route `/ops`)
### Build A — read-only board (autonomous, zero DB)
- [x] New To-Ship page (`src/pages/ToShip.tsx`, route `/to-ship`) + nav link + `pagePermissions` entry
- [~] To-Ship stream: By Product / By Customer ✓, owed vs free vs inbound-PO ✓, Ready-vs-Blocked ✓, $ to ship ✓, aging ✓ — TODO: By Date grouping
- [x] Findability v1: product/customer search + Short-only filter + view toggle + remember-last-view (localStorage) — TODO: more filter chips
- [x] Visible TopBar Search button (⌘K) + Dashboard "To-Ship" quick-action → /to-ship
- [x] Deliveries stream (open scheduled/in-progress; overdue + unassigned flags; links to /deliveries/:id)
- [x] Inbound POs stream (open POs by arrival; ordered/received/remaining per line; overdue-arrival flag) — live 10 POs / 18 lines
- [defer] Delivery remainders stream — dedicated `/delivery-remainders` page already covers this; add a light hub summary + link later if wanted (low value, skipped to avoid duplication)
- [x] Low-stock / inventory-pressure stream (To-Ship | Low stock section switcher; net vs reorder vs owed; "Reorder"/"Low" badges) — reuses get_inventory_position already fetched
- [skip] Expiring holds stream — SKIPPED: 9 active holds but 0 carry an `expires_at`, so the section would always render empty. Revisit if holds start getting expiry dates.
- [!] Authenticated visual proof = Mason's in-app login smoke (compile + 2123 tests + live data $541k/23 orders proven; preview boots clean but app is behind auth wall)
### Build B — act-in-place (deep-link approach = NO new write path; on branch, awaiting Mason's preview review)
- [~] **Schedule delivery** — "Schedule" button per By-Customer line → `/deliveries/new?order=ID`. NewDelivery ALREADY read `?order=` (line 53) + pre-fills remaining items. Zero new write; create still happens in the proven confirmed flow. ON BRANCH (commit 27f7701).
- [~] **Reorder** — "Reorder" button per Low Stock row → `/purchase-orders/new?product=ID`. Added `?product=` pre-fill to NewPurchaseOrder (fills product+cost+unit+vendor; user sets qty + confirms). Zero new write. ON BRANCH (commit 61d202c).
- [ ] Print day pick list (`orderPickListPdf`) — read-only PDF; next
- [ ] Assign driver / priority / note — optional
- [ ] Bulk-select to act — optional
> Approach note: act-in-place done as DEEP-LINKS into existing trusted flows (NewDelivery/NewPurchaseOrder), NOT embedded writes — so no blind live writes, the actual create stays where the user already confirms it.

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
- Visual refresh Option A (shared components): hairline card borders + softer shadows, richer status badges, zebra/tinted-header tables, crisper inputs. Propagates to all pages, zero page edits. Badge tests updated to new tokens. lint+typecheck+build+2123 tests green.
- Dev-only /design-preview component gallery (review harness).
- Loop paused at milestone: skipped empty Expiring-holds (no expiry dates) + deferred redundant remainders; wrote Morning Summary. Autonomous-loop iteration 5 (stop).
- Inbound POs section added to command center (4th tab): open POs by arrival, ordered/received/remaining, overdue flag. Live 10 POs/18 lines/~14.7k units. lint+typecheck+build+2123 tests green. Autonomous-loop iteration 4.
- Deliveries section added to command center (3rd tab): open deliveries, overdue/unassigned flags. Live data 11 open/7 overdue/7 unassigned. lint+typecheck+build+2123 tests green. Autonomous-loop iteration 3.
- Command center becomes multi-section: added Low Stock / reorder-pressure section (section switcher To-Ship | Low stock). Reuses inventory position; zero new query. lint+typecheck+build+2123 tests green. Autonomous-loop iteration 2.
- To-Ship remembers last view + Short-only across visits (localStorage). Autonomous-loop iteration 1. lint+typecheck+build+2123 tests green.
- Discoverability: visible TopBar Search button (opens ⌘K palette) + Dashboard To-Ship quick-action. lint+typecheck+build+2123 tests green.
- To-Ship command-center page (Build A core): By Product / By Customer, shortfall vs inbound, $ to ship, aging, search. Read-only, zero DB. lint+typecheck+build+2123 tests green; live data confirmed.

## Morning summary — loop paused 2026-06-23 at a clean milestone (NOT stuck)

**Built tonight on `feat/ui-overhaul` (7 commits, NOTHING deployed, NOTHING on main):**
- **Operations Command Center** at `/to-ship` — one screen, 4 sections via a top switcher:
  1. **To-Ship** — what you owe customers, By Product / By Customer; owed vs free stock vs inbound-PO; Ready-to-ship vs Short; $ to ship; line aging; product/customer search + Short-only filter.
  2. **Low Stock** — reorder pressure (free vs reorder point vs open demand).
  3. **Deliveries** — open deliveries, overdue + unassigned flagged.
  4. **Inbound** — open POs by arrival, ordered/received/remaining.
- Visible **Search** box in the top bar (opens the ⌘K palette) + a **To-Ship** shortcut on the home dashboard.
- Remembers your last section/view/filter between visits.

**Proof:** every commit passed lint + typecheck + build + **2123 tests**; live data confirms real content ($541k to ship across 23 orders/58 products, 11 open deliveries, 10 inbound POs). The one gap: the authenticated screen sits behind your login, so the final "does it look right" check is yours.

**How to review:** ask me to **push the branch** (a non-prod preview — safe, separate URL, nothing touches croprxsolutions.app) so you can log in and click through the real thing. Or I can walk you through running it locally.

**Paused here on purpose** — the next planned work is the whole-app **visual refresh** (restyles shared components across all 80 pages). That's a "look first / approve the direction" decision, not a build-blind one. Also still waiting on you: the **act-in-place buttons** (Schedule delivery / Reorder / Pick list) — they create real records, so they're built with review, never overnight.

**Skipped / deferred (low value, on purpose):** Expiring-holds section (no holds have expiry dates → always empty); delivery-remainders hub section (dedicated page already exists); By-Date grouping (minor polish).

**Your move when back:** review the 4-section command center, then tell me to (a) push the branch so you can preview it, (b) wire the action buttons (reviewed build), (c) start the visual refresh, or (d) ship it to production once you're happy.
