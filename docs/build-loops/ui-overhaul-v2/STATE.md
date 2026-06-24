# UI Overhaul v2 — Live State

Branch: `feat/ui-overhaul-v2` (off prod `db9b32ea`) · Started 2026-06-23 · Mode: **hold-for-review** (NO deploy, NO main push)
Loop reads + updates this file every tick. `[ ]` todo · `[~]` in progress · `[x]` done (proven + committed) · `[!]` Needs Mason.

## Current focus
> F1 in progress. Orders list now searchable by product name (proven: gate green + 277/277 order_items have names). Next: Quotes list, then CommandPalette report names.

---

## F1 — Search by product everywhere  (frontend, zero DB, autonomous)
- [x] `Orders.tsx` — product-name search box (added `product_name` to the existing order_items query → searchable `product_names` field + searchKey; placeholder "Search orders or products…")
- [ ] `Quotes.tsx` — product-name search box over `quote_items`
- [ ] `CommandPalette.tsx` — add report names (AR Aging, Product Mix, Customer Profitability, Commissions)
- [ ] (stretch) `FieldInvoices.tsx`/`UnbilledApplications.tsx` — by-product filter (skip → `[!]` if it needs more than a frontend filter)

## F2 — One customer = one screen (Customer 360)  (frontend, reuses existing components)
- [ ] Read + extend `components/customers/CustomerSummaryBar.tsx` + `components/team/CustomerContextCard.tsx` (do NOT rebuild)
- [ ] `CustomerDetail.tsx` — sticky summary strip above the 8 tabs (owed · open orders · # fields · license expiry · next compliance), each clickable
- [ ] Customer 360 slide-out drawer from list rows (`Orders`, `Invoices`, `Deliveries`, `Customers`) — reuse CustomerContextCard
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

---

## Needs Mason (gated — the loop will NOT do these)
- _(none yet — populated as the loop hits gates)_

## Commit log (newest first)
- F1a: Orders list searchable by product name. Reused the existing per-order order_items query (added product_name col), built a `product_names` string per order, added it to DataTable searchKeys. Zero DB. Gate green (lint+typecheck+build+2179 tests); cross-checked 277/277 order_items carry product_name (94 distinct).
- Scaffolding: PLAN.md + STATE.md + LOOP_PROMPT.md for the 5-feature v2 loop. Branch off prod db9b32ea.

## Morning summary
_(written when the loop stops)_
