# UI Overhaul v2 — Live State

Branch: `feat/ui-overhaul-v2` (off prod `db9b32ea`) · Started 2026-06-23 · Mode: **hold-for-review** (NO deploy, NO main push)
Loop reads + updates this file every tick. `[ ]` todo · `[~]` in progress · `[x]` done (proven + committed) · `[!]` Needs Mason.

## Current focus
> F3 done (Convert/Complete/Reorder shipped; Orders-Create-Invoice + BlendTickets deferred). F4 started: AR workspace tabbed page shipped (additive, admin-only, /payments kept separate). Next: F4 "Net Money Position" card (optional), then F5 Receiving Hub, F6 dashboard alerts, F7 quick wins.

---

## F1 — Search by product everywhere  (frontend, zero DB, autonomous)
- [x] `Orders.tsx` — product-name search box (added `product_name` to the existing order_items query → searchable `product_names` field + searchKey; placeholder "Search orders or products…")
- [x] `Quotes.tsx` — product search (join quote_items.product_id → products.product_name into a `product_names` searchKey) + fixed the pre-existing dead `customer_name` searchKey (now denormalized off the customer join). Placeholder "Search quotes, customers, or products…"
- [x] `CommandPalette.tsx` — deep-link entries for individual Sales reports (Product Mix→by_product, Customer Profitability→by_customer, by Rep, by Month); added a `?tab=` reader to SalesReports.tsx; getPageIcon strips query strings. AR Aging + Commissions already reachable (/ar-aging, /commission-payments). Unique paths so the list keys don't collide.
- [!] (stretch) `FieldInvoices.tsx`/`UnbilledApplications.tsx` by-product filter — DEFERRED. invoice_items/quote-like lines need a product join (no product_name col), AND live has **0 field-application invoice line items** (field apps haven't started), so it can't be proven against real data + would render empty. Revisit once field-app billing is in use.

## F2 — One customer = one screen (Customer 360)  (frontend, reuses existing components)
- [~] Read + extend `components/customers/CustomerSummaryBar.tsx` (done — cards now clickable) + `components/team/CustomerContextCard.tsx` (next, for the drawer)
- [~] `CustomerDetail.tsx` — summary strip ALREADY existed + rendered (line 597). Now each card deep-links to its tab (AR→Financials, Orders→Orders, Deliveries→Deliveries, Tier→Info, Last Activity→Timeline). REMAINING: extra numbers (# fields · license expiry · next compliance) need `get_customer_summary` to return them (RPC change = gated `[!]`) or extra frontend queries; "sticky" is visual polish for Mason. Deferring those two.
- [x] Customer 360 slide-out drawer from list rows — `components/customers/CustomerDrawer.tsx` (right slide-over reusing CustomerSummaryBar + "Open full profile"; plain-Tailwind translate slide since tailwindcss-animate isn't installed). Wired into **Orders + Invoices + Deliveries** lists (peek button per row). Customers list SKIPPED (the row already is the customer).
- [!] Fields tab — per-field outstanding balance DEFERRED. No clean existing per-field balance source (billing is invoice/customer-level; field-level attribution would need a new join/RPC = gated) AND field-app billing data is ~0 live. Revisit with per-acre billing.

## F3 — Act from the list (confirm-popup writes)  (REAL WRITES — review-gated, Mason-tested)
- [!] `Orders.tsx` "Create Invoice" — DEFERRED to the detail page. OrderDetail.handleCreateInvoice branches on allocations (`create_split_invoices_from_order` vs `create_invoice_from_order`) and is gated by per-delivery/draft-consolidation logic that needs the order's full context; replicating it blind on a list row could create wrong invoices. Stays on OrderDetail (the row already links there).
- [x] `Quotes.tsx` "Convert to Order" — DONE. Per-row button on sent/revised quotes → ConfirmModal → `convert_quote_to_order` (same atomic RPC QuoteBuilder uses; idempotent + actor-bound; status guard allows sent/revised; handles partial-draws/already-converted). compliance-reviewer = CLEAN (0 blocker/high/med). Verified the live RPC status guard before building.
- [x] `Deliveries.tsx` — "Mark Complete" DONE. Per-row Complete button on **in_progress** deliveries → Modal with signed-by input → `complete_delivery` (full delivery; p_quantities omitted; idempotent + actor-bound; routed through runCriticalAction). Verified live RPC is in_progress-only before building. Scheduled deliveries start from the detail page first; partial qty / signature-image / issue flags stay on the detail page (v1). compliance-reviewer CLEAN (MED consistency nit fixed).
- [x] `InventoryPage.tsx` — "Reorder" button on each low-stock alert row → `/purchase-orders/new?product=ID` (NewPurchaseOrder already pre-fills product/cost/unit/vendor from v1). Deep-link, NO write → no compliance gate.
- [!] `BlendTickets.tsx` inline "Link Order" / "Create Invoice" — DEFERRED. **0 blend tickets live** (nothing to prove against), "Link Order" needs an order-PICKER (not a simple confirm) + the create-invoice path has multi-axis preconditions (completed+approved+unbilled+linked) that live on BlendTicketDetail. Revisit when blend tickets are in use.
- [!] Live exercise of each write button → Mason clicks in review (loop must NOT fire against live prod). READY TO TEST: (1) Quotes → "Convert to Order" (PackageCheck icon on a sent/revised quote row); (2) Deliveries → "Complete" button on an in_progress delivery (enter a signed-by name).

## F4 — Merge the 4 money pages → one AR workspace  (frontend consolidation, review-gated)
- [x] One tabbed Accounts Receivable workspace — new `AccountsReceivable.tsx` at `/accounts-receivable` (admin-only) renders ARaging / PaymentHistory / PrepaymentManager / CustomerTransactionReview as tabs (`?tab=`, only the active tab mounts). Route + pagePermissions(admin) + Sidebar link added. Additive, no page-logic change. NO new write → gate-proven + Mason's preview is the review (verified /payments untouched).
- [x] 🚩 KEEP `/payments` (PaymentAllocation, admin+sales_rep) SEPARATE — confirmed NOT merged/modified (git diff clean of PaymentAllocation).
- [!] Old routes → redirects — FOLLOW-UP. v1 keeps the 4 old routes + sidebar links live (zero risk); converting them to redirects + pruning the 4 nav links changes Mason's muscle memory → his call in review.
- [ ] "Net Money Position" card (owed − unused prepay) — remaining; needs a combined owed-minus-prepay read (next F4 tick).

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
- F4a: Accounts Receivable workspace. New admin-only `/accounts-receivable` page renders the 4 money screens (Aging/Payment History/Prepayments/Ledger) as tabs (?tab=, active-only mount). +route +pagePermissions(admin) +Sidebar link. Additive (old routes kept), zero new write/logic; /payments (PaymentAllocation, admin+sales_rep) deliberately NOT merged (verified untouched). Gate green (lint+typecheck+build+2179 tests). BlendTickets F3 deferred (0 live data + needs order-picker).
- F3c: InventoryPage low-stock "Reorder" button → deep-links to a pre-filled New PO (`?product=`). No write (navigation only), reuses NewPurchaseOrder's v1 pre-fill. Zero DB. Gate green (lint+typecheck+build+2179 tests).
- F3b: Deliveries "Mark Complete" act-from-list button. Per-row Complete on in_progress deliveries → Modal w/ signed-by input → complete_delivery (full delivery, idempotent + actor-bound, via runCriticalAction). Verified the live RPC is in_progress-only before building; compliance-reviewer CLEAN (fixed the runCriticalAction consistency nit). NOT fired against live. Zero DB. Gate green (lint+typecheck+build+2179 tests).
- F3a: Quotes "Convert to Order" act-from-list button (first WRITE feature). Per-row PackageCheck button on sent/revised quotes → ConfirmModal → convert_quote_to_order (idempotent + p_performed_by actor-bound + assertRpcResult; maps BOOKING_PARTIALLY_DRAWN/BOOKING_CLOSED). Verified the live RPC status guard accepts sent/revised before building; compliance-reviewer CLEAN (fixed 1 LOW: BOOKING_CLOSED toast now matches QuoteBuilder). NOT clicked against live — Mason tests in review. Zero DB. Gate green (lint+typecheck+build+2179 tests).
- F2d: Customer 360 peek drawer wired into the Deliveries list (per-row peek button in the customer column). Drawer now on Orders+Invoices+Deliveries. Zero DB. Gate green (lint+typecheck+build+2179 tests).
- F2c: Customer 360 peek drawer wired into the Invoices list (per-row peek button next to the customer link, reuses CustomerDrawer). Zero DB. Gate green (lint+typecheck+build+2179 tests).
- F2b: Customer 360 drawer. New CustomerDrawer slide-over (reuses CustomerSummaryBar + "Open full profile" link; plain-Tailwind translate slide). Wired a per-row "peek customer" button into the Orders list (stops row-nav, opens the drawer). Reuses get_customer_summary (already proven); zero DB. Gate green (lint+typecheck+build+2179 tests). NOTE: tailwindcss-animate isn't installed → CommandPalette/Modal `animate-in` classes are dead (cosmetic, pre-existing).
- F2a: CustomerSummaryBar cards are now clickable → jump to the matching CustomerDetail tab (added optional onCardClick prop + per-card tab; renders a button when wired, div otherwise — backward compatible, existing test green). Also deferred the F1 field-invoice stretch (0 live field-app line items). Interaction-only, zero DB. Gate green (lint+typecheck+build+2179 tests).
- F1c: ⌘K palette jumps to individual Sales reports. Added a `?tab=` reader to SalesReports.tsx (mount-time, validated against the Tab union) + 4 deep-link entries in CommandPalette ALL_PAGES (Product Mix/Customer Profitability/by Rep/by Month) + getPageIcon strips `?query`. AR Aging + Commissions already reachable. Routing-only, zero DB. Gate green (lint+typecheck+build+2179 tests).
- F1b: Quotes list searchable by product. quote_items only has product_id → join to products.product_name, denormalize a `product_names` string per quote. Also fixed the latent `customer_name` searchKey (was undefined on every row) by denormalizing the customer join. Zero DB. Gate green (lint+typecheck+build+2179 tests); cross-checked 10/10 quote_items join to a product.
- F1a: Orders list searchable by product name. Reused the existing per-order order_items query (added product_name col), built a `product_names` string per order, added it to DataTable searchKeys. Zero DB. Gate green (lint+typecheck+build+2179 tests); cross-checked 277/277 order_items carry product_name (94 distinct).
- Scaffolding: PLAN.md + STATE.md + LOOP_PROMPT.md for the 5-feature v2 loop. Branch off prod db9b32ea.

## Morning summary
_(written when the loop stops)_
