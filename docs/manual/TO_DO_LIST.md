# CRX Manager To-Do List

**What this is:** the one list of work still to finish in the app, in the order Mason approved. It's built around the 2027-01-01 start of CRX-only billing ("day one"), but it stays the working to-do list after that. Approved by Mason, 2026-10-22.

**How to keep it current:** when an item ships, update its "Today" cell with the PR and date. When Mason changes a priority, change the row's rank, quote him, and add a `docs/manual/DECISION_LOG.md` entry. Add new work as a new row in the right section. The older `TODO.md` at the repository root (last updated 2026-09-27) predates this list; for order and priority, this list wins.

**Moved and renamed 2026-10-22** (Mason: "rename this ... like future to do list"). It was `docs/plans/2026-10-21-day-one-must-work-list.md`. The same day, every still-open item from the old root `TODO.md` was checked against the code and folded in (Mason: "yes fold it all in"). Rows that came from it say "old `TODO.md`".

**Owner:** Mason Wells approves. **Drafted:** 2026-10-21 by Claude, as asked in `docs/plans/2026-10-13-direction-and-goals.md` section 2 ("must work on day one" list, checkpoint 2026-10-31).
**Reviewed:** an advisory Codex `gpt-6-sol` (high) review of the first draft, 2026-10-21. It made 57 findings. Claude checked each against the goals doc and the code. Most were applied; the few that weren't are listed at the end, with the reason.
**Status:** APPROVED. Mason, in chat, 2026-10-22: "Approve the revised day-one list. Yes, un-park the small cost-freshness part (as-of date and stale-cost report). Names: not chosen yet." That approves the ranking rule, every rank and the build order. The open items in "What Mason needs to decide" stay open until answered. The list was revised with Mason's changes of 2026-10-22 before he approved it. Everything before delivery comes first: quoting, product pricing, cost tracking, inventory (knowing what to order) and invoicing. Field-app, job and blend-ticket invoices are built last. Returns, including "sitting at farm" tracking, can wait. Jobs can have two applicators. Rep-only rules wait because there are no regular reps yet. Nothing here authorizes building anything. Each item is built through its own goal and pull request.
**Evidence date:** every "today" status was checked against `main` at `b92d6f19a` and the open PR list on 2026-10-23. It was first checked at `e0b5d4234` on 2026-10-21, refreshed at `d720cf681` and `13f83434d` on 2026-10-22, and refreshed again on 2026-10-23 against the 34 changes merged between `13f83434d` and `b92d6f19a` (PR numbers #1006 through #1059). Rows touched in that refresh say "(2026-10-23)". Statuses go stale quickly; re-check before relying on one. "Open PR" means written and in review, not live; "merged" is not "applied", so a row says "live" only when its migration, if any, is applied.

---

## What this list is for

On **2027-01-01** Chem Man stops billing, and every quote, order, delivery, invoice and payment runs in CRX. The first 30 days are the pilot. This list says what has to be true that morning, so the next ten weeks go to the right work.

Words used below:
- **Posting** an invoice locks it as a real bill the customer owes.
- **Retry-safe** means that if the phone loses its connection mid-save and someone taps again, nothing is saved twice or saved wrong.
- **Staging** is a separate test copy of CRX, with fake money and email, where we can try anything without touching real customers.
- **PR** is a pull request (one reviewed change to the app). A **migration** is a reviewed change to the database.

## How each item is ranked

- **MUST**: without it, January 1 risks a wrong bill, a lost record, a wrong regulated record, or a bad day we can't recover from by the next business morning. It also covers anything the goals doc makes a launch gate (the November–December trial, staging proofs, the developer's sign-off). Each MUST is either done and proven by mid-December, or covered by a written, rehearsed fallback Mason approves, or the date moves.
- **SHOULD**: a written manual step covers it safely for the 30-day pilot, and a named person runs that step.
- **CAN-WAIT**: Mason parked it, or it can't come up before the season changes on October 1, 2027 or at January's volume.
- **Mason's own call wins.** Where Mason has named an area as needed or as able to wait (2026-10-22: pricing, cost tracking, inventory, quoting and invoicing needed; returns, field-application invoices and rep-only rules can wait), the row follows his call, and the row says so.

**Status words.** *Built* means the code is live but hasn't yet passed its goal's full test. *Proven* means it has. *Not built* means no shipped change exists. *Process* means a written business procedure, not code.

**What "done" means for each row.** The one-line description here is a summary. The real test is that goal's full "Done when" list in the goals doc, run on staging. For example, split billing's test includes discounts, per-acre splits, several delivery dates and repeat requests. Each goal's own PR turns that list into exact test cases.

## Build order (Mason, 2026-10-22)

Mason's priority is everything that happens **before delivery**: quoting, product pricing, cost tracking, inventory (so he knows what to order) and invoicing. Returns, field-application invoices and rep-only rules wait. Code work goes in this order:

1. **Before delivery, first:**
   - pricing and cost tracking: quote line identity 1.3, then the sent-quote price lock 1.2 (which depends on 1.3), then 0.1–0.7. The price sheet's safety work (0.1) can be built alongside, but per the pricing plan's rollout gate it isn't switched on for live price changes until 1.2 and the margin floors (0.2) are live. Otherwise a price-sheet change could re-price a quote the customer was already sent;
   - cost and margin admin-only: 11.3;
   - knowing what to order: 0.8–0.10, then the SHOULD inventory fixes 0.12–0.16;
   - quoting and orders: 1.1, 1.4, then the SHOULD quote fixes 1.6–1.12;
   - invoicing: 3.1–3.5 and 3.8;
   - Chicago dates at the year boundary: quote and order numbers 12.1, payment dates 6.7.
2. **Delivering and billing it:** deliveries and retry safety 2.1–2.3 and 2.6, then the SHOULD item 2.8 (the delivered brand and its EPA number), split billing 4.1–4.3, payments and prepay 6.1–6.9, commissions 8.1, 8.3 and 8.4, documents and emails 9.1–9.9.
3. **Complete numbers at volume:** 10.1–10.4.
4. **Last:** everything marked CAN-WAIT (section 17).

The non-code MUST items (backups and recovery in section 13, QuickBooks and payments in 14, Mason's readiness tasks in 15, launch readiness in 16) still have to be ready by January 1. They run alongside the code work, mostly in other sessions or as Mason's own tasks, and don't take build time from tier 1.

## The short version

| | Count |
|---|---|
| MUST, built and live (still needs its December proof) | 22 (2026-10-23: +2, rows 11.9 and 11.10) |
| MUST, code not built or only partly built (7 of them are the new pricing and cost-tracking rows 0.1–0.7) | 29 |
| MUST, a business process, drill, review or Mason action (not code) | 25 |
| SHOULD (28 of them folded in from the old `TODO.md` on 2026-10-22; 2.8 added the same day) | 33 |
| CAN-WAIT | 19, plus the parked items in section 17 |

Rows that only point to another row ("See 4.4") aren't counted twice. A row split between two ranks (for example 8.3) counts under its MUST part. The 2026-10-23 refresh only added the two built rows above; no other MUST row changed category, so the other counts are as of 2026-10-22.

**The four biggest risks for January 1:**
1. **The before-delivery work is mostly not built.** Of the seven pricing and cost-tracking pieces, three haven't started (margin floors, last-charged price, sell-price history) and four are partly built (0.1, 0.5, 0.6, 0.7). The sent-quote price lock hasn't started. On billing, "post uses what was saved" went live on 2026-10-22 (PR #1018), while voids on posted invoices and partly delivered split orders are open. Billing a landlord went live on 2026-10-22.
2. **We can't yet recover from losing the database (Goal 6).** The weekly off-site database copy and (since 2026-10-22) the weekly photo and file backup run, but neither has been restored in a drill, and the Supabase plan can't rewind to a chosen time. Today a bad day could cost about a week of work.
3. **No staging system yet.** Nearly every proof below, plus the December rehearsal and staff training, needs one.
4. **The QuickBooks and Stripe connections haven't started, and Stripe may not accept a restricted-use pesticide seller at all.** If they aren't proven by 2026-12-15, January runs on manual procedures that aren't written yet.

---

## 0. Product pricing, cost tracking and knowing what to order

Mason, 2026-10-22: "i need everything built that is quoting, invoice, inventory (so i know what to order) cost tracking, product pricing etc all things that need done before delivery." The pricing rows follow the finished, approved plan `docs/plans/2026-10-13-pricing-history-cost-tracking-and-quote-pricing-PLAN.md` (section 4, "Build path", slices 0–9). A code check on 2026-10-22 (Mason: "maybe we just havent enabled it") found no slice finished and switched off. Several rows (0.1, 0.5, 0.6, 0.7, 1.3) build on groundwork that already exists, so they are smaller than starting from scratch.

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 0.1 | **The price sheet is safe to use.** "Download full price sheet" exports every active product. Uploading it warns on any move over 10%, any below-cost price and any margin under the product's floor. Every warning must be acknowledged, and the database enforces that. Each changed row stores a source and a reason with its history | **Partly built, already on (admin only).** The Products page has "Pricing .xlsx" and "Review Pricing File" (`src/pages/Products.tsx`). With no filter and nothing ticked, the export is every active product. A preview opens before anything is applied and flags a below-cost tier price. Each change is saved in `cost_history` with a required source and an optional reason (migrations `20260717042803_supplier_pricing_phase1a`, `20260722091359_supplier_pricing_workbook_v2_product_info`). **Missing:** a warning for moves over 10%, the margin-floor check (0.2), an acknowledgement the database enforces, a required reason, and a single "full price sheet" button that ignores filters. Checked in code 2026-10-22. | Pricing slice 0 (extends what is there) | MUST |
| 0.2 | **Margin floor per product** (no company-wide default), feeding the low-margin warning | **Not built** (pricing plan, slice 8). | Pricing slice 8 | MUST |
| 0.3 | **"What did we charge this customer before?"** in the quote screen: the last charged price per customer and product, with date and tier | **Not built** (pricing plan, slice 3). | Pricing slice 3 | MUST |
| 0.4 | **Sell-price history on the product page** (admin-only), with a real date axis on the price chart | **Not built** (pricing plan, slice 4). Tier price changes are already logged in `cost_history`, but no screen shows them. | Pricing slice 4 | MUST |
| 0.5 | **Cost beside each quote line** (admin-only, hidden from customers and PDFs): the cost when quoted next to today's cost, so a locked quote that has lost margin is visible | **Partly built, on for admins.** The quote screen shows Cost, Profit and Margin per line to admins, hidden in Customer View (`src/pages/QuoteBuilder.tsx`). The database keeps an unchangeable quote-time cost per line (`quote_items.cost_at_quote_cents`, migration `20260812115236_quote_items_cost_at_quote_snapshot`). A saved quote opens showing that quote-time cost, but any recalculation while editing replaces it on screen with today's product cost. **Missing:** the two costs side by side, and a screen that keeps the quote-time cost after an edit. Checked in code 2026-10-22. | Pricing slice 5 (extends what is there) | MUST |
| 0.6 | **Profit reports use the cost at the time of sale**, not today's cost | **Partly built.** The Financial Dashboard and Sales Reports already use the cost saved at the time of sale (migration `20260812115235_snapshot_cost_reporting`; admin-only since PR #957). **Missing:** the Reports page profitability tabs still add up older stored profit figures in the browser (`src/pages/Reports.tsx`), and the server report built for this, `get_profitability_report`, is called by no screen. The fix is mostly pointing those tabs at it. Checked in code 2026-10-22. | Pricing slice 6 (small switch-over) | MUST |
| 0.7 | **Cost freshness:** an "as of" date on each cost, a stale-cost report, and supplier price evidence used for more products | **Partly built.** The product page shows the date its cost basis was recorded, the Supplier Pricing page (a tab on Products) shows the latest supplier price dates, and the price sheet carries "as of" dates. **Missing:** an "as of" date on the Products list and a stale-cost report (the small part Mason un-parked on 2026-10-22). **The one real switch:** using supplier prices as the official cost is off (`app_settings.supplier_cost_basis_enabled` seeded false in `20260722015019_supplier_cost_basis_phase2`), except for the 10 Wells pilot products (`product_cost_basis_rollout`). That rollout stays parked, and turning it on would take a reviewed database change. 602 of 604 product costs were still the original setup load on 2026-09-02. Checked in code 2026-10-22. | Pricing slice 7 (small part) | MUST: as-of date and stale-cost report. CAN-WAIT: supplier-evidence rollout |
| 0.8 | **Know what to order.** Each product has a reorder point. The Inventory page shows net position (in stock − booked + on order) and a "Need Reordering" list grouped by vendor | **Built** (`src/pages/InventoryPage.tsx`: reorder points, net position, reorder alerts by vendor). It's only right if the stock count is right (15.2) and each product has a reorder point. How many products have one hasn't been checked. | Done; set reorder points and prove it after the count | MUST |
| 0.9 | **Purchase orders and receiving**: ordering from vendors, receiving into stock, purchase cost kept admin-only, and cost corrections tracked | **Built.** Purchase-order cost is admin-only, with a cost history and governed corrections, live 2026-10-22 (PR #980). | Done; prove on staging | MUST |
| 0.10 | **Bookings count against stock**, so quoted and ordered goods show up in "what to order" | **Built** (the "booked" figure in net position; job reservations). Old orders still holding stock are cleared in the inventory readiness step (15.2). | Done; clean up in 15.2 | MUST |
| 0.11 | Named or seasonal price lists ("Early Bird") | **Parked by Mason 2026-10-14** (pricing plan, slice 9). | Later plan | CAN-WAIT |
| 0.12 | **Product category remap**, so pickers, reports and the price sheet group products the right way | **Open** (old `TODO.md` (2026-09-27), §1 owner actions). Mason, 2026-10-22: "category remap we probably need to do sooner". | New, with the pricing work | SHOULD |
| 0.13 | A retired product that still has an open purchase order still counts as "on order" | **Open** (old `TODO.md` (2026-09-27), §5). Today it drops out of the on-order view, so "what to order" undercounts. | Inventory fix | SHOULD |
| 0.14 | Stock holds that never release (a crop-program hold; holds on dead jobs) are cleared | **Open** (old `TODO.md` (2026-09-27), §5). They inflate "booked" in 0.10. PR #889 cleared holds on deleted orders; a sweep for dead jobs isn't confirmed. | Inventory fix | SHOULD |
| 0.15 | **Send a purchase order to a vendor** as a PDF and by email | **Not built** (old `TODO.md` (2026-09-27), §5). | New | SHOULD |
| 0.16 | Merge duplicate vendor names, so the reorder list by vendor isn't split | **Open** (old `TODO.md` (2026-09-27), §1). It changes live data, so it needs Mason's OK first. | Data cleanup | SHOULD |

Quote line identity (pricing slice 1) is row 1.3. The sent-quote price lock (slice 2) is row 1.2. Admin-only cost and margin is row 11.3.

## 1. Selling: quotes and orders

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 1.1 | Build, send and convert a quote; a rep records only their own name on it | **Built.** Quote builder, versions and PDFs live. Own-name on quotes live since 2026-10-15 (PR #938, migration `20261015200000`). | Done; prove on staging | MUST |
| 1.2 | **A sent quote keeps the prices the customer saw.** A price change goes through a revision that must be re-sent; rewind to the last sent version; an admin approves a below-cost price at Convert | **Not built.** Accepting a sent quote re-prices it to today's tier price (confirmed live 2026-10-14; goals doc section 3, gap 2). | Goal 3, pricing plan slice 2 | MUST |
| 1.3 | Convert to Order never leaves an accepted quote with no order; re-saving a quote with one product on two lines works | **Mostly built (2026-10-23).** The re-save refusal is fixed and live (PR #1038, 2026-10-22, screen only, no migration): the quote screen now remembers each saved line's ID and sends it on every save, so a quote with one product on two lines can be re-saved, revised, presented and converted. A rolled-back live check passed (`scripts/smoke/smoke-save-quote-repeated-product-line-ids.sql`). PR #1047 (2026-10-23) also stopped a false "Unsaved Changes" prompt after the first Save Draft of a new quote. **Still open:** while editing, the screen shows today's cost in place of the saved quote-time cost (see 0.5; the stored cost isn't changed), and the "Convert to Order can leave an accepted quote with no order" gap from 2026-10-22 was not re-checked. | Pricing slice 1 remainder (with 1.2 and 0.5) | MUST |
| 1.4 | Create an order; a rep records only their own name on orders and blend tickets | **Built.** Live since 2026-10-15 (PR #933, migration `20261015130000`). | Done; prove on staging | MUST |
| 1.5 | **Only admins change commission splits** (customers, jobs, quotes, orders). New customers go on an admin to-do list. Copied and rolled-over quotes take the customer's current split. An admin editor recalculates *unpaid* commissions and can't race a payout | **Not built.** Today a customer's assigned rep can edit that customer's split, and any rep can edit a job's split (goals doc, Goal 2 "Still to do"). No regular reps yet (Mason, 2026-10-22), so only admins edit splits in practice. | Goal 2 follow-up | CAN-WAIT (MUST before the first regular rep gets an account) |
| 1.6 | A quote's price tier is checked against the customer's assigned tier | **Not built** (old `TODO.md` (2026-09-27), §5). A quote could be priced at the wrong tier. | With 1.2 | SHOULD |
| 1.7 | The quote and order screens use the tested price calculator (`quoteCalc`) instead of their own math | **Open** (old `TODO.md` (2026-09-27), §5). Totals could drift between the quote and the order. | With 1.2 and 1.3 | SHOULD |
| 1.8 | The customer's credit status shows in the quote header | **Not built** (old `TODO.md` (2026-09-27), §5). Credit problems would be caught before Convert. | New | SHOULD |
| 1.9 | A quote draft survives the app being closed on the iPad | **Not built** (old `TODO.md` (2026-09-27), §5). | New | SHOULD |
| 1.10 | Importing orders or quotes from a spreadsheet handles commas inside a name | **Open** (old `TODO.md` (2026-09-27), §5; confirmed in code). Matters for cut-over imports. | Fix | SHOULD |
| 1.11 | Someone actually looks at price-later orders, draft consolidation and booking rollover on a real screen | **Not done** (old `TODO.md` (2026-09-27), §1). | Staging proofs | SHOULD |
| 1.12 | Two people editing the same order can't overwrite each other's changes; ticket-number and allocation-version collisions are prevented | **Open** (old `TODO.md` (2026-09-27), §5). Orders have no stale-edit check. | Fix | SHOULD |

## 2. Delivering

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 2.1 | Completing a delivery from the delivery page, the field stop or the Deliveries list. With no signal the app refuses and changes nothing; back online it completes once | **Built, not proven on a real phone.** Refusal and paper-ticket fallback live (PR #955); the Deliveries list does it in one step (PR #964, migration `20261019220000`). The airplane-mode test on a supported phone hasn't been done (Goal 5, "Still open" item 4). | Goal 5 | MUST |
| 2.2 | Paper ticket when there's no signal: the driver gets it signed, then completes in the app with a photo of it | **Built in the app**, which requires the photo once the paper-ticket box is ticked. **The database check is now built (2026-10-23):** PR #1024 (migration `20261022075000`, applied live 2026-10-23, 7:39 AM Central) makes the server refuse any delivery completion without saved proof: an on-screen signature, a photo of a signed paper ticket, or, at the field stop's "left at site" option, a photo of where it was left. An admin can instead "Record without proof" with a written reason (10–500 characters), which records who and when, sends no receipt, and shows a "Recorded without proof" label. Accepted proof can't be edited or deleted later. A phone running the app from before this change can't complete a delivery after the apply. **Still open:** the real-phone test,. | Goal 5 follow-up | MUST: the real-phone test. Database check: done |
| 2.3 | **Completions and money actions are retry-safe** | **Partly built.** Four batches live (last applied 2026-10-21). **69 database functions still open** (`KNOWN_ISSUES.md`, "about 75 live functions replay a saved result matched on the retry key alone"). The driver-retry gap in goals doc section 3 is part of this. | Goal 3 ("Retries are safe") | MUST |
| 2.4 | Customer gets a delivery receipt email | **Built, with gaps.** The phone sends it, and doesn't retry if signal drops right after. A driver who couldn't see an older stop's customer used to send no receipt and wasn't told (`KNOWN_ISSUES.md`, "a driver's completion receipt can be skipped", MED); PR #1024 (live 2026-10-23) fixes that with a read-only lookup of the receipt recipient, so check it on a real phone. The office can resend. Receipts carry no photos (Mason, 2026-10-14). A guaranteed automatic retry of a receipt that fails after completion is deferred. | Goal 5 follow-up | SHOULD (the office resend covers it, see 9.3) |
| 2.5 | A counter sale through quick delivery in a few taps, including amounts under 1 unit | **Not built** (goals doc, Goal 3: today 9–12 actions across 3 screens). Counter sales still work, just slowly. | Goal 3 | SHOULD |
| 2.6 | A stock shortage warns but never blocks a delivery | **Built.** Mason's permanent decision (2026-10-15, 6b). | Done | MUST |
| 2.7 | A driver's shortage or damage report tells the office what happened, not just a generic notice | **Open** (old `TODO.md` (2026-09-27), §5). The office may bill the wrong amount. | Fix | SHOULD |
| 2.8 | **The delivered brand and its EPA number are on the record.** A generic product ("Roundup 5.4# Generic") lists its acceptable brands, each with its own EPA number. Whoever loads the truck picks the brand, or several with amounts, and it's required; an unlisted brand is typed in from the label and never stops the truck. The delivery receipt, the invoices made from a delivery or its order, the statement and those invoices' restricted-use (RUP) register records print the delivered brand's number. Quotes, prices and cost stay on the generic. Field-application, job and blend-ticket invoices aren't covered (section 5 comes last) | **In review, nothing live yet (2026-10-23).** Designed in August (product data model, never started) and refreshed as step 1 on 2026-10-22: `docs/plans/2026-10-22-product-brands-step1-PLAN.md` (PR #1037). Open PR #1050 (step 1, PR A; migration `20261022085000`, history row 975, not applied) adds the list of real brands with their EPA numbers on the product page; nothing reads that list yet. Picking the brand at loading and printing it (PR B) isn't written. Today a delivery receipt shows no EPA number, delivery invoices store none, and the RUP register records the generic product's number, not the jug's. Step 2 (brand at receiving, stock by brand) is a later plan | Step 1 plan, two PRs | SHOULD (Mason, 2026-10-22: "rank 2.8 as SHOULD for now") |

## 3. Billing: invoices

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 3.1 | **Post bills exactly what was saved and reviewed**, on every route: single, group, batch and list posting. Credit and restricted-use (RUP) checks use the same saved version | **Built.** Live 2026-10-22 (PR #1018, migration `20261022022000`): Post refuses an invoice changed since the screen loaded it, and the editor greys out Post while there are unsaved edits. | Done; prove on staging | MUST |
| 3.2 | Product lines are billed only for delivered goods, across all of an order's invoices together (split siblings, added lines, returns, credits, restored invoices, two saves at once). Billing before delivery is removed | **Partly built.** A delivery's invoice is capped at what was delivered (migration `20261010120000`, PR #889). Order-level "Create Invoice" and up-front splits can still bill the ordered amount before delivery (goals doc, Goal 3 "Quantity caps"). No shipped fix found. | Goal 3 | MUST |
| 3.3 | Invoices made from scratch carry only charge lines (freight, application fee, service, other) | **Built.** Live 2026-10-21 (PR #983, migration `20261021050000`). | Done; prove on staging | MUST |
| 3.4 | A product added on the invoice screen uses the customer's price tier | **Built** (PR #908, 2026-10-14). The goals doc asks for one check on a saved invoice and its PDF. | Goal 3 (one check) | MUST |
| 3.5 | **Voiding or cancelling a delivery leaves nothing collectible for that delivery**: a draft or unposted invoice is cancelled; a posted one (unpaid, partly paid, paid or overdue) gets an automatic credit for exactly that delivery; the order's other deliveries stay collectible; repeats never restock or credit twice; only admins cancel a completed delivery | **Mostly not built.** A posted invoice stays fully collectible after its delivery is voided (`KNOWN_ISSUES.md`, "Voiding a delivery whose invoice is already posted leaves that invoice active"). A sales rep can cancel a completed delivery through the server. Built so far: voiding an order with split drafts (PR #987, migration `20261021030000`, live 2026-10-21), and cancel/void retry-safety (batch 3b). | Goal 3 ("Voids and cancellations") | MUST |
| 3.6 | **Reps read every invoice.** Another rep's invoice is view, print and re-email only, with no edit, post, unpost, transfer or added lines. Invoices nobody owns are admin-only. Every balance a rep sees covers the whole customer (Customer Balance report, printed Customer Invoice Summary, payment-allocation screen) | **Not built.** Reps can still unpost or edit some other reps' invoices (goals doc, Goal 2 "Back doors to close"). No regular reps yet (Mason, 2026-10-22). | Goal 2 follow-up | CAN-WAIT (MUST before the first regular rep gets an account) |
| 3.7 | A rep invoices only under their own name on every path: splits, groups with mixed owners, list posting, unposting, consolidation, transfer. Admins can reassign | **Partly built.** Manual, order and blend-ticket invoices are live (PRs #907, #928, #933). Job invoices don't record a salesperson yet (goals doc, Goal 2). No regular reps yet (Mason, 2026-10-22). | Goal 2 follow-up | CAN-WAIT (MUST before the first regular rep gets an account) |
| 3.8 | Invoice numbers take Chicago's year | **Built.** Live 2026-09-21 (migration `20260914100100`). | Done | MUST |
| 3.9 | The month-end delivery check doesn't count cancelled deliveries | **Open** (old `TODO.md` (2026-09-27), §5). Today the month never shows as complete. | Fix | SHOULD |
| 3.10 | Finance charges respect grace days and run on Chicago time | **Open** (old `TODO.md` (2026-09-27), §5). Only matters if finance charges are used; see decision 11. | Fix | SHOULD |

## 4. Split billing (one sale billed to more than one customer)

Mason, 2026-10-15: "for regular order and deliveries we have to have the split billing."

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 4.1 | Split an order or delivery between the grower and a landlord, partly delivered orders included. Co-owners pay the order's price. Every cent is accounted for, and the leftover cent goes to the order's own customer | **Partly built.** Billing a landlord (a field owner who isn't the order's customer) is live since 2026-10-22 (PR #1010, migration `20261021150000`). A partly delivered order still can't be split (goals doc, Goal 3 "Split billing"). PR #1006 (live 2026-10-22, migration `20261022021000`) makes a single order invoice refuse an order split across fields, so one customer can't be billed everyone's share. | Goal 3 | MUST |
| 4.2 | The Order page's "Bill Split" card drives the bills | **Not built.** It saves percentages that no bill reads. | Goal 3 | MUST |
| 4.3 | At the first delivery the split freezes the *money*: each line's billed total after discounts, its price, acres and owners. The last delivery bills exactly what's left. An order can be closed short and split on what was delivered | **Not built** (goals doc, Goal 3 build notes). | Goal 3 | MUST |
| 4.4 | A return on a split order credits each payer for their own share, from their original invoice lines | **Built.** Live since 2026-10-22 (PR #1010, migration `20261021155000_split_payer_return_credit`): each payer returns and is credited only for what its own invoices billed (`DECISION_LOG.md`, 2026-10-21 "Split returns are built before split billing to a landlord ships"). | Done; prove on staging | CAN-WAIT (built; returns wait) |
| 4.5 | Splitting one *field-application* invoice among customers | **Not built, on purpose.** Parked by Mason 2026-10-15. | Future work | CAN-WAIT |
| 4.6 | The office is notified when a delivery creates split draft invoices automatically | **Not built** (old `TODO.md` (2026-09-27), §5). The office could miss split bills. | New | SHOULD |

## 5. Field-application, job and blend-ticket invoices

**Mason, 2026-10-22:** "field application, job and blend ticket invoices are not musts, they are least important and are last thing to get built in the system." These invoices keep working as they do today; the remaining work on them is built last, after everything else on this list.

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 5.1 | Create, post and print field-app, job and blend-ticket invoices with their chemical lines | **Built** (goals doc, Goal 3: these keep their chemical lines by design). | Done | CAN-WAIT |
| 5.2 | Blend tickets never price a product at $0 for a missing tier price. Staff pick when a quote lists one product twice. A $0 line needs an admin reason | **Built.** Live 2026-10-21 (PR #982, migration `20261020210000`; PR #995, migration `20261021070000`). Live 2026-10-22: blend invoice amounts and cost come from the stored 4-decimal quantity, and an approved $0 line records the approved cost (PR #1020, migration `20261022020000`); a line that would bill under 0.0001 of a unit now says so in plain English (PR #1034). | Done | CAN-WAIT |
| 5.3 | A job or blend-ticket invoice can't bill more than was applied, counting every invoice for that job or ticket, including two saves at once | **Not built** (goals doc, Goal 3 "Caps and orderless invoices"). | Goal 3, built last | CAN-WAIT |
| 5.4 | Correcting a posted field-app invoice with a credit: admin-only, with a reason, partial amounts allowed. All credits on one invoice together can't exceed what's still creditable, and two at once are handled safely | **Not built.** No credit path exists for a field invoice today; credits come only from returns, which need an order. | Goal 3, built last | CAN-WAIT |
| 5.5 | The fix that stopped reps making field-app invoices through the order screens is fully signed off | **Fix live since 2026-10-07; two sign-off checks still owed** (`KNOWN_ISSUES.md`, "CRX-LIFE-001"). Item 1's query used to be refused at a confirmation prompt; PR #1013 (merged 2026-10-21) removed that cause, so an agent can now re-run it. Item 2 is a live run of two existing checks. | Agent, minutes each | CAN-WAIT |
| 5.6 | Blend ticket linked to an order with several price tiers for one product | **Open, no money effect today.** The quantity it records is read by nothing (`KNOWN_ISSUES.md`, "blend-ticket linkage picks ONE order line per product"). It's a separate issue from the duplicate-line pricing in 5.2. | Later | CAN-WAIT |

## 6. Payments, prepay and credits

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 6.1 | Record a check or bank payment against one or more invoices | **Built.** This is how payments are taken today, and the money loop has completed a real cycle (`CURRENT_STATE.md`, "Reality check"). Retry-safe since batch 1 (PR #942). | Done; prove on staging | MUST |
| 6.2 | Prepay: take money in advance, apply it to invoices, edit it | **Built.** Recent fixes: PRs #992 and #997; an exact retry of a prepay edit proven live (PR #968). | Done; prove on staging | MUST |
| 6.3 | Credits from returns applied to invoices, with reversal | **Built** (credit-memo apply live; `CURRENT_STATE.md` feature map). | Done; prove on staging | MUST |
| 6.4 | **A refund paid outside CRX is recorded in CRX**, so the customer's credit can't be spent twice | **Not built** (goals doc, Goal 3 "Voids and cancellations"). | Goal 3 | MUST |
| 6.5 | Balances and aging use Chicago's date and include every customer, for admins | **Built.** PRs #991, #996 and #998 (2026-10-21). Rep-visible full balances are still open (see 3.6). | Done | MUST |
| 6.6 | A customer's full payment history past 200 entries | **Open** (goals doc, Goal 4 list). Goal 4's done test includes a 200+ payment history, and Goal 4 is a launch gate. | Goal 4 | MUST |
| 6.7 | **A payment's date is Chicago's date, not the server's** | **Open.** `allocate_payment` defaults the payment date to the server's `CURRENT_DATE` (UTC, six hours ahead), and the payment screen never sends a date (latest definition `supabase/migrations/20260713060300_harden_allocate_payment_idempotency.sql`, checked 2026-10-22; old `TODO.md` (2026-09-27), §5). A payment entered after 6 pm can land on the wrong day, and on December 31 in the wrong month and year. | Fix (year boundary) | MUST |
| 6.8 | A check that each customer's prepay balance equals the sum of their prepay credits | **Not built** (old `TODO.md` (2026-09-27), §5). Prepay could drift silently. | New check; part of 16.5 | SHOULD |
| 6.9 | No leftover money records on deleted orders (deliveries, commissions), and deleting a product doesn't wipe its stock holds | **Open** (old `TODO.md` (2026-09-27), §5). | Fix and data check | SHOULD |

## 7. Returns

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 7.1 | **A return fixes the money and the stock.** Return goods on a CRX-billed order and get a credit; goods put back on the shelf go back into inventory once, and damaged goods are credited without being restocked | **Built.** A return goes requested → approved → received → credited (`src/pages/Returns.tsx`). Stock comes back only at the "received" step, as a logged inventory movement into Main Warehouse, and each item says whether to restock it (`supabase/migrations/20260827041100_rebuild_return_credit_cogs_reversal.sql`, the receive function). Damaged items are credited with "restock" off; there's no separate damaged or write-off stock location. Cancelling a received return takes the stock back out. | Done; prove the money and the stock together on staging | CAN-WAIT (Mason, 2026-10-22: returns can wait) |
| 7.2 | **Returns "sitting at farm":** a return is marked when the customer says the goods are coming back, and stays listed as sitting at the farm until it's picked up. Staff can see what still needs picking up, and what's picked up but not yet back in the warehouse (Mason, 2026-10-22) | **Not built.** Return statuses are only requested, approved, received, credited, rejected and cancelled (`.claude/schema-registry.json`). Nothing tracks pickup: an approved return is still at the farm by implication, and nothing shows "picked up, on the truck". | New, with Goal 3 returns work | CAN-WAIT (Mason, 2026-10-22: "returns are not important either it can wait especially the sitting at farm") |
| 7.3 | A return against one of the 53 spring deliveries billed in Chem Man can't create a CRX credit | **Not built.** Returns on those are allowed today (`KNOWN_ISSUES.md`, 2026-10-07 entry). The block needs returns to name their delivery. | Goal 3 | CAN-WAIT (returns wait) |
| 7.4 | Old-sale returns after 2026-12-31: staff know how to accept the goods, issue the credit in Chem Man or the books, and still open Chem Man history | **Process not written** (goals doc, L3; decision 2026-10-07). | Mason (L3) | CAN-WAIT (returns wait) |
| 7.5 | Split-order returns | See 4.4. | Done | CAN-WAIT |

## 8. Commissions

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 8.1 | Commissions calculated on orders and jobs, and payouts recorded | **Built** (job-level commissions live; commission cohort live 2026-09-21 to 09-28). | Done; prove on staging | MUST |
| 8.2 | Admin-only splits | See 1.5. | Goal 2 follow-up | CAN-WAIT |
| 8.3 | **Commission already paid on a returned or credited sale comes off the next payout**, as a lasting negative adjustment in CRX that the payout and the commission reports both show. It carries forward if it's bigger than one payout, and stays visible as owed if the person has left | **Not built.** Today `create_commission_payment` pays pending rows at full amount and refuses negative lines (goals doc, Goal 3 build notes). Mason allowed the *calculation* to be manual at first, but it still has to be recorded in CRX. | Goal 3 | MUST: the recorded adjustment. SHOULD: automatic calculation |
| 8.4 | **Prove the commission "as of" report on live**: create, post and void a test payout | **Not done.** The report shipped (PR #592, migration `20260903150100`) but has never been proven on live (old `TODO.md` (2026-09-27), §5). Mason called it "very important", and the first real payouts land near year-end. The live test needs Mason's OK at the time. | Agent, with Mason's OK | MUST |

## 9. Statements, printed documents and emails

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 9.1 | Print and email invoices, split invoices, credits, statements and delivery receipts | **Built** (PDFs and the `send-email` service live), with the receipt gaps in 2.4. | Done; review in 9.2 | MUST |
| 9.2 | **The office and bookkeeper review real printed and received documents**: recipient, address, product, unit, price, discounts, no sales tax, due date, payment instructions, final balance. Include long and corrected documents, split credits, season boundaries and aging cutoffs | **Not done** (goals doc, Goal 3 "What the customer actually receives"). | Goal 3 | MUST |
| 9.3 | A failed email is visible, a named office person resends it, and a resend never bills twice | **Partly built.** The office can resend a receipt; there's no guaranteed automatic retry (Goal 5, "Still open" item 3). | Goal 3 / Goal 5 | MUST: visible failure and a proven manual resend. SHOULD: automatic retry |
| 9.4 | Payment instructions on invoices match how customers can actually pay on January 1 (no online-payment link until Stripe is live) | **Process.** No Stripe link exists today, so nothing to remove yet. Recheck if Stripe ships partway. | Goal 7 / Phase D | MUST |
| 9.5 | A PDF over 20 pages is refused plainly rather than cut short | **Built** (PR #993, 2026-10-21). | Done | SHOULD |
| 9.6 | The bulk "Email" button on the Invoices list sends the selected invoices | **Not built.** It still says "Coming soon" (`src/pages/Invoices.tsx`; old `TODO.md` (2026-09-27), §5). January invoice volume needs it. | New | SHOULD |
| 9.7 | A statement prints its last-page footer once, not twice | **Open** (old `TODO.md` (2026-09-27), §5; the code still draws it twice). Customer-facing. | Fix | SHOULD |
| 9.8 | Email "don't send twice" keys come from the record, not the clock or a random number | **Open** (old `TODO.md` (2026-09-27), §5). A retry could send a customer the same email twice. | Fix | SHOULD |
| 9.9 | Names are cleaned before going into delivery emails | **Open** (old `TODO.md` (2026-09-27), §5). Odd text in a name could change what the email shows. | Fix | SHOULD |

## 10. Reports and complete numbers

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 10.1 | Lists, reports, integrity checks and lookups read every record | **Mostly built.** Goal 4 parts 1, 2a and 2b live (PRs #959, #981, #988, #993), and part 3 (pickers) live 2026-10-22/23 (PRs #1017, #1048; see 10.3). Still open: the dashboard action counts that stop at 10 (H36, part 4), the payment-history limit (6.6), and the old-limit data tests in Goal 4's "Done when". | Goal 4 | MUST |
| 10.2 | **The bookkeeper approves what each money report means** (which statuses count, the date basis, returns, credits, prepay, write-offs, costs), checked to the exact cent against independently prepared answers | **Not done** (goals doc, Goal 4 "Done when"). | Goal 4 | MUST |
| 10.3 | Pickers become search boxes; list pages page on the server | **Half done (2026-10-23).** Part 3 (pickers) is live: customer, field and product pickers (PR #1017, 2026-10-22) and order, job and purchase-order pickers (PR #1048, 2026-10-23) now search the database as you type or read every record, with a Retry on failure; four follow-ups landed in PR #1049. Left out on purpose because other PRs were editing them: the Invoice Detail picker (M29) and Bulk PO Import. Part 4 (server-side paging) isn't started. Both are in Goal 4's done test, which the goals doc makes a launch gate (due 2026-12-15). | Goal 4 | MUST |
| 10.4 | Workload test at twice the busiest day, with response-time targets agreed first | **Not run** (Goal 4). Needs staging. | Goal 4 | MUST |
| 10.5 | A screen that fails to load says so, instead of showing "No … found" | **Partly built** (old `TODO.md` (2026-09-27), §5). In the pilot, staff could think data is missing. PR #1043 (2026-10-22) shows "This list could not be loaded" with Try again on Customers, Fields, Products, Vendors, Vehicles, Crop Programs, Program Tracker, Notifications and Settings → Users (shared `LoadFailedState`; `DataTable` `loadError`). The second non-money PR (PR #1055, merged 2026-10-23) adds Jobs, Field Setup (a failed billing-split read now blocks the form, whose Save would have erased the splits), Compliance (all four tabs), Brand vs Generic and Office Cockpit (each failed tile says so instead of its "No …" line), and closes the Products Deactivate dialog when a reload fails. Settings → company settings now shows the failed state in place of its forms (blank defaults could have been saved over the real values) and refuses every settings save until a load succeeds. Two Codex LOW items are left as they are on purpose: a blank `crop_programs` setting reads as an empty list (a save then loses nothing), and a superseded quiet refresh reports "saved, but reload" while newer rows show (it over-warns, the safe direction). The first money PR (PR #1071, merged 2026-10-23) covers A/R and payments: A/R Workspace summary, A/R Aging (statement and season comparison), Payment History (list and a payment's allocations), Record Payments (customer search, open invoices), Customer Transactions and both Prepay panels; none shows a previous customer's or payment's rows after a failed read. The second money PR (2026-10-23) covers quotes, orders, deliveries and returns: the Quotes, Orders, Returns and Delivery Remainders lists and the open-booking rollover; Quote Builder (a saved quote that failed to load showed an empty form whose Save could replace the real lines, and a conversion table with no list priced every unit at a factor of 1; both now block, and a failed booking settlement says so); Delivery Detail (a failed lines or invoices read showed a delivery whose Edit could save over the real lines, or offered Create Invoice for a billed delivery); a return whose lines failed no longer offers Approve, Receive or Issue Credit over a $0 list; New Delivery says a failed address read instead of saving with no address. Empty pickers, hidden badges and skipped warnings on these screens are left as they are (low risk). The third money PR (2026-10-23) covers purchasing, inventory and receiving: the Purchase Orders list and Outstanding Items tab (no more $0 outstanding), Purchase Order detail (a failed line read showed the header over no lines with Receive Items still offered), the Receiving Hub, Receiving Log (no more previous filter's rows) and its totals, the Inventory grid (a read with no list left it on its loading skeleton for good), holds, forecast and receive dialog, the transaction history, and Cycle Counts (a count whose lines failed offered Complete & Apply Adjustments over an empty count). **Missing:** invoices (wait for PR #1057; a failed line read on Invoice Detail, Field Application Invoice and Order Detail can let Save write over the real lines), and A/P / commissions / rebates / month-end / Financial Dashboard. `fetchAllRows` still reads a page that answers with no list as empty unless the caller wraps it in `pageWithList` (the A/R and quote-to-delivery screens do; changing it for every caller is its own PR). | Finish the remaining screens | SHOULD |

## 11. Security and roles

Four staff roles must each get through a normal day: **admin** (everything), **sales rep** (quotes, orders, invoices, payments), **driver** (deliveries, field stops) and **applicator** (assigned jobs and fields). Commission recipients are paid but don't sign in to work.

**Mason, 2026-10-22:** "there are no regular reps yet so not very important on what reps can and cant do yet." Rules that only limit sales reps are CAN-WAIT, and become MUST before the first regular rep gets an account. Rules that also protect against drivers and applicators (cost and margin, photos, applicator fields) stay MUST.

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 11.1 | Only admins pull the restricted-use (RUP) sales register | **Built** (PR #927, migration `20261014220000`). | Done | MUST |
| 11.2 | Photos need an active staff sign-in every time; old and copied links fail; deactivated staff are refused | **Built** (PRs #929 and #947; buckets private since 2026-10-16). Goal 1's full per-bucket, per-role and deactivation checks still have to pass on staging. | Goal 1 | MUST |
| 11.3 | **Cost and margin are admin-only everywhere** | **Mostly live.** Steps 1 and 2 (PR #957; PR #965 with migration `20261019230000`), and purchase-order cost admin-only with locked columns (PR #980, migrations `20261021140000` and `20261021141000`, live 2026-10-22). Still open: step 3, locking cost columns on the other tables, such as product `current_cost` (`KNOWN_ISSUES.md`, HIGH, 2026-10-18). **Step 3 goes in two pieces (2026-10-23):** first open PR #1057 (migration `20261022090000`, history row 976, not applied) moves the invoice "version" that Post checks onto a new cost-free view, `invoices_postable`, because locking `invoices.total_cost_cents` would otherwise make every invoice unreadable; the lock itself comes in a later PR after #1057 is live. | Goal 1 | MUST |
| 11.4 | An applicator sees only the fields for their assigned jobs, by every route (job, location dispatch, crew), and loses access when the assignment ends | **Fails today** (read-only live audit, 2026-10-22; `KNOWN_ISSUES.md`, HIGH, 2026-10-22). The job-level assignment gate works (an unassigned applicator gets no job), but someone sent to one field of a split job sees all of its fields and billed customers, every applicator can read every customer's fields and field maps, and seven field functions with no access check hand every field, boundary and owner name to any signed-in account, drivers included (proven live). A whole-job applicator also keeps a finished or cancelled job forever. The fix is planned in three parts (functions, tables, end of assignment), each a migration. | Goal 1 | MUST |
| 11.5 | A rep can't write RUP register rows for an invoice that was never posted | **Open** (`KNOWN_ISSUES.md`, MED, 2026-10-14). It would put false sales in a regulated record, but only a sales rep can do it. | Goal 1 follow-up | CAN-WAIT (MUST before the first regular rep gets an account) |
| 11.6 | **Two applicators on one job** working together (Mason, 2026-10-22) | **Partly built.** A job has one main applicator (`jobs.applicator_id`). The Dispatch Board can give each field on a job a different applicator, or a crew (`job_location_dispatches`, `src/pages/DispatchBoard.tsx`), and a crew's members can be recorded on what was applied. Two named applicators on the *same* field isn't possible; the workaround is a crew with both of them. | New | SHOULD (the crew workaround covers January); MUST before spring application season |
| 11.7 | Drivers and applicators see only the customer addresses they need | **Open** (old `TODO.md` (2026-09-27), §5). Today they can read every customer's address. Narrow it, or Mason accepts it. | Fix or accept | SHOULD |
| 11.8 | Known-leaked passwords are refused at sign-in | **Not on.** It needs the Supabase Pro plan (13.1) (old `TODO.md` (2026-09-27), §1). | Settings change after 13.1 | SHOULD |
| 11.9 | **A new login can't pick its own role, and an inactive account is refused** (added 2026-10-23) | **Built, live 2026-10-23.** Before, anyone who could sign up could write "admin" into their signup details and get an active admin profile (believed not exploitable only because public signup is off in the Supabase Auth dashboard, a second-hand fact nobody could re-check from SQL). PR #1039 (migration `20261022023000`): a login the Auth service creates starts as an inactive, login-banned driver whatever role it asks for. Settings → Create User then names and activates the user; PR #1056 moved that activation into the same server request, so adding a user is one step. PR #1042 (migration `20261022070000`): Team Board, its yesterday recap, Integrity Cleanup's "mark verified" and the AR reminder list now refuse a deactivated or not-yet-active account. **Still owed:** a live Create User click-through on the new `create-user` function (version 25, deployed; Mason deferred the check on 2026-10-23, recorded in PR #1063). | Done; prove on staging | MUST |
| 11.10 | **Nobody writes payment records directly through the database API** (added 2026-10-23) | **Built, live 2026-10-23.** Before, any active sales rep could create fake payment-allocation rows, and an admin could edit or delete them without reversing the payment properly. PR #1026 (migration `20261022040000`) removes direct writes on `allocation_sets`, `invoice_line_allocations` and `order_line_allocations`; recording, reversing and voiding still work through the database functions, and reads are unchanged. A live read-only check found no sign it was ever abused. | Done; prove on staging | MUST |

## 12. The year boundary (December 31 to January 1)

Checked 2026-10-21: the *season* changes on **October 1**, not January 1 (`src/utils/season.ts`). So the open season-stamp issues in `KNOWN_ISSUES.md` matter at the 2027-10-01 change, not on day one. What does change at midnight on December 31 is the year in document numbers.

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 12.1 | Quote, order and rebate-claim numbers take Chicago's year | **Open.** They use the server's clock (UTC, six hours ahead of Chicago), so anything created after 6 pm on December 31 gets a 2027 number (`KNOWN_ISSUES.md`, 2026-09-26). Invoice numbers are already fixed (3.8). | New small fix | MUST |
| 12.2 | A year-end rehearsal on staging: entries on both sides of midnight Chicago time, aging and statements as of December 31 and January 1, and documents dated across the line | **Not done.** | Phase D | MUST |
| 12.3 | Season stamps and season reads on the server and browser clocks, including the pre-harvest-interval warning on a job (`KNOWN_ISSUES.md`, "other paths still stamp `invoices.season` from the UTC clock" and "client-side season READS still follow the browser clock, including ONE SAFETY path") | **Open**, but only wrong around October 1. | Fix before 2027-09-30 | CAN-WAIT (for day one) |

## 13. Backups and recovery (Goal 6)

Mason's target: an outage can last overnight, CRX is back by the next business morning, and we lose minutes of work, not days.

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 13.1 | **Supabase Pro with point-in-time recovery** (rewinding the database to a chosen minute) | **Not done.** The plan is Free (live check 2026-10-18, `docs/plans/2026-10-18-goal-6-safety-net-findings.md`). Already decided 2026-10-13; it needs Mason's billing click. | Goal 6 (Mason's action) | MUST |
| 13.2 | **A full restore drill**, timed and logged: database, permissions, logins and every file bucket restored into an isolated copy, with photos opening against their records; plus one rewind-to-a-time on a throwaway copy, with recovery time and lost work measured against Mason's target | **Not done.** The weekly off-site copy has run every Sunday since 2026-09-06 (last 2026-10-18) but has never been restored. The steps are a draft (`docs/plans/2026-10-19-goal6-restore-procedure-draft.md`). A parallel session is working on Goal 6. | Goal 6 | MUST |
| 13.3 | Photos, signatures and uploads backed up (all nine storage buckets) | **Built and running.** The weekly file backup of every bucket is live since 2026-10-22 (PR #1029; `CRX_Backups` PRs #1 and #2). Its first run saved 9 buckets and 38 files, matching the database list of files, and a break test caught a deliberately dropped file (`docs/operations/production-runbook.md`, storage row). A restore drill (13.2) still has to prove the files come back. | Done; restore in 13.2 | MUST |
| 13.4 | **After a restore, nothing happens twice**: payments, QuickBooks entries and emails already sent are reconciled before anything restarts | **Process not written** (goals doc, Goal 6 "Done when"). | Goal 6 | MUST |
| 13.5 | Two named people can run the recovery; the backup passphrase isn't held by Mason alone | **Not done.** Only Mason holds the passphrase. | Goal 6 (Mason names them) | MUST |
| 13.6 | A failed backup alerts a named person and a backup, who know what to do | **Partly built, live.** A daily freshness check fails when either backup is too old. It is live since 2026-10-22, and Mason confirmed he received the failure email from a deliberate break test (`CRX_Backups` PR #1; PR #1030; runbook section 4.11). **Still owed:** a named backup person, and the outside watchdog that still works if GitHub Actions stops (a run that never starts sends no email). Until then, someone checks the backup dates every Monday. | Goal 6 | MUST |
| 13.7 | **Staging**: a separate copy of CRX with its own accounts, test payment keys and captured email, which can't reach real systems. The money and inventory browser tests run per role on it, and a failure blocks the change | **Not built.** Almost every proof in this list, the December rehearsal and staff training depend on it. | Goal 6 | MUST |

## 14. QuickBooks and Stripe

Both integrations stay in the plan (Goal 7). The QuickBooks sync is one-way: CRX sends invoices, payments and credits to QuickBooks. Two-way sync stays on the "not building" list. Nothing exists in the code yet: searching `src/` and `supabase/functions/` on 2026-10-21 found no QuickBooks or Stripe code. A research plan landed on 2026-10-21 (`docs/plans/2026-10-21-goal7-quickbooks-stripe-groundwork.md`, PR #1016). It recommends testing the paid Conductor connector for QuickBooks first. It also found that **Stripe's prohibited-business list may exclude restricted-use pesticide sellers**, so Stripe has to confirm in writing before anything is built, and another processor may be needed. The manual fallbacks below are a **time-limited contingency**, used only if Mason chooses one at the 2026-12-15 checkpoint. Each has an owner and an end date for returning to the integration.

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 14.1 | **The accountant approves the accounting map**: how invoices, payments and allocations, credits, prepay, refunds, write-offs, discounts, fees, inventory costs, vendor bills and commissions reach the books, with the chart-of-accounts mapping and closed-period rules. Needed for the sync *and* for hand entry | **Not started.** | Goal 7 | MUST |
| 14.2 | **QuickBooks Desktop sync**: the accountant confirms our Desktop version stays supported; a connection is proven on a copy of our company file by 2026-11-15; there's an operating plan (which PC, schedule, bookkeeper, alert on a failed sync); a reconciled test month by 2026-12-15 | **Planned, not started.** The connector choice and test steps are in the Goal 7 groundwork plan. | Goal 7 | MUST, or 14.3 approved as the contingency |
| 14.3 | **QuickBooks contingency**: a transaction-level CRX report and written steps for entering invoices, payments with their allocations, credits, prepay and corrections by hand. Each one is marked when entered, so nothing goes in twice, and each customer is tied out daily, signed by the bookkeeper. Rehearsed on staging, with the daily workload measured | **Process and report not written.** | Phase D prep | MUST if chosen |
| 14.4 | **Online card and ACH payments through Stripe**, with an invoice marked paid only on a verified Stripe settlement | **Not started.** Stripe may not accept us (see above); its written answer comes first. | Goal 7 | CAN-WAIT if 14.5 is approved |
| 14.5 | **Payment contingency**: written steps for checks and bank transfers. When a payment counts as received, who records it in CRX and QuickBooks, unapplied money, returned or bounced payments, and matching each day's deposit | **Process not written.** Recording payments by hand already works in CRX (6.1). | Phase D prep | MUST |

## 15. Business readiness (Mason's own tasks, no code)

These are Mason's checklists (goals doc, L1–L3), not agent gates. The full checklists are in the goals doc; these rows are the headline.

| # | What must be ready | Today (evidence) | Rank |
|---|---|---|---|
| 15.1 | **Opening balances, record by record** (L3): every customer balance, unpaid invoice, prepay or deposit, unapplied payment, outstanding credit, open order, unbilled delivery and stock balance matches Chem Man, QuickBooks and the count. Original IDs and the source system are kept, nothing is entered twice, and the bookkeeper signs | Not started. | MUST |
| 15.2 | **Inventory readiness** (L2): a stock count by product, package and location, approved adjustments, and old deliveries, reservations and receipts that still hold stock cleared. Receiving, partial delivery, return, void, transfer and field use all checked | Not started. On 2026-08-19 there were 19 negative stock rows, and five products still flag in the integrity report until counted (`KNOWN_ISSUES.md`, 2026-10-07 entry). | MUST |
| 15.3 | **Compliance readiness** (L1): EPA numbers and labels verified; customer and staff licenses on file; expired, missing and wrong-state licenses and label restrictions handled; a full reporting period produces correct state reports. Mason decides wherever a rule needs a hard block instead of today's warning | Not started. Today the RUP license check only warns (`src/lib/rupCompliance.ts`). | MUST |
| 15.4 | Junk records cleaned and duplicate customers merged before opening balances | **Not done** (old `TODO.md` (2026-09-27), §1 and §5). It changes live data, so each step needs Mason's OK. | Mason + agent | SHOULD |
| 15.5 | A printable Application Record PDF for inspectors | **Not built** (old `TODO.md` (2026-09-27), §5). | New | SHOULD |

## 16. Launch readiness: trial, developer, cut-over and pilot operations

| # | What must be ready | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 16.1 | **The November–December trial**: a few chosen customers billed through CRX, quote to payment, each sale billed in one system only, with a log, reconciliation and a written result | **Not started** (goals doc section 2, Mason 2026-10-15). | Mason + agents | MUST |
| 16.2 | **The senior developer**: engaged for early design reviews (QuickBooks, split billing, recovery), the December independent review, their must-fix list fixed and rechecked, written sign-off, and agreed launch support with a backup contact | **Not engaged yet** (goals doc, open question 6d). | Goal 10 | MUST |
| 16.3 | **Cut-over checklist**, timed and rehearsed on staging: Chem Man's last bill, final extracts and record counts, opening entries, a check for work entered during the handover, CRX's first bill, and a go/no-go record | **Not written.** | Mason (L3) + agents | MUST |
| 16.4 | **What history moves into CRX** and what stays read-only in Chem Man, and that Chem Man history can still be opened after billing stops | **Not decided** (goals doc, L3). | Mason (L3) | MUST |
| 16.5 | **Daily pilot check** for the 30 days: balances, payments, credits, stock and QuickBooks (synced or hand-entered), with an owner and a backup. Every unexplained difference is logged, found and fixed, and reviewed by Mason and the bookkeeper | **Draft written, awaiting Mason** (2026-10-22, `docs/plans/2026-10-22-pilot-launch-procedures-draft.md` section 1). Built on the existing integrity checks (PR #988); not rehearsed. | Phase D prep | MUST |
| 16.6 | **Emergency brake**: who can pause one affected operation, numbered paper records for it, entering and reconciling them afterwards, and who releases the pause. Everything else stays in CRX | **Draft written, awaiting Mason** (2026-10-22, same file, section 2). Not rehearsed (goals doc, Phase D). | Phase D prep | MUST |
| 16.7 | **Outage paper fallback** for dispatch, delivery and payments, printed and rehearsed | **Draft written, awaiting Mason** (2026-10-22, same file, section 3). Not printed or rehearsed (goals doc, Goal 6). | Goal 6 | MUST |
| 16.8 | **Launch support**: where staff report a problem (app error, failed email, stuck bill, sync failure, stock difference), who answers, how fast, and when to pull the emergency brake | **Draft written, awaiting Mason** (2026-10-22, same file, section 4). Not rehearsed. | Phase D prep | MUST |
| 16.9 | **Training per role in December**, on staging, covering normal work *and* the exceptions: partial delivery, return, split billing, failed payment, missing signature, outage | **December** (goals doc, Phase D). | Phase D | MUST |
| 16.10 | Mapbox and satellite map licensing terms checked for business use | **Not done** (old `TODO.md` (2026-09-27), §5). | Mason | SHOULD |

## 17. Can wait until after the pilot

| Item | Why it can wait |
|---|---|
| Remaining field-app, job and blend-ticket invoice work (section 5) | Mason, 2026-10-22: least important, built last. They keep working as they do today. |
| Returns work, including "sitting at farm" pickup tracking and the Chem Man credit block (section 7) | Mason, 2026-10-22: "returns are not important either it can wait". Returns keep working as they do today: stock comes back at "received" and the credit follows. |
| Supplier-evidence cost rollout (0.7) and Early Bird price lists (0.11) | Parked by Mason, 2026-10-14. The rest of cost freshness was un-parked 2026-10-22. |
| Rules that only limit sales reps (1.5, 3.6, 3.7, 11.5) | Mason, 2026-10-22: no regular reps yet. They become MUST before the first regular rep gets an account. |
| Field-application split billing (4.5) | Parked by Mason, 2026-10-15. |
| Blend-ticket billing that picks the exact quoted line by itself | Parked by Mason; staff pick it today (5.2). |
| Multi-tier blend linkage (5.6) | No money effect today. |
| Season stamps and reads (12.3) | Only wrong around October 1. |
| Online payments (14.4) | Only if Mason approves the payment contingency (14.5). |
| Full offline proof of delivery, grower portal, an expired "uncertain request" locking its dialog | Dropped or parked by Mason; the last is rare and low risk (`KNOWN_ISSUES.md`, 2026-09-11). |

---

### Folded in from the old `TODO.md` (CAN-WAIT, 2026-10-22)

These were open in the old `TODO.md` (last updated 2026-09-27), aren't needed for day one, and stay here so they aren't lost.

| Area | Items |
|---|---|
| Field-application, job and blend-ticket work (built last, with section 5) | Re-entry and pre-harvest tracking and the dicamba 72-hour rule (**MUST before spring application season**). Sprayer packet. Dispatch board lanes, job templates and a weather strip. Commissions on blend tickets and job split visibility. Duplicate fields on boundary re-import, and field saves that aren't one step. Loader worksheet keeping stale "loads done", missing jobs on loader prints, a blank product on a blend line. Field-app leftovers (attachments, fuel surcharge, dispatch retry key). Pre- and post-spray emails, label-rate warn or block, wrong-field alert. The first real split field-app invoice check. The full-acreage billing nudge. Boundary import tested in a real vendor format. Whether an invoice is drafted automatically when an applicator finishes. |
| Screens and polish | Record Payment opens with no customer filled in. One combined PDF for batch invoice printing. Dashboard alerts for overdue vendor bills and blend tickets awaiting approval. Create Invoice from the Orders list; Link Order on blend tickets. Product filter on Field Invoices and a balance per field. Customer summary bar extras and drawer quick actions. Customer name links, status text, More menus, the phone blend page. The month-end month and year picker. Redirect or keep the old A/R pages. The Action Queue "+N more" link and search delay. Recipe filter, undo point, tab keys. Navigation items. Activity feed gaps. Rep not told of a cancellation; unused dashboard counts. Post next step, void preview, split percent, prepay queries, the A/R local date. PDF export promise, email branding, PDF previews. Pop-up animations. |
| Later features | Earmarked prepay buckets (the earmark engine redesign). EPA auto-fill from scanned labels. True average purchase cost for inventory (decision 12). Vendor bill lines and the return-policy screen. Finish or remove driver rush ordering. The idea backlog (soil tests, compliance vault and the rest). A CSV-only compliance export and other small compliance items. Clean up the leftover `apply_prepay_to_invoice` code. About 11 parked low-severity bug-hunt findings. Small retry-safety items (a dead "pending" check, planned holds' own retry key, an empty user key). |
| Rules that only limit sales reps (MUST before the first regular rep) | Any rep can edit any customer's fields, and the by-customer total is low for reps. Reps write the stock ledger directly; the Planned toggle fails for reps. |

### Agent and tooling work (not app work)

Kept here so it isn't lost; it doesn't take app build time. Keep the pricing branches (PRs #397, #350, #892) until the pricing work ships. Decide whether to keep or drop 159 unused database indexes. Set up workstation `psql` access for agent database checks. Re-run gauntlet sections 5–8. Retire the unused `setup-blend-tickets-storage` function (a deploy change, so Mason's OK). Combine the old migration files into one baseline. The guard-system hardening backlog (frozen during Goal 8). Move the last two routes into the shared page list `src/appPages.tsx` (`invoices/field-app/new` and `/:id`, still written out in `src/App.tsx`), in the next money PR that touches `src/pages/FieldApplicationInvoice.test.tsx`, which pins them there. Put `require_admin()` into a migration (it exists only live). Engineering hygiene (lint rules, big files, tests). Re-check three removed audits.

### Not doing (Mason, 2026-10-22)

Removed for good. Don't re-add without asking Mason: bank reconciliation, 1099s, reading vendor bills automatically, and profit per field.

**Also settled earlier** (carried over from the old `TODO.md` "Not building" list; don't re-add without new evidence): native apps; multi-tenancy for now; machine-learning forecasting; AI acting on its own on financial records; QuickBooks two-way sync (the planned sync is one-way, section 14); grain, energy and feed modules; a big-bang screen redesign; reorganizing screens by role before there's portal and phone usage data; re-enabling prepay bulk-apply; applying the shelved earmark migrations as they are; and offline money changes in general.

## What Mason needs to decide

**Answered 2026-10-22:** item 1 (approved), item 7 (yes, the small part) and item 13 (SHOULD, for now). Items 2, 5 and 6 are "not chosen yet". Items 3 and 4 wait for the 2026-12-15 checkpoint, after the contingencies are written and rehearsed.

Recommended answers first. Reply with the number and "yes", or say what to change.

1. **ANSWERED: approved.** **Approve the ranking rule and the MUST list** (the "How each item is ranked" section and every row marked MUST). Recommend: approve them now, so the next ten weeks work from one list. The QuickBooks and payment contingencies (items 3 and 4) are a separate yes, after they're written and rehearsed.
2. **Senior developer (open question 6d).** Who, the cost, whether they can start in October for early reviews, the December review, and launch support. Recommend choosing them by 2026-10-31, the checkpoint already in the goals doc.
3. **QuickBooks at the 2026-12-15 checkpoint.** If the sync isn't proven, do we start January 1 on the hand-entry contingency (14.3), or move the date? Recommend: start on hand entry **only if** it has been rehearsed on staging and the bookkeeper confirms they have the time, with a written date for returning to the sync. Otherwise, move the date.
4. **Online payments.** If Stripe isn't approved and tested by 2026-12-15, start January 1 with checks and bank transfers under the written payment steps (14.5)? Recommend **yes**. Customers pay that way today, and Stripe can follow during the pilot.
5. **Name an owner and a backup** for: the daily pilot check (16.5), hand entry into QuickBooks if used, the emergency brake (16.6), launch support (16.8) and recovery (13.5). Recommend naming them by 2026-12-01, so they rehearse in December.
6. **Who reviews printed and emailed documents (9.2) and approves the money reports (10.2)**, and by when. Recommend the bookkeeper, by 2026-12-01.
7. **ANSWERED: yes, the small part.** **Cost freshness (0.7), parked on 2026-10-14.** With cost tracking now a priority, un-park it? Recommend **yes, the small part**: an "as of" date on each cost and a stale-cost report, so old costs are visible. The supplier-evidence rollout stays parked, because it's mostly data entry. Without this, the margin warnings in 0.1 compare against costs that are mostly still the original setup load.

8. **Can unshipped lines be edited on a partly delivered order?** (old `TODO.md`, §5)
9. **Should a price-later rush order count against the customer's credit limit?** (old `TODO.md`, §5)
10. **How do quote discounts and fees work?** Sales tax is already settled: none. (old `TODO.md`, §5)
11. **Finance charges and month-end:** automate finance charges, warn before reopening a closed period, and save the month-end checkboxes? Decide before January 31. (old `TODO.md`, §5)
12. **True average purchase cost for inventory?** Recommend later. (old `TODO.md`, §3)
13. **ANSWERED: SHOULD, for now** (Mason, 2026-10-22: "rank 2.8 as SHOULD for now"). **Rank 2.8 (the delivered brand and its EPA number) as MUST?** The recommendation was **yes**: without it, a restricted-use generic delivered on January 1 goes into the RUP register with the generic's EPA number instead of the jug's, a wrong regulated record, which is the MUST test. If yes, it joins the "code not built" MUST count.

**Actions already decided, still waiting on Mason** (not new decisions):
- **Live Create User check on the new `create-user` function** (version 25, deployed 2026-10-23, see 11.9). Mason deferred it on 2026-10-23.
- **Upgrade Supabase to Pro and turn on point-in-time recovery** (decided 2026-10-13). Due this week, because the rewind-to-a-time drill (13.2) can't run without it. The first database-only restore of the existing weekly dump doesn't wait on it and can run now (`docs/plans/2026-10-18-goal-6-safety-net-findings.md`).
- **Send Stripe the eligibility question** about restricted-use pesticide sales (section 14, and section 5.6 of the Goal 7 groundwork plan).
- **Fallback for December 31 evening**: if the quote and order number fix (12.1) misses its December proof, staff stop entering quotes and orders in CRX after 6 pm that evening. It's a backup plan, not a substitute for the fix.

---

## Sol review findings not applied, and why

Checked against the goals doc and the code on 2026-10-21.
- **"No money effect" on multi-tier blend linkage (Sol finding 46, which Sol rated low-confidence).** Kept. `KNOWN_ISSUES.md` shows the recorded quantity is read by nothing, and it's a different issue from the duplicate-line pricing that PR #982 fixed.
- **Copying every goal's full acceptance list into each row (Sol findings 19–23, 30–34, 38).** Applied as one rule instead ("What 'done' means for each row"), with the key money words added where a row was misleading (frozen money basis in 4.3, cumulative credit cap in 5.4, every void status in 3.5). Repeating the goals doc in full would make this list too long to approve.
- **The paper-ticket database check as a MUST (Sol finding 16).** Only the real-phone test is ranked MUST. The app already requires the photo on that path, which meets the goals doc's done test. A database-level check is extra protection, so it's SHOULD.

Sol finding 41 (the workload test and the rest of Goal 4 as MUST) was first kept as SHOULD. It was applied after the Codex GitHub review on this PR made the same point: Goal 4's done test is a launch gate (rows 6.6, 10.3 and 10.4 are now MUST).

## Sources

- `docs/plans/2026-10-13-direction-and-goals.md` (sections 2, 3, 4, 5 and 6).
- `docs/manual/CURRENT_STATE.md` (migration ledger read 2026-10-21; shipped feature map; environment facts).
- `docs/manual/KNOWN_ISSUES.md`, the OPEN entries named in each row.
- `docs/plans/2026-10-18-goal-6-safety-net-findings.md` and the two 2026-10-19 Goal 6 drafts.
- `src/utils/season.ts` (the season boundary is October 1).
- `docs/plans/2026-10-21-goal7-quickbooks-stripe-groundwork.md` and `docs/operations/production-runbook.md` (storage backup and backup alerting rows).
- `git log` on `origin/main` through `b92d6f19a` and the open PR list (#1050, #1057, #1058, #1060), both read 2026-10-23; the bodies of the merged PRs named in the rows marked 2026-10-23. Earlier read: `13f83434d`, 2026-10-22.
- Mason's changes in chat, 2026-10-22, and a code check of returns (`src/pages/Returns.tsx`, the return receive function in `20260827041100`) and job assignment (`jobs.applicator_id`, `job_location_dispatches`, ground crews).
- Advisory Codex `gpt-6-sol` (high) review of the first draft, 2026-10-21 (57 findings).
