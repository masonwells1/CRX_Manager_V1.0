# Sell-Side Excellence Audit — CRX Manager V1.0

**Date:** 2026-06-10
**Scope:** Quote → Order → Delivery → Invoice → Payment (the "sell side")
**Method:** 4 phases per `docs/audits/sell-side-excellence-audit-prompt.md` — (1) code + **live-DB** ground-truth trace (every key RPC verified via `pg_get_functiondef` against the live Supabase project, not disk migrations), (2) parallel web-research subagents on 5 competitors with an adversarial source-verification pass on every load-bearing claim, (3) gap analysis, (4) ranked roadmap.
**Read-only:** no code, DB, or doc changes were made. This report is the only file created.

---

## 1. Executive Summary (plain English)

**Where CRX stands:** CRX's sell side is *operationally* excellent and *financially* bulletproof — the delivery pipeline (two-step confirm/complete with signatures, partial-delivery remainder tracking with automatic follow-ups and reminder crons, per-delivery invoicing, payment allocation with prepay credits, statements, finance charges, period close, append-only audit log) compares well with anything in ag retail. But it is missing the **two commercial constructs that define ag-retail software**: the **season booking that gets drawn down in portions over months**, and the **counter/rush sale that ships before pricing is final**. Every major competitor surveyed (Agvance, AgVantage EDGE, Merchant Ag, and the Levridge/AGRIS pattern) treats "booking with remaining balance" as a first-class object — in Agvance the invoice screen literally has a "Booking Recap" tab and growers see per-product *Remaining Quantity* on their phones [verified]. In CRX, a quote converts **whole, once** (verified against the live `convert_quote_to_order` definition), and every order-entry path requires or auto-fills a price at entry — there is no "needs pricing" state anywhere.

**The three changes that matter most:**

1. **Turn quotes into drawable bookings** (roadmap #1). "Send 200 of my 500 gallons to the north farm" should be a 30-second operation against the quote, with the quote staying open and showing 300 remaining. This is the single biggest functional gap vs. every competitor, and it's also *the* workflow of Mason's actual business.
2. **Ship-now / price-later** (roadmap #2). Anyone authorized should be able to create an order with just customer + products + quantities; reps price it later from a "needs pricing" queue; invoices physically cannot post until priced. Interesting finding from the research: **no surveyed competitor documents a true "billing blocked until priced" gate** — Agvance's unpriced delivery tickets come closest [verified] — so doing this cleanly is a genuine differentiator, not catch-up.
3. **Give the farmer something to look at** (roadmap #3). Today the quote's only customer-facing artifact is a PDF, and the "Email to Grower" button is a disabled "Coming Soon" stub (`QuoteBuilder.tsx:2497-2504`). Every competitor has a grower portal (Grower360, POCKT, MyGrower, Bushel) whose killer feature is exactly what #1 creates: the farmer seeing his own remaining booking balance instead of calling to ask. Phase it: quote email + e-acceptance first, portal later.

A bonus finding from the live-DB verification: the live `create_direct_order` has **no role gate** (any authenticated user, including a driver, can call it directly) and silently accepts missing prices as $0. That's listed in the weaknesses below and should be folded into the roadmap-#2 migration.

---

## 2. Capability Matrix

✓ = solid, ◐ = partial, ✗ = absent. Competitor claims tagged **[V]**=verified (vendor docs/help center) / **[I]**=inferred (marketing, third-party). CRX column is verified against live DB + code.

| Capability | CRX | Agvance (SSI) | AgVantage EDGE | Merchant Ag | AgWorks AgOS | Levridge / AGRIS (wildcard) | So what |
|---|---|---|---|---|---|---|---|
| Quote / proposal building | ✓ (sections, versions, compare, templates, rollover, tier + per-line override) | ✓ Field Plans as priced quotes; Sales Orders w/ Offered/Approved/Declined [V] | ✓ plan-driven quotes at price levels [V] | ◐ Quote-mode bookings; FieldAlytics quote sheet [V] | ◐ crop plans w/ optional pricing display [I] | ✓ D365 quotations [V] | CRX's internal quote builder is genuinely competitive — the gap is what happens *after* the quote. |
| **Season booking & partial draw-down** | **✗** — whole-quote, one-shot conversion (live `convert_quote_to_order`) | ✓✓ bookings w/ per-product Remaining Qty, "Book" price level auto-draw at invoicing, Booking Recap tab [V] | ✓ prepay/booking contracts from plans; partial dispatch; remaining qty in portal [V] | ✓ booking objects (fixed/Price-At-Sale/Quote modes), remaining balances [V] (draw-down detail [I]) | ◐ "shipments against grower contracts" [I] | ✓✓ D365 sales agreements: committed qty, validity window, "Max is enforced" overdraw block, returns restore balance [V]; AGRIS "Completed?" flag keeps remainder committed [V] | **The defining gap.** Universal among competitors; core of Mason's business model. |
| Fast / counter order entry | ◐ Quick Delivery modal ~30-40s, admin/sales_rep/driver, tier-price-only, **hard-blocks** on inventory | ✓ Quick Tickets POS (barcode, cash drawer); unpriced delivery tickets for warehouse [V] | ✓ Counter Invoicing module + Retail POS [V] | ◐ POS positioning, mobile order app [I] | ✗ unknown [I] | ✓ AGRIS counter w/ instant credit limits + override [V] | CRX's fastest path is decent but priced-only and brittle (inventory hard-block, commission-split config failure). |
| **Price-later / deferred pricing** | **✗** — every path requires or derives a price at entry; $0 is legal & ambiguous | ✓ unpriced delivery tickets relieve inventory w/o touching A/R; "Price Delivery" later; On-Hold blocks billing [V] | ◐ structural ship-then-bill (applied qty billed later from queues); no explicit gate [I] | ◐ "Price At Sale" booking mode (booking-level only) [V] | ✗ [I] | ◐ AGRIS prices resolve at invoicing via price schedules unless CONFIRM PRICE [V]; grain-side unpriced status only | **No competitor documents a hard "can't bill until priced" gate** — CRX can leapfrog here. |
| Prepay programs tied to bookings | ◐ prepay credits exist (dollar balance, allocation, batch apply) but tied to nothing | ✓✓ product-specific prepaid bookings, generic prepay, partial-pay/down-payments, interest, season-end rollover [V] | ✓ prepay contracts from plans; balances in portal [V] | ✓ "Booking / Prepay" combined; Remaining Prepays per booking [V] | ✗ delegated to accounting system [I] | ✓ AGRIS PP contra-asset + "honor prepay pricing at delivery" [V]; Levridge auto-assigns prepay per split member at invoicing [V] | CRX has the ledger plumbing; missing the commercial wrapper. Follows #1 naturally. |
| Invoicing models | ✓ per-delivery (delivered qty), invoice-from-order, blend-ticket multi-customer groups, credit memos, statements, finance charges | ✓ ticket consolidation into one invoice; split billing; budget billing [V] | ✓ batch/consolidated; statements/email [V] | ◐ statements + invoices in portal [V]; consolidation [I] | ◐ pre-invoices exported to accounting [I] | ✓ AGRIS partial invoicing per line w/ remaining committed [V]; Levridge split invoices "as many ways as needed" [V] | CRX is close; missing draft-invoice consolidation (multiple per-delivery drafts pile up per order). |
| Grower portal / e-signature | **✗** — PDF only; "Email to Grower" disabled stub | ✓✓ Grower360: booking balances, online prepay payment, PKI e-sign of booking contracts [V] | ✓ POCKT: balances, remaining quantities, ACH pay [V]; eSign on grain side [V] | ◐ view-only via FieldAlytics Engage [V]; portal order entry [I]; no e-sign found | ◐ Grower Access portal, view-only [I] | ✓ MyGrower (eSign, bill pay) [V]; Bushel syncs booking balances to grower's phone [V] | Universal in the field; biggest "looks professional to the farmer" gap. |
| Split / multi-party billing | ◐ `order_line_allocations` + `order_shares` + multi-customer blend-ticket invoice groups exist (live tables/RPCs) | ✓ split arrangements at invoicing [V] | ✓ splits persist plan→order→invoice [V] | ◐ split info shown [I] | ◐ split info in portal [I] | ✓✓ Levridge per-split-member prepay+discount auto-assignment [V] | CRX already partially ahead of its weight class here. |
| Credit management | ◐ warn-only (quick delivery warns + notifies admins; proceeds) | ◐ credit limit on POS [V] | ✓ auto special pricing/credit limits at POS [V] | ◐ policy-driven counter decisions [I] | ✗ | ✓ AGRIS auto-enforced limits w/ documented supervisor override [V] | Enforce-with-override beats warn-only for non-expert staff. |
| Backorder / remainder tracking | ✓ `delivery_remainders` (pending→scheduled→fulfilled), follow-up deliveries, reminder + escalation cron — live-verified | ◐ via open bookings | ◐ open order reports [V] | ✗ | ✗ | ✓ AGRIS remaining committed qty [V] | CRX **wins** here at the delivery level — the audit prompt's "known absent: backorder tracking" undersold this. |

---

## 3. Gap Findings (vs. the field)

### G1 — No booking / partial draw-down construct `[impact High][effort M][risk Med]`
**Evidence (live DB):** `convert_quote_to_order` (live definition pulled 2026-06-10) processes **all** `quote_items` for the quote, has no line/quantity parameters, sets the quote `accepted`, deactivates **all** its `inventory_holds`, and on a second call returns `already_converted` with the existing order. `quote_items` has no draw-down column (live schema: no `quantity_converted`/`quantity_drawn`). The UI sends only `p_quote_id` (`QuoteBuilder.tsx:1246`).
**Why it matters:** This is Mason's actual sales motion — a farmer books a season and calls in portions. Today the workaround is converting the whole quote up front (prebooks the entire season's inventory and creates one giant order) or re-keying each call-in as a direct order (losing the booking price linkage and any record of what remains). Both are wrong.
**Competitor reference:** Agvance per-product Remaining Quantity + "Book" price level at invoicing [verified]; Levridge/D365 "Max is enforced" commitment cap, fulfilled agreements unselectable, returns restore the balance [verified]; AGRIS "Completed?" Y/N keeps remainder committed across many invoices [verified].
→ **Roadmap #1.**

### G2 — No price-later state anywhere in the pipeline `[impact High][effort M][risk Med]`
**Evidence (live DB):** `create_direct_order` COALESCEs a missing `price_per_unit` to **0** and creates the order silently (live def) — the "price is mandatory" rule lives only in the NewOrder form (`NewOrder.tsx:590-628`). `create_quick_delivery` ignores client prices entirely and prices from the customer's tier (live def). `post_invoice` (live def) checks period, status, and order-not-cancelled — but happily posts a $0 invoice. There is no flag distinguishing "deliberately free" from "not priced yet," no queue, no gate.
**Why it matters:** Orders ship within the hour, taken by whoever answers the phone. Today that person must either invent prices, accept tier prices that may not reflect the deal, or hand the call to a rep. A $0-line order created under pressure is indistinguishable from a free giveaway and can flow all the way to a posted $0 invoice.
**Competitor reference:** Agvance delivery tickets ship unpriced without touching A/R and are priced later ("Price Delivery"), with On-Hold blocking billing [verified]; Merchant Ag "Price At Sale" booking mode [verified]; an explicit *billing-blocked-until-priced* gate is documented **nowhere** in the surveyed field — differentiation opportunity.
→ **Roadmap #2.**

### G3 — No customer-facing quote artifact beyond a PDF; no portal, no e-sign `[impact High][effort S→L staged][risk Low]`
**Evidence:** "Email to Grower" button is `disabled title="Coming Soon"` (`QuoteBuilder.tsx:2497-2504`). No portal routes, no public quote URL, no signature capture on quotes (exploration sweep). Acceptance is recorded by staff clicking Convert — the farmer never formally accepts anything.
**Why it matters:** Every competitor's growers can see balances and (in Agvance/AGRIS-MyGrower) e-sign booking contracts and pay online [verified]. Once #1 exists, the highest-value portal feature is "your remaining booking balance" — which kills the "how much do I have left?" call and is exactly what Grower360/Bushel ship [verified].
→ **Roadmap #3 (staged: email + e-accept first, portal later).**

### G4 — Prepay credits are not connected to bookings or pricing `[impact Med][effort M][risk Med]`
**Evidence:** CRX prepay (`prepay_applications`, allocation page, batch apply RPCs) is a pure dollar balance applied to invoices. There is no link from a prepayment to a quote/booking, no locked "prepay price," no season-end booking settlement view.
**Why it matters:** Season bookings in ag retail are usually *prepaid* bookings — the discount is why farmers commit early. Competitors treat prepay+booking as one subsystem (Agvance "Prepay & Bookings" category; Merchant "Booking / Prepay" tool; AGRIS PP contra-asset honored at delivery — all [verified]).
→ **Roadmap #6 (after #1 lands).**

### G5 — Credit limits warn but never enforce `[impact Med][effort S][risk Low]`
**Evidence (live DB):** `create_quick_delivery` computes projected AR exposure, then logs a warning + notifies admins and **proceeds** (live def: "Delivery proceeded; review with finance"). `create_direct_order` and `convert_quote_to_order` don't check at all server-side (client does a post-creation warning, `NewOrder.tsx:376-390`).
**Why it matters:** Non-experts in the hot path. AGRIS's pattern — auto-enforce with a documented supervisor-override prompt [verified] — is strictly better for warehouse-staffed order entry: the override produces an audit trail and a deliberate decision instead of a notification nobody reads at 5pm.
→ **Roadmap #7.**

---

## 4. Weakness Findings (on what exists today)

### W1 — Live `create_direct_order` has no role gate and silently accepts $0 prices `[impact High][effort S][risk Low]` *(new issue found during verification — not part of the hardened-RPC re-audit)*
**Evidence (live DB):** the live definition checks `auth.uid()` and actor-mismatch only — **no** `INSUFFICIENT_ROLE` / `is_admin()` / `is_sales_rep()` check (contrast: `convert_quote_to_order`, `create_quick_delivery`, `create_invoice_from_order`, `post_invoice`, `update_order_items` all gate roles in their live defs). It also `COALESCE`s missing `price_per_unit`/`unit_cost` to 0. So any authenticated `driver`/`applicator` can create confirmed orders (with inventory prebooks + commission rows) by calling the RPC directly, and any malformed item array creates $0 lines. The June-9 actor-forgery sweeps didn't catch it because it *does* reference `auth.uid()` — the sweep criterion — it just never checks the role. UI route is admin/sales_rep (`App.tsx:178`), so this is RPC-direct exposure only.
**Recommendation:** add the canonical role gate (and, with roadmap #2, make the $0-price ambiguity explicit via `pricing_pending`). One-line-class fix; fold into the #2 migration or ship immediately via `/ship`.

### W2 — Orders lock against item edits after the first partial delivery `[impact High][effort S/M][risk Med]`
**Evidence (live DB + code):** `update_order_items` live guard: `IF v_order.status NOT IN ('confirmed','pending') THEN RAISE 'Cannot edit order in status: %'` — and `'pending'` isn't even a legal status (live CHECK: `confirmed/partially_fulfilled/fulfilled/cancelled/voided`), so the guard is effectively *confirmed-only*. UI mirrors this (`OrderDetail.tsx:118`). Once `complete_delivery` flips the order to `partially_fulfilled`, remaining quantities and prices are frozen.
**Why it matters:** Season-long orders get adjusted mid-stream constantly ("make the last 100 gallons 80"). Today the only path is cancel-and-rebuild. This also directly blocks roadmap #2's "price it after it shipped" unless pricing gets its own RPC (it does, in the spec below).

### W3 — The quote lifecycle has dead statuses and a dead expiration `[impact Med][effort S][risk Low]`
**Evidence:** `declined` and `cancelled` exist in the CHECK constraint, types (`types/index.ts:139`), badges and list filters (`Quotes.tsx:322`) — but **no UI action sets them** (grep: only the CSV bulk-import path can carry `declined`). `auto_expire_quotes` exists in the DB but is **not scheduled** — live `cron.job` has exactly three jobs (`mark-overdue-invoices`, `release-expired-quote-holds`, `check-remainder-reminders`), so `expired` is never set automatically and expired quotes show no visual indicator (`Quotes.tsx:229-232`). Hold release does work daily via `release_expired_quote_holds`.
**Why it matters:** Pipeline reporting (win/loss, planned-program load) is fiction if quotes can only ever be draft/sent/revised/accepted. For the booking model (#1), "still open" vs. "dead" must be trustworthy.

### W4 — A wrong conversion is unrecoverable from the UI `[impact Med][effort S][risk Low]`
**Evidence:** `accepted` is terminal in practice: `cancel_order` (live def) releases inventory and zeroes commissions but never touches the quote; `revert_quote_status` exists (strict-actor hardened 2026-06-09) but has **zero frontend callers** (grep: tests only). Convert the wrong quote → cancel the order → the quote sits `accepted` forever, holds gone, unconvertible.
**Why it matters:** with #1, draws will happen many times per quote — reversal symmetry stops being an edge case.

### W5 — Two competing invoice paths per order can disagree `[impact Med][effort M][risk Med]`
**Evidence:** `create_invoice_from_order` (live def) invoices **ordered** quantities (`total_units_needed`) and blocks only if an active invoice exists; `complete_delivery` (live: `inserts_invoice = true`) auto-creates per-delivery draft invoices for **delivered** quantities. The OrderDetail gate warns on *pending* deliveries only (`OrderDetail.tsx:699-703`) — create the order invoice first, schedule a delivery after, and the order is double-represented; conversely multiple partial deliveries pile up multiple draft invoices each needing individual posting, with no consolidation or "post all drafts" action (exploration finding, Phase-1 map).
**Why it matters:** This is the #1 way a small-staff shop produces AR that doesn't match what shipped.
**Competitor reference:** Agvance's "Invoice from Tickets" consolidates many tickets into one invoice [verified].

### W6 — The fastest path is the most brittle under rush conditions `[impact Med][effort S][risk Low]`
**Evidence (live def of `create_quick_delivery`):** (a) hard `RAISE EXCEPTION` on insufficient *net available* inventory — the only order path that hard-blocks (others warn) — so a lagging inventory record stops a 5pm rush sale cold; (b) hard failure if the customer's commission splits don't sum to 100 ("Fix customer settings before creating delivery") — a config error surfaced to exactly the person who can't fix it; (c) `$0 total` blocked client-side (`QuickDeliveryModal.tsx:224`), which is correct today but collides with price-later until #2's flag exists.

### W7 — `convert_quote_to_order` has no status guard of its own `[impact Low][effort S][risk Low]`
**Evidence (live def):** other than the `accepted`→already-converted path, it converts a quote in **any** status — draft, declined, expired, even cancelled — wrapping the status write in `app.admin_override`. The UI only offers Convert at `sent` (`QuoteBuilder.tsx:235`), so exposure is direct-RPC misuse and future-UI drift. Fold a `status IN ('sent','revised'[,'booked'])` guard into the #1 migration, which rewrites this function anyway.

*(Minor/parked weaknesses in Appendix C.)*

---

## 5. Ranked Roadmap with Spec Sketches

> Order: #1 and #2 are pre-decided anchors (deepest specs). #3–#7 ranked by impact for Mason's business. Every item states how it preserves the money invariants (bigint cents where money is stored as cents, append-only `financial_audit_log`, idempotency, `check_period_open`, canonical strict-actor). All DB work goes through the normal gate: `/ship` → parallel reviewers → proof file → MCP apply → rolled-back smoke test.

---

### #1 — Quote as Season Booking: partial line/quantity draw-down `[impact High][effort M][risk Med]`

**User story (Mason's words):** *"I quote Jim 500 gallons of herbicide and 40 tons of dry fertilizer for the season in March. June 3rd he calls: 'send 200 gallons to the north farm.' Whoever takes the call opens Jim's quote, sees 500 booked / 0 taken, types 200 on that line, clicks Create Order. The quote stays open showing 300 left until he calls again — all season, at the price we shook hands on in March."*

**Design model (the verified competitor consensus, adapted to CRX):** a booking is a commitment object carrying *quantity, locked price, validity window*; orders link to it and pull its price; remaining decrements as draws happen; overdraw is structurally impossible; reversals restore the balance. (Levridge "Max is enforced" + returns-restore [verified]; Agvance "Book" price level [verified]; AGRIS remainder-stays-committed [verified].)

**Data model (1 migration):**
- `quote_items` **+** `quantity_drawn numeric NOT NULL DEFAULT 0 CHECK (quantity_drawn >= 0)`. Remaining = `COALESCE(total_units_needed,0) - quantity_drawn`; the `<= total_units_needed` cap is enforced in the RPC under `FOR UPDATE` (not a CHECK, because legitimate qty edits on the quote must stay possible while undrawn).
- `quotes` **+** status value `'booked'` — **superset rewrite** of `quotes_status_check` (all 7 existing values + `booked`; migration-drift rule) and matching updates to the quote status-enforcer trigger: `sent/revised → booked` (first draw), `booked → booked` (repeat draws), `booked → accepted` (fully drawn — terminal, reuses existing semantics), `booked → expired/cancelled` (close-out; existing hold-release trigger already fires on `declined/expired/cancelled` — verify it treats `booked→…` transitions). UI: new Badge variant, Quotes-list filter, progress bar (drawn/total per quote).
- `orders`: **no schema change** — `orders.quote_id` already has a plain non-unique index (live-verified), so many orders per quote are schema-legal today; the one-order limit is purely RPC logic.

**New RPC `draw_down_quote(p_quote_id uuid, p_draws jsonb, p_performed_by uuid, p_idempotency_key text)`** — `p_draws = [{quote_item_id, quantity}]`:
1. Canonical strict-actor block; role `IN ('admin','sales_rep')`; `check_idempotency` before any mutation.
2. `SELECT … FOR UPDATE` on the quote **and** its drawn `quote_items` (concurrency: two simultaneous call-ins can't overdraw).
3. Validate: status `IN ('sent','revised','booked')`; each `quantity > 0` and `<= remaining`; reject with machine tokens (`BOOKING_OVERDRAWN`, `BOOKING_CLOSED`) registered in `RpcErrorCodes` (`src/lib/db.ts`).
4. Create the order + `order_items` exactly as `convert_quote_to_order` does today (same columns; `order_items.quote_item_id` already links back), **but only for the drawn lines/quantities**, at the **quote line's locked price** (`price_per_unit` incl. `price_override`) — never the current tier price. This is the "honor booking price at delivery" pattern [verified, Agvance/AGRIS].
5. Inventory: increment `inventory.quantity_prebooked` by drawn qty + `'booked'` `inventory_transactions` rows (as today); **if** the quote has active `inventory_holds` (planned programs), decrement `inventory_holds.quantity` by the drawn amount (floor 0, `is_active=false` at 0) instead of today's release-everything. Net Free = available − holds − prebooked stays exactly constant through a draw — that invariant is the smoke-test assertion.
6. `quote_items.quantity_drawn += quantity`; quote status per the transition rules above.
7. Commissions: `_insert_commissions_for_order` on the **drawn order's** profit (sum over draws ≈ whole-quote commission; dollars-numeric like the rest of the order side).
8. `financial_audit_log` (`'quote_drawn_down'`, entity order, `total_impact_cents = ROUND(order_total*100)::bigint`, old/new drawn quantities in `new_values`) + `activity_feed`. **Note:** `'quote_drawn_down'`/entity values must be added to the `financial_audit_log` entity/operation CHECKs as a superset (the exact constraint that silently broke two RPCs on 2026-06-09).
9. `save_idempotency`; return `{order_id, order_number, lines: [{quote_item_id, drawn, remaining}]}`; UI wraps with `assertRpcResult`.

**Legacy path:** rewrite `convert_quote_to_order` to delegate to `draw_down_quote` with "all remaining on all lines" (one body, no drift), and add the W7 status guard while in there. Check overloads before `CREATE OR REPLACE`.

**UI:** QuoteBuilder/Quote detail gets a **"Create Order from Booking"** modal — one row per line: booked / taken / remaining / qty input (default = remaining), "take all" checkbox; under a minute for a non-salesman. Quotes list: drawn-progress indicator + `booked` filter. OrderDetail: "drawn from quote Q-123 (draw 2 of n)".

**Hard edges (decide explicitly, don't discover in prod):**
- *Holds vs. draw-down:* only planned quotes have holds. Draws must work with or without holds (step 5 is conditional). A booked quote whose holds expired (needed_by + 14d, daily cron) keeps drawing — it just prebooks from the floor. Surface "hold expired" on the quote so reps know the reservation lapsed.
- *Tier price changes mid-season:* draws always use the quote line price. Repricing a booking = quote revision (existing `create_quote_version` flow) — which only affects **future** draws. State this in the UI ("booking price locked 2026-03-12").
- *Expiry/season end:* booked quotes with `quantity_drawn > 0` must be **excluded** from any future auto-expire wiring (W3); add an explicit "Close booking" action (→ `cancelled` or `accepted`-as-is) that releases remaining holds and freezes remaining quantity, logged to the audit trail.
- *Partial draw + cancel/void:* stage 2 — `cancel_order` on a draw-order, when the source quote is still `booked`, decrements `quantity_drawn` by the order's **undelivered** quantity (delivered product stays drawn) and restores the hold if one is active. This mirrors D365's returns-restore-commitment [verified] and closes W4 for draws.
- *Who may draw:* admin/sales_rep at v1 (prices are locked, so this is operationally safe to widen later alongside #2's role work).
- *Reporting:* "open bookings by product" view (booked − drawn, per product) feeds inventory planning — the Agvance "Bookings by product" report shape.

**Money invariants:** prices locked at quote time (numeric dollars on the quote/order side, exactly as today); cents enter at invoicing unchanged; every draw is one `financial_audit_log` row; idempotent; strict-actor; period close untouched (orders aren't period-gated; invoices still are).

**Effort/risk:** **M** — 1 migration (column + 2 CHECK supersets + enforcer trigger), 1 new RPC + 1 rewrite, 1 modal + list chrome. Risk Med: status-enforcer changes and the legacy-RPC rewrite are the danger zones — both get the full review gate + rolled-back end-to-end smoke test (draw → draw → over-draw rejected → cancel-order restore).
**Stages:** v1 = column + RPC + modal + progress UI (no new status — quotes stay `sent` while partially drawn; smallest reviewable slice). v2 = `booked` status + enforcer + filters. v3 = cancel-restore + close-booking + open-bookings report.

---

### #2 — Ship-Now / Price-Later `[impact High][effort M/L][risk Med]`

**User story:** *"4:40pm, a farmer needs 30 jugs before 6. Dave in the warehouse takes the call. He opens Rush Order, picks the customer, adds 30 jugs — no prices anywhere on his screen — and hits Create. The truck leaves at 5:15. Next morning Sarah sees 'Needs pricing (1)', opens it, sets the price (the tier price is pre-suggested), and only then can the invoice post."*

**Data model (1 migration):**
- `orders` **+** `pricing_status text NOT NULL DEFAULT 'priced' CHECK (pricing_status IN ('priced','needs_pricing'))`.
- `order_items` **+** `pricing_pending boolean NOT NULL DEFAULT false` — this kills the $0-ambiguity (G2/W1): `price_per_unit = 0 AND pricing_pending` = not priced yet; `= 0 AND NOT pending` = deliberately free.
- `invoices` **+** `pricing_pending boolean NOT NULL DEFAULT false` (denormalized for the post-gate + list badges; the gate also re-derives via join as a backstop).
- Roles: **v1 reuses `driver`** (already trusted to create quick deliveries in the live def) and `applicator`; adding a real `warehouse` role is a separate, bigger change (`profiles_role_check` superset + RLS helper audit) — defer until Mason actually hires non-driver warehouse staff.

**New RPC `create_rush_order(p_customer_id, p_items jsonb, p_notes, p_performed_by, p_idempotency_key)`** — items are `{product_id, quantity}` only:
1. Strict-actor; roles `('admin','sales_rep','driver','applicator')`; idempotency.
2. Creates order (`status='confirmed'`, `pricing_status='needs_pricing'`) + items with `price_per_unit=0, pricing_pending=true`, totals 0; snapshots the would-be tier price into `order_items.notes` (or a `suggested_price` column) so the pricer sees what the system would have charged.
3. Inventory prebook + `'booked'` transactions exactly like `create_direct_order`; **inventory shortfall warns, never blocks** (rush reality — unlike quick delivery's hard block, W6).
4. **No commissions yet** (profit is unknowable; inserting $0 rows now and fixing later is the bug factory).
5. `financial_audit_log` (`'order_created'`, impact 0, `needs_pricing: true`) + `activity_feed` + notification rows to active sales_reps/admins (existing `notifications` table — same mechanism quick-delivery credit warnings use).
6. While in this migration: **add the missing role gate to `create_direct_order` (W1)**.

**New RPC `price_order(p_order_id, p_items jsonb, p_performed_by, p_idempotency_key)`** — `{order_item_id, price_per_unit}`; admin/sales_rep only:
1. Strict-actor; `FOR UPDATE` order + items; idempotency.
2. Deliberately **ignores the W2 fulfillment lock** — pricing is legal at any fulfillment status (`confirmed`/`partially_fulfilled`/`fulfilled`) because it touches *only* price/profit fields, never quantities. (This is why pricing is its own RPC and not a mode of `update_order_items`.)
3. Sets prices, recomputes line + order totals/profit/margin; when no `pricing_pending` lines remain → `pricing_status='priced'`, **then**: insert commissions on final profit; sweep linked **draft/unposted** invoices — update their `invoice_items.unit_price_cents/extended_cents` from the new prices, recompute `total_amount_cents`, set `invoice_date = CURRENT_DATE`, clear `pricing_pending`. (Posted invoices can't exist yet — the gate below guarantees it.)
4. `financial_audit_log` (`'order_priced'`, impact = new total cents, old/new prices in `old_values/new_values`).

**The gate (the differentiator):** `post_invoice` and `post_invoice_group` add, before the period check: `IF v_inv.pricing_pending OR EXISTS (SELECT 1 FROM invoice_items ii JOIN order_items oi ON oi.id = ii.order_item_id WHERE ii.invoice_id = p_invoice_id AND oi.pricing_pending) THEN RAISE 'PRICING_INCOMPLETE'`. Token registered in `RpcErrorCodes`; the toast deep-links to the pricing screen. Invoice **creation** stays allowed (drafts inherit the pending flag) so the warehouse flow never stalls — only **posting** is blocked. Delivery flow untouched (deliveries are quantity-only).

**Queue UX:** Orders list filter `pricing_status='needs_pricing'` + a nav badge count (the `delivery_remainders` reminder pattern, which already works); pricing screen = OrderDetail with price-only inputs for pending lines, tier suggestion shown beside each.

**Hard edges (flagged per the brief):**
- *Unpriced orders aging out:* add `check_unpriced_orders` to the daily cron set (mirror `check_remainder_reminders`: nudge at 48h, escalate at 7d). Month-end close gains a hard checklist line: **0 `needs_pricing` orders** before closing the period (MonthEndClose page) — otherwise revenue silently slides a month.
- *Period close:* invoices get `invoice_date` refreshed at pricing time (step 3), so a rush order shipped June 30 and priced July 2 posts into July cleanly; `check_period_open` still rules at post, unchanged. If Mason wants ship-month revenue instead, that's an accounting policy decision to make explicitly — flag, don't guess.
- *Credit exposure understated:* a $0 draft is invisible to the credit check in `create_quick_delivery`'s AR sum. Mitigation: pricing queue shows per-customer unpriced order count; v2 can add estimated-tier-value to the credit projection.
- *Tier drift between ship and price:* pricer sees ship date + today's tier price side by side; the price chosen is theirs — that's the point of the feature.
- *Inventory effects:* prebooked at rush entry exactly like any order; cancel of an unpriced order releases it (no commissions exist to unwind — by design).
- *Double-pricing race:* `FOR UPDATE` + idempotency + `pricing_status` re-check.

**Money invariants:** money enters only at `price_order` (numeric dollars order-side, cents at invoice rows — unchanged conventions); commissions only on priced profit; every state change audited; posting gated by both `PRICING_INCOMPLETE` and `check_period_open`; strict-actor everywhere; idempotent everywhere.

**Effort/risk:** **M/L**. Risk Med — touches `post_invoice` (money-critical, full review gate + Codex-worthy) and adds two RPCs.
**Stages:** v1 (S/M) = columns + `create_rush_order` + post-gate + list filter (shippable alone: rush orders exist, can't mispost). v2 = `price_order` with invoice sync + deferred commissions + pricing screen. v3 = aging cron + month-end checklist + credit-exposure surfacing.

---

### #3 — Quote → farmer: email, e-acceptance, then portal `[impact High][effort S→L staged][risk Low]`
**What:** Stage A (S): wire the dead "Email to Grower" button to the existing `send-email` Edge Function (quote PDF attached — both already exist), log to `email_log`. Stage B (M): tokenized public quote-view page (RLS-safe: signed UUID link, read-only render, Accept/Decline buttons writing through a narrow SECDEF RPC that sets `accepted`-pending-staff-confirmation or `declined` — which also fixes W3's unreachable `declined`). Stage C (L): grower portal with booking balances (#1's data), invoices, statements, and online payment — the Grower360/POCKT/MyGrower pattern [verified].
**Why:** every competitor has this; for Mason it converts the quote from an internal note into a sales instrument, and Stage B gives `declined` a real source. Money invariants: untouched in A/B (read-only artifacts + status writes through gated RPC).

### #4 — Order billing cockpit: consolidate drafts, post in one step `[impact Med][effort M][risk Med]`
**What:** on OrderDetail, a billing panel listing all invoices for the order with one action: "Consolidate drafts" (new RPC merges draft per-delivery invoices into one — Agvance "Invoice from Tickets" pattern [verified]) and "Post all drafts" (loops `post_invoice` under one idempotency scope). Guard rails from W5: block `create_invoice_from_order` when **any** non-cancelled delivery exists (today it only checks pending), pushing everything to the per-delivery path.
**Why:** kills the multiple-stale-drafts problem and the ordered-vs-delivered double-representation. Money: consolidation is draft-only (period/audit untouched until post), idempotent, audited.

### #5 — Unstick the quote lifecycle `[impact Med][effort S][risk Low]`
**What:** Decline + Cancel buttons on the quote (existing statuses; hold-release trigger already handles them); wire `revert_quote_status` (already hardened, zero UI callers) to an admin "Un-accept" action fixing W4; decide auto-expire: either schedule `auto_expire_quotes` (it was hardened to `sent/revised`-only on 2026-06-08, but is **not cron'd** — verified) with #1's booked-quotes exclusion, or delete it; expired/declined visual badges in the list.
**Why:** booking truth (#1) and pipeline reporting both depend on statuses meaning something.

### #6 — Prepay-backed bookings `[impact Med][effort M/L][risk Med]`
**What:** after #1: link prepayments to a booking quote (`prepayments.quote_id` or a join table); a draw's invoice auto-applies that booking's prepay first (extend the existing auto/batch prepay application — the plumbing exists); booking settlement view (booked / drawn / prepaid / remaining $ and qty); season-end report for rollover decisions (Agvance season-end model [verified]).
**Why:** this is how the booking discount is actually funded in ag retail; CRX has the ledger, it just isn't aimed at bookings.

### #7 — Credit limits: enforce-with-override `[impact Med][effort S][risk Low]`
**What:** in order-creating RPCs, when projected exposure exceeds the limit: block with `CREDIT_LIMIT_EXCEEDED` unless `p_credit_override = true` (admin/sales_rep only), which proceeds and writes the override + actor to `financial_audit_log`. UI: ConfirmModal with the numbers. (AGRIS supervisor-override pattern [verified].) Keep quick-delivery's warn behavior for `driver` role or block-with-callback — Mason's call.
**Why:** warn-only protects nobody at 5pm; enforce-without-override stops rush sales. Override-with-audit is the proven middle.

---

## 6. Appendix

### A. Phase-1 flow map (verified 2026-06-10: live DB defs + code exploration)

**Entry points that create an order:**
| Path | UI | RPC (live-verified) | Roles (route / RPC) | Price at entry | Inventory effect |
|---|---|---|---|---|---|
| Quote conversion | `QuoteBuilder.tsx:1246` ("Convert", only at `sent`, `:235`) | `convert_quote_to_order` — whole quote, no line/qty params; quote→`accepted`; holds deactivated; warns (not blocks) on shortfall | admin/sales_rep / admin+sales_rep | locked from quote lines | prebook full quote |
| Direct order | `NewOrder.tsx` (`/orders/new`, `App.tsx:178`) | `create_direct_order` — **no role gate live (W1)**; price COALESCE→0 | admin/sales_rep / **any authenticated** | required by form only | prebook |
| Quick delivery | `QuickDeliveryModal.tsx` | `create_quick_delivery` — atomic order+delivery+draft invoice; tier price only (client price ignored); **hard-blocks** on net-available; credit warn-only; splits-sum-100 hard fail | admin/sales_rep/driver (both) | server tier price | prebook + hard gate |
| Blend ticket → order | `BlendTicketDetail.tsx:639-665` | `create_order_from_blend_ticket` (strict-actor, 2026-06-09) | admin/sales_rep | from ticket | prebook |

**Entry points that create an invoice:** per-delivery auto-invoice inside `complete_delivery` (delivered qty; live: `inserts_invoice=true`); `create_invoice_from_delivery` (delivered qty; one non-cancelled invoice per delivery; admin/sales_rep; declares but never uses its idempotency key — parked C3); `create_invoice_from_order` (**ordered** qty; one active invoice per order); `create_invoice_from_blend_ticket` (multi-customer groups); `transfer_job_to_invoice`; `save_field_app_invoice`; manual `save_invoice` (**requires** `order_id` or `blend_ticket_id` on new — live-verified guard, the red line holds); admin backfill `create_invoice_for_unbilled_delivery` (`IntegrityCleanup.tsx`).

**Lifecycle reality (live CHECKs + cron):** Quote `draft→sent⇄revised→accepted` working; `declined`/`cancelled` unreachable in UI; `expired` never auto-set (cron jobs: `mark-overdue-invoices` 06:00, `release-expired-quote-holds` 06:15, `check-remainder-reminders` 06:30 — **no** quote-expire job). Order `confirmed→partially_fulfilled→fulfilled` set by `complete_delivery`; items editable only at `confirmed` (live guard incl. dead `'pending'` branch). Delivery `scheduled→in_progress→completed` with signature; shortfalls create `delivery_remainders` (`pending→scheduled→fulfilled/cancelled`) + follow-up deliveries + reminder cron — genuine backorder tracking at delivery level. Invoice `draft→(unposted)→posted→paid/overdue` with `check_period_open` at post; `allocate_payment` also period-checked; payment allocation page admin+sales_rep with oldest-first auto-allocate, over-allocation rejected server-side, excess → prepay.

**Today's behavior in Mason's two scenarios (the exact failures):**
1. *"Send 200 of my 500 gallons":* no path. Options are (a) convert the whole 500-gal quote → one order prebooking the full season, then portion via partial deliveries — works mechanically but the order locks against edits after the first delivery (W2), AR derives from invoice timing, and nothing shows "300 left on the booking"; or (b) key a fresh 200-gal direct order — loses booking price linkage, no remaining-balance anywhere, quote eventually goes stale (W3).
2. *Unpriced rush order:* NewOrder requires prices (form) and is admin/sales_rep (route); Quick Delivery works for a driver but **only** at tier price, hard-blocks on inventory lag, and fails on commission-split misconfig (W6). A true "ship it now, price tomorrow" entry does not exist; the nearest server-side behavior is the W1 hole (price silently 0).

### B. Competitor research method + source list
5 parallel research agents (one per competitor + wildcard) using vendor docs first, then marketing/third-party; followed by 5 adversarial verification agents that re-fetched cited sources for every claim in the two anchor areas plus every verified-yes claim. Verdicts: Agvance 23 confirmed / 5 downgraded / 1 refuted; AgVantage EDGE 32/2/1; Merchant Ag 17/1/1; AgWorks 14/1/0; Levridge+AGRIS ~23 checks, 2 downgraded, 1 refuted (a release-date attribution). Downgraded/refuted claims are tagged [inferred] or corrected above. **Vendor correction:** AgWorks LLC is owned by The McGregor Company (since 2012), not EFC Systems/Ever.Ag as the audit prompt assumed; EFC/Ever.Ag's retail ERP is Merchant Ag.

Primary [verified] sources (full URL lists live in the per-claim citations above):
- **Agvance (SSI):** helpcenter.agvance.net — `prepay-bookings`, `add-invoice` (Booking Recap, Book/Paid levels), `add-delivery-ticket` (unpriced tickets, Price Delivery, Loaded/On-Hold), `quick-tickets`, `booking-contract-signatures` (PKI e-sign), `invoice-from-tickets-process`, `finance-charges`; agvancehelpcenter.knowledgeowl.com `grower360-bookings` (Remaining Quantity, open/filled filters). [inferred]: Grower360 unpriced-ticket PDFs (marketing blog, TLS-blocked).
- **AgVantage EDGE:** agvantage.com product pages (`agronomy`, `accounting`, `pockt`, `retail`, `ebusiness`), 2022 National Conference agenda PDF (plan→prepay/booking import sessions), newsletters, manuals index (Counter Invoicing, "Entering a Prepay Contract"), Barchart eSign announcement. [inferred]: work orders drawing booking *price* (only plan-discount tracking is documented); price-later (structural, not explicit).
- **Merchant Ag (EFC/Ever.Ag):** help.fieldalytics.com articles `1123-bookings` (pricing modes incl. Price At Sale), `1131-merchant-bookings-from-farm-plans`, `764-fieldalytics-engage` (view-only grower access, Remaining Prepays), `238-merchant-ag`, `1127-merchant-live-product-pricing`; ever.ag/agribusiness/merchant-ag [marketing→inferred where noted]; note: merchanthelp.efcsystems.com is publicly reachable (found during verification).
- **AgWorks AgOS:** agworks.net/agos + directory mirrors (sourceforge/environmental-expert) — operations layer; billing delegated to 12+ accounting interfaces. Mostly [inferred] (no public help center).
- **Levridge / Greenstone AGRIS (wildcard):** learn.microsoft.com D365 `sales-agreements` (commitment, Max is enforced, returns restore); levridge.com `consuming-sales-contracts-from-sales-orders`, `solutions/ag-sales` (splits), credit-and-rebill article, Bushel partnership + 2025 R1 release (booking sync to grower app); greenstonesystems.com `retail-solutions` (honor prepay pricing at delivery, auto-enforce credit limits), `mygrower` (eSign, bill pay); culturatech.atlassian.net AGRIS docs (`Creating an Invoice - Invoice a Sales Order` "Completed?" flag, credit-limit override procedure, AR statements, budget billing). Corrected during verification: the Levridge prepay-for-charges/tax feature is from the Jan-2024 R2 release, not 2025 R2; its application is manual.

### C. Parked minor findings
1. `create_invoice_from_delivery` declares `p_idempotency_key` but never reads/writes `idempotency_keys` (live def) — the AW-1 class; mostly mitigated by its one-invoice-per-delivery guard.
2. Same RPC computes line cost as `v_cost * v_qty::bigint` — fractional delivered quantities truncate the **cost** (margin reporting only; price/extended are correct).
3. `update_order_items` allows status `'pending'` which isn't a legal order status (dead branch; tidy when touching the function for #2).
4. Two parallel split mechanisms exist (`order_line_allocations` + `update_allocation_set` vs. `order_shares` UI inserts) — consolidate before building portal split views.
5. OrderDetail's "Toggle Planned/Committed" uses a direct table update, not an RPC (`OrderDetail.tsx:453`) — odd one out in an RPC-everything codebase.
6. Quick-delivery's credit-warning notification fan-out inserts one `notifications` row per admin inside the transaction — fine at current scale.
7. Offline-queued `complete_delivery` calls don't auto-retry on reconnect (exploration finding) — drivers must re-trigger.
8. `auto_expire_quotes` exists, hardened, and unscheduled — either cron it (with #1's booked exclusion) or drop it (tracked in #5).
9. Exploration agents' claim that "manual invoices can be orphaned" was **refuted** during live verification — `save_invoice` raises unless `order_id` or `blend_ticket_id` is present on new invoices; recorded here so the next audit doesn't re-chase it.
