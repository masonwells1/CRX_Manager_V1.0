# UI Overhaul v2 — Live State

Branch: `feat/ui-overhaul-v2` (off prod `db9b32ea`) · Started 2026-06-23 · Mode: **hold-for-review** (NO deploy, NO main push)
Loop reads + updates this file every tick. `[ ]` todo · `[~]` in progress · `[x]` done (proven + committed) · `[!]` Needs Mason.

## Current focus
> F2 (Customer 360) in progress. Summary cards clickable (F2a) + new CustomerDrawer slide-over wired into the Orders list (peek a customer's numbers without leaving the list). Next: wire the drawer into Invoices / Deliveries / Customers lists, then the Fields-tab per-field balance, then F3.

---

## F1 — Search by product everywhere  (frontend, zero DB, autonomous)
- [x] `Orders.tsx` — product-name search box (added `product_name` to the existing order_items query → searchable `product_names` field + searchKey; placeholder "Search orders or products…")
- [x] `Quotes.tsx` — product search (join quote_items.product_id → products.product_name into a `product_names` searchKey) + fixed the pre-existing dead `customer_name` searchKey (now denormalized off the customer join). Placeholder "Search quotes, customers, or products…"
- [x] `CommandPalette.tsx` — deep-link entries for individual Sales reports (Product Mix→by_product, Customer Profitability→by_customer, by Rep, by Month); added a `?tab=` reader to SalesReports.tsx; getPageIcon strips query strings. AR Aging + Commissions already reachable (/ar-aging, /commission-payments). Unique paths so the list keys don't collide.
- [!] (stretch) `FieldInvoices.tsx`/`UnbilledApplications.tsx` by-product filter — DEFERRED. invoice_items/quote-like lines need a product join (no product_name col), AND live has **0 field-application invoice line items** (field apps haven't started), so it can't be proven against real data + would render empty. Revisit once field-app billing is in use.

## F2 — One customer = one screen (Customer 360)  (frontend, reuses existing components)
- [~] Read + extend `components/customers/CustomerSummaryBar.tsx` (done — cards now clickable) + `components/team/CustomerContextCard.tsx` (next, for the drawer)
- [~] `CustomerDetail.tsx` — summary strip ALREADY existed + rendered (line 597). Now each card deep-links to its tab (AR→Financials, Orders→Orders, Deliveries→Deliveries, Tier→Info, Last Activity→Timeline). REMAINING: extra numbers (# fields · license expiry · next compliance) need `get_customer_summary` to return them (RPC change = gated `[!]`) or extra frontend queries; "sticky" is visual polish for Mason. Deferring those two.
- [~] Customer 360 slide-out drawer from list rows — built `components/customers/CustomerDrawer.tsx` (right slide-over reusing CustomerSummaryBar + "Open full profile"; plain-Tailwind translate slide since tailwindcss-animate isn't installed — the `animate-in` classes CommandPalette uses are dead no-ops). Wired into **Orders** list (peek button per row). REMAINING: wire into Invoices / Deliveries / Customers lists.
- [ ] Fields tab — per-field outstanding balance, color-coded (only if data already available)

## F3 — Act from the list (confirm-popup writes)  (REAL WRITES — review-gated, Mason-tested)
- [ ] `Orders.tsx` — "Create Invoice" (reuse OrderDetail's exact RPC) + confirm popup + idempotency/assertRpcResult
- [ ] `Quotes.tsx` — "Convert to Order" (`convert_quote_to_order`) + confirm popup
- [ ] `Deliveries.tsx` — "Mark Complete" (two-step confirm_delivery → complete_delivery, capture signed-by) + popup
- [ ] `InventoryPage.tsx` — "Reorder" low-stock row → pre-filled New PO (deep-link is fine here)
- [ ] `BlendTickets.tsx` — inline "Link Order" / "Create Invoice"
- [!] Live exercise of each write button → Mason clicks in review (loop must NOT fire against live prod)

## F4 — Merge the 4 money pages → one AR workspace  (frontend consolidation, review-gated)
- [ ] One tabbed Accounts Receivable workspace = `ARaging` + `PaymentHistory` + `PrepaymentManager` + `CustomerTransactionReview`
- [ ] 🚩 KEEP `/payments` (PaymentAllocation, admin+sales_rep) SEPARATE — do not fold it in (would lock out sales reps)
- [ ] Old routes → redirects to the right tab (no broken links)
- [ ] "Net Money Position" card (owed − unused prepay)

## F5 — Receiving Hub  (frontend like To-Ship + confirm-popup receive — review-gated writes)
- [ ] New `/receiving-hub` page + `pagePermissions.ts` entry (admin+sales_rep) + nav link
- [ ] Product search → open PO lines across vendors (ordered − received) → inline "Receive" confirm popup (reuse QuickReceive's RPC)
- [ ] Per-product Commitment Snapshot (On Floor · On Hold · On Order · Spoken-For · Available) via get_inventory_position()
- [!] Live exercise of receive → Mason tests (loop must NOT auto-receive against live prod)

## F6 — Dashboard at-a-glance numbers + alerts  (frontend, reuses existing RPCs — added 2026-06-23 eve)
- [ ] `Dashboard.tsx` — admin-only "Finance Snapshot" card via existing `financial_dashboard_summary` RPC (overdue AR 60+/90+, bills due this week, prepay balance, MTD profit), each a clickable deep-link; gate on role==='admin'
- [ ] Alert cards: overdue bills · blend tickets awaiting approval · AR 60+ (only if the count already comes from operational/financial summary; else mark `[!]` that one, no new query)

## F7 — Quick wins batch  (tiny, low-risk — added 2026-06-23 eve)
- [ ] `Invoices.tsx` — clickable Order # column (join order_number off order_id)
- [ ] `Invoices.tsx` — "Has a balance" filter toggle (balance_cents > 0)
- [ ] `ARaging.tsx` — sticky summary cards (Total/Current/30-89/90+) on scroll
- [ ] `Sidebar.tsx` — rename home link "Operations" → "Dashboard" (fixes label collision) + auto-close mobile drawer after tap

---

## Needs Mason (gated — the loop will NOT do these)
- _(none yet — populated as the loop hits gates)_

## Commit log (newest first)
- F2b: Customer 360 drawer. New CustomerDrawer slide-over (reuses CustomerSummaryBar + "Open full profile" link; plain-Tailwind translate slide). Wired a per-row "peek customer" button into the Orders list (stops row-nav, opens the drawer). Reuses get_customer_summary (already proven); zero DB. Gate green (lint+typecheck+build+2179 tests). NOTE: tailwindcss-animate isn't installed → CommandPalette/Modal `animate-in` classes are dead (cosmetic, pre-existing).
- F2a: CustomerSummaryBar cards are now clickable → jump to the matching CustomerDetail tab (added optional onCardClick prop + per-card tab; renders a button when wired, div otherwise — backward compatible, existing test green). Also deferred the F1 field-invoice stretch (0 live field-app line items). Interaction-only, zero DB. Gate green (lint+typecheck+build+2179 tests).
- F1c: ⌘K palette jumps to individual Sales reports. Added a `?tab=` reader to SalesReports.tsx (mount-time, validated against the Tab union) + 4 deep-link entries in CommandPalette ALL_PAGES (Product Mix/Customer Profitability/by Rep/by Month) + getPageIcon strips `?query`. AR Aging + Commissions already reachable. Routing-only, zero DB. Gate green (lint+typecheck+build+2179 tests).
- F1b: Quotes list searchable by product. quote_items only has product_id → join to products.product_name, denormalize a `product_names` string per quote. Also fixed the latent `customer_name` searchKey (was undefined on every row) by denormalizing the customer join. Zero DB. Gate green (lint+typecheck+build+2179 tests); cross-checked 10/10 quote_items join to a product.
- F1a: Orders list searchable by product name. Reused the existing per-order order_items query (added product_name col), built a `product_names` string per order, added it to DataTable searchKeys. Zero DB. Gate green (lint+typecheck+build+2179 tests); cross-checked 277/277 order_items carry product_name (94 distinct).
- Scaffolding: PLAN.md + STATE.md + LOOP_PROMPT.md for the 5-feature v2 loop. Branch off prod db9b32ea.

## Morning summary
_(written when the loop stops)_
