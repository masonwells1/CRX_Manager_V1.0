# JOURNEY: program-quote-call

## Persona walkthrough — big-account program-quote call (Channel A booking)

Tier-priced customer with saved fields calls to book a season program (2 sections: Spring + Fall, 6 products total). Wants a written quote emailed, then pulls product over the season.

### Phase 1 — Start the quote
1. **Two real entry points, both work.** Sidebar → **Sales → Quotes → New Quote** (3 clicks, `Sidebar.tsx:133`, `App.tsx:200`), or better: **Customers → open customer → Quotes tab → New Quote**, which pre-fills the customer via `/quotes/new?customer_id=` (`CustomerDetail.tsx:997`, `QuoteBuilder.tsx:541-557`). CustomerDetail also offers **"New from Last"** (duplicates their latest quote — the fastest path for repeat accounts, `CustomerDetail.tsx:976-995`).
2. **QuoteBuilder opens** with a server-generated quote number and one empty section (`QuoteBuilder.tsx:404-423, 142-153`). If Quotes-first: pick the customer from a **plain native dropdown of every active customer** — no search box (`:2478-2489`); prefix-typing is the only shortcut. Picking the customer auto-sets **their tier** and default commission split, and re-prices everything (`:564-574`). Tier price auto-fills per product with a silent fall-back to Tier-1 price when a tier price is missing (`:587-596`).
3. A **quote template** dropdown exists for repeat programs but only after a customer is chosen (`:2456-2466`) — season one is always hand-built.

### Phase 2 — Build sections & items (count for 2 sections / 6 products)
4. Check **"Planned Program"** (1 click). Tooltip promises inventory is reserved "so it's not sold to someone else" (`:1932-1942`). This reveals a per-section **Needed By** date (used for forecasting AND, invisibly, hold expiry = needed-by + 14 days, `20260702171000:101`).
5. Section 1: rename to "Spring Burndown" (1 click + typing), set Needed By (2 clicks), attach a saved **Field** (2 clicks — but this fills nothing; acres still typed by hand per item, `:383, 2590-2605`).
6. Items: each product = **Add Item → Select Product → type search → click result → click Acres → type acres** (~4 clicks + 2 typings). The picker shows tier price and a correct **$/acre** (`:3055-3089`), and picking a product auto-fills rate, rate unit, and price (`:702-732`) — good. But the picker closes after every pick, and acres never default from the section's field, so 3 items ≈ 12 clicks.
7. Add Section 2 (1 click), repeat: header ~5 clicks + 3 items ≈ 12 clicks. Oz/acre, $/acre, units needed, totals, profit and margin compute live per row (`:2664-2682`); a Customer View toggle hides cost/margin for screen-sharing (`:1960-1970`).
8. **Save Draft** (1 click). save_quote persists everything atomically and the server itself syncs the planned holds on every save path (`20260616204400:359`; the extra client `create_planned_holds` call at `:984-996` is belt-and-suspenders).

**Count (a): ~44 clicks + ~15 typing entries across 2 pages + 7 modal opens** (nav 3, customer 2, planned 1, section headers ~10, six items ~24, save/preview/email 3). With a saved template: ~10-12 clicks.

### Phase 3 — Send it (the trap)
9. **Preview Quote** (1 click) renders the PDF with a column-template picker (`:3131-3180`). Note: sections' Needed-By dates don't print — seasonal timing reaches the grower only if it's in the section name.
10. Two buttons: primary green **"Mark as Presented"** (does NOT email — snapshots V1 and flips to `sent`, `:1469-1493`) and secondary **"Email to Grower"** (freezes V1, sets `sent`, generates the PDF, emails via the send-email edge function with idempotent dedupe, `:1335-1467`). The tooltip next to Mark-as-Presented *claims it emails the PDF* (`:3198`) — the single most dangerous mislabel in the flow. **STALL: which button actually sends?** On an unsaved new quote, Mark-as-Presented silently no-ops (`:1470`).
11. After the real email: status badge `sent`, banner "This quote has been sent. Click Revise Quote to make changes" (`:2126-2130`). Real email, real PDF attached — this is a genuine send, not just a status change.

### Phase 4 — Revise cycle
12. Customer wants fall rates changed: **Revise Quote** (1 click, status → `revised`, editable again `:1130-1140`), edit, Save Draft, Preview → Email again (freezes V2). Versions button compares/restores snapshots (`:2198-2290`); restore is guarded against dropping already-drawn products (`:1525-1546`). Holds re-sync to the new quantities server-side. Clean loop.

### Phase 5 — Mid-season pull ("send me 30 gallons")
13. Office finds the quote: Quotes list search covers quote #, customer, **and product names** (`Quotes.tsx:609-610`). The row shows status/total/expiry but no remaining-balance hint; the collapsed **"Open booking rollover"** panel above it lists every open booking with Booked/Drawn/Remaining in dollars (`Quotes.tsx:543-601`).
14. Open the quote. A **Booking Settlement** card shows dollars booked/drawn/remaining plus a per-product qty table (`QuoteBuilder.tsx:2140-2194`) — the balances ARE surfaced, but **with no unit labels**.
15. Click **Partial Order**. Booking >30 days old (normal for a season program): **first click silently does nothing**, a stale-price banner appears ("prices may have changed" — untrue for a locked booking); dismiss it, click Partial Order again (`:1584-1593`).
16. Modal lists Booked/Drawn/Remaining per product (order + job draws combined, `:1601-1637`) — bare numbers, **no units** (**STALL: 30 gallons or 30 jugs?**). Type 30, **Create Order** (`draw_down_quote` bills at the locked weighted-average quote price, blocks overdraw, decrements holds FIFO, `20260702172000`). Lands on the confirmed order; an order-confirmation email fires to the customer automatically (`:1679`). Toast says "booking stays open."

**Count (b): 8 clicks + 2 typings across 3 pages + 1 modal** (Sales 1, Quotes 1, row 1, Partial Order 1, dismiss 1, Partial Order 1, qty 1, Create 1). Would be 6 clicks without the stale-banner detour. Scheduling the actual delivery is a separate flow afterward.

### Phase 6 — End of season
17. Fully-drawn bookings auto-flip to `accepted` on the last draw — clean. **Leftovers are the dead end:** Decline/Cancel refuse any drawn booking (`:1146-1171`), auto-expire skips drawn+planned bookings (`20260614143649:41-49`), **Roll Over to New Season** copies only the undrawn remainder into a new draft (`20260610191456`) but leaves the source booking open forever, and 'Close — Applied' means something else (we sprayed it). No honest "customer walked away from the remainder" close exists. Meanwhile un-dated planned holds never expire; dated ones lapsed silently 14 days after Needed-By with nothing on the quote saying so.

### What the office must remember that the app should surface
- Which send button actually emails (tooltip lies) and whether a send succeeded (no emailed-on indicator).
- What unit every booked/remaining number is in (gal vs jugs vs cases).
- Hold expiry dates (needed-by + 14d) and that blank Needed-By = permanent hold.
- That the stale-price warning is meaningless on locked bookings.
- Acres for each line, even when the section's saved Field already knows them.
- That a rolled-over booking's source must be… nothing, because it can't be closed.


===========


# JOURNEY: book-it-now-call

## Persona walkthrough — walk-in phone order: "20 gal of Product X, deliver Thursday" (Channel A fast path)

Persona: office staff (sales_rep) at the Dashboard, desktop. Goal: booked + Thursday delivery scheduled in under 60 seconds.

### Path 1 — New Order → Schedule Delivery (what a new hire will pick)
1. **Dashboard** → Quick Actions → **New Order** (1 click; Dashboard.tsx:424). This is the most visible "take an order" affordance in the app.
2. **New Order** page: Customer is a plain native dropdown of *every* customer, no search (NewOrder.tsx:570-589) — scroll/first-letter hunt for "Jones Farm" (~2 interactions).
3. Click **Select product...** → modal → type "Product X" → click it (~3 interactions). Picker helpfully shows On Floor + Net (NewOrder.tsx:936-941).
4. Type quantity **20**.
5. **STALL — "deliver Thursday" has no field.** Orders carry no requested-delivery date (schema: orders has `order_date` only, docs/reference/database-schema.md:26). Best option: type it into free-text Notes and remember it.
6. Click **Create Order**. **STALL** — if Jones Farm ordered *anything* in the last 7 days, a blocking "Duplicate Order Warning" modal appears → click **Create Order** again (NewOrder.tsx:341-357, 882-893). Stock shortfalls arrive as warning toasts only; order is created regardless (create_direct_order, migration 20260614142939:102-112).
7. Lands on **OrderDetail**. The order is booked and stock is soft-reserved — but **no delivery exists and nothing prompts for one**. If the phone rings now, the Thursday promise lives only in the operator's memory; the To-Ship safety net later shows only "Waiting *N*d" age, not a promise date (ToShip.tsx:521-528).
8. Click **Schedule Delivery** (OrderDetail.tsx:1137-1145) → **NewDelivery** (`?order=` works; items pre-filled with remaining qty, default address preselected — good).
9. **STALL — date defaults to TODAY** (NewDelivery.tsx:65). Operator must recall Thursday and change it; forgetting ships it the wrong day.
10. Optional driver → **Save**.

**Score: ~10–12 interactions, 3 pages, up to 2 interrupting modals.** Trained user ≈ 60–90s; new hire: minutes. Required fields are minimal (customer + 1 item + qty), stock is warn-only, but the delivery is never automatic and the promise date is never captured at booking time.

### Path 2 — Quick Delivery (the actual right tool, hidden)
1. Sidebar → **Operations** → **Deliveries** (2 clicks — it is NOT on Dashboard Quick Actions, NOT in the command palette, NOT on CustomerDetail).
2. Click **Quick Delivery** — the gray *secondary* button; the primary button on that page is "Schedule Delivery" (Deliveries.tsx:1156-1168).
3. One modal: **searchable** customer field (debounced, by farm name or account # — the best picker in the app), Add Product → qty → **Scheduled Date right there** (set Thursday) → optional driver → draft-invoice checkbox (default on).
4. **Create Quick Delivery** → second confirm modal → **Create** (QuickDeliveryModal.tsx:500-521).
5. Result: order + delivery + draft invoice created atomically (`create_quick_delivery`), lands on DeliveryDetail. **~8–9 interactions, ONE screen, promise date captured.**

**But two traps:** (a) the product picker shows no stock numbers (QuickDeliveryModal.tsx:554-559), and (b) if net-now stock (on-hand − prebooked; incoming POs NOT counted, scheduled date ignored) is short, the RPC **hard-rejects the entire booking at the final click** (migration 20260702132000:105-109) — the same order New Order accepts with a warning. Thursday order, PO landing Wednesday → Quick Delivery says no.

### Path 3 — caller has an open planned booking (program customer)
Nothing steers. New Order, Quick Delivery, and their RPCs never look at quotes (0 references), so no screen says "this customer has an open booking for Product X at a locked price." The operator who doesn't personally remember the booking books a direct order → **the 20 gal is now reserved twice** (order prebook stacks on the booking's hold), **the price is today's tier price, not the locked program price**, and the booking keeps a phantom balance. The correct path requires tribal knowledge: Quotes → find booking → open QuoteBuilder → **Draw Down** → enter qty → Create Order (QuoteBuilder.tsx:1584-1682) → OrderDetail → Schedule Delivery → NewDelivery. **~12–14 interactions, 4 pages** — and it still ends in the same manual delivery-scheduling tail.

### Path 4 — quote-then-convert
New Quote → build → Save (draft) → mark **Sent** → **Convert to Order** (enabled only at status='sent', QuoteBuilder.tsx:277) → OrderDetail → Schedule Delivery → NewDelivery. **~15+ interactions, 4 pages.** Correctly reserved for formal program quotes; pure ceremony for a 20-gal phone call. Note the hazard: on CustomerDetail the button row leads with **New Quote** (CustomerDetail.tsx:575), so a cautious new hire may start here by default.

### Verdict
**Quick Delivery should be THE path** for walk-in phone orders — one screen, atomic order+delivery+invoice, searchable customer, date captured at booking. What's missing to make it obvious and safe:
1. **Surface it as "Phone Order"** on Dashboard Quick Actions, CustomerDetail, and the command palette (today it's a secondary button on a page named for a different job).
2. **Soften its stock gate** to warn-not-block (or block only same-day), aligned with create_direct_order — otherwise season-time bookings bounce and staff fall back to the slow path.
3. **Add a customer-has-open-booking banner** (one quotes query) offering one-click draw-down, in both Quick Delivery and New Order.
4. For the two-step path that will still exist: **capture the requested delivery date at order entry** and auto-chain into a pre-filled Schedule Delivery — never let "Thursday" live only in someone's head.


===========


# JOURNEY: spray-job-scheduling

## Persona walkthrough — booked program customer calls: "spray field 12 next week" (office desktop)

**Golden path assumed:** the program quote exists (sent/revised + planned), the relevant section is saved, has items, and has Field 12 set on it. Click counts start from the Dashboard.

1. **Find the booking** — three workable entry points, none field-aware: **Quotes list** (Sidebar → Sales → Quotes = 2 clicks; type the farm name, or 1 more click for the amber "Planned" filter — Quotes.tsx:639), **CustomerDetail → quotes tab** (with a "planned programs" toggle, CustomerDetail.tsx:960-1012), or **Program Tracker** (card links to the quote, ProgramTracker.tsx:156). You cannot search by field — "field 12" only helps if the program was built one-section-per-field (each section has an optional Field dropdown). Open the quote → QuoteBuilder. *(≈4 clicks + typing)*

2. **QuoteBuilder → "Schedule Job"** — a small ghost button in each section header (QuoteBuilder.tsx:2617-2620), shown only when the quote is planned + non-terminal and the section is saved with items. **No prompt for date or applicator** — one click fires `create_job_from_quote_section` and navigates to the new JobDetail. Pre-filled: customer, chemicals with rates/prices from the section items, the section's ONE field (only if set) with acres = MAX(item acres), quote linkage, notes = section name. **Not** pre-filled: applicator, vehicle, time — and the job date is the section's season-level "Needed By" or **today**, not "next week" (20260703200000:468). **Stall risk:** the page shows no badge on sections that already have a job — clicking again just errors "A job already exists for this quote section." *(1 click)*

3. **JobDetail repair pass** — fix Job Date to next week (2), pick Applicator (2 — with live license status), optionally Vehicle/Time (0-4), Save Changes (1). Save only requires customer+date, so skipping the applicator or (on a field-less section) the Locations tab is silently allowed. *(≈5-7 clicks)*

4. **The invisible cliff** — the job is now "scheduled," but that status means only "exists." JobDetail has no dispatch button or link, no page flags "scheduled-but-undispatched," and if the office stops here believing the Applicator dropdown assigned the work, **the job never reaches any phone**: "My Field Jobs" (/field) is fed exclusively by wizard dispatches, not by jobs.applicator_id (FieldView.tsx:10-13). This is the flow's most dangerous silent stall.

5. **Dispatch Board** — Sidebar → Operations → Dispatch & Applicator View (2), left rail "Dispatch Jobs" (1), "Start Dispatch" (1). (The per-job "Dispatch Locations" button opens the same **global** wizard — not scoped to that job.) The stock light (`get_dispatch_stock_status`) shows green/amber/red per job row here — good pre-dispatch check, though it's on the row, not inside the wizard. *(4 clicks)*

6. **3-step wizard** — Step 1 tick Field 12's location among ALL dispatchable locations of ALL visible jobs (1), Next (1); Step 2 tap the applicator — chosen a **second time**, independent of step 3's dropdown (1), apply (1), Next (1); Step 3 "Finish Dispatching" (1). Upserts job_location_dispatches; the job appears on the applicator's My Field Jobs. *(6 clicks)*

**Total: ~19-21 interactions across 4 pages + a 3-step modal**, with the assignee entered twice in two systems that never sync (Jobs list shows the JobDetail one; the phone shows the wizard one).

**Two assignment concepts, clarified:** `jobs.applicator_id` (JobDetail dropdown / assign_job_applicator / Mass Edit) drives the office Jobs list, filters, and the license gate; `job_location_dispatches` (wizard) drives the applicator's phone page, the Dispatched List, and the board's Assigned To label — which deliberately hides the job-level applicator once any per-location dispatch exists. Both are needed today (crew-splits need per-location; the license gate + office lists need job-level), but nothing bridges them and no page shows both.

**Rain delay:** JobDetail → change Job Date → Save (≈5 clicks), or bulk: Jobs list → select the day's jobs → Mass Edit → Schedule Date → apply (≈6 clicks for the whole rained-out day — genuinely good). The dispatch correctly survives the move, but the applicator gets no signal: no notification exists, and the phone card only shows the date after expanding it (cards sort by job number, not date).

**Cancel:** JobDetail → Cancel Job → confirm (3 clicks; scheduled/in-progress only). Layer-2 releases the job's inventory holds automatically via `trg_release_job_holds_on_lifecycle` (20260702174000:288). But the dispatch row stays 'dispatched' forever — the CANCELLED card lingers on the applicator's phone and on the office Dispatched List until manually undispatched, and nothing ever sets dispatch rows to 'completed' when jobs finish either.


===========


# JOURNEY: applicator-phone-day

## Persona walkthrough — an applicator's day on a phone (Channel B, field side)

**Setup verified from code:** the applicator role's entire nav (Sidebar.tsx role gates + pagePermissions.ts:42-52) is: Dashboard, Getting Started, Operations → { Job Schedule `/jobs`, Dispatch & Applicator View `/dispatch`, My Field Jobs `/field`, App Records `/application-records` }, Team Board, Notifications. No office finance/sales leaks into their menu — the nav itself is clean.

1. **7:00 AM — opens the PWA.** Lands on `/` = the **office Dashboard**: Active Orders, quote pipeline, open POs, inventory units, monthly charts (Dashboard.tsx:382 `showFull = !isDriver` — drivers were slimmed, applicators weren't). Nothing about their jobs. **Taps so far: 0 useful.**

2. **Finds today's work.** Hamburger (tap 1) → "My Field Jobs" (tap 2) → FieldView, the purpose-built dark phone page. Cards show job #, customer, PENDING/ACTIVE badge, "N locations assigned to you", job-total acres — **but no date and no address**. Cards sort by job *number* (get_dispatched_list ORDER BY j.job_number, migration 20260626150000:109; no job_date in the payload), and finished DONE/BILLED jobs stay in the list. To find *today's* job they expand cards one at a time (tap 3, 4, 5... each a network fetch) until a date matches. The Map view helps if boundaries are drawn. Once expanded, the card is genuinely good for "what to spray": customer, date, locations with acres, crops, and each chemical **with rate/acre and total quantity** (FieldView.tsx:524-546). No REI/PHI. Also shows the customer's per-product **dollar charges**.

3. **STALL #1 — nothing on this page does anything.** FieldView is read-only by design (header comment, FieldView.tsx:7): no Start button, no Complete, no applied-info entry, and no link to the job page. It's a brochure. To act, they back out.

4. **Detour to the office table.** Hamburger (tap 6) → "Job Schedule" (tap 7) → Jobs.tsx, a wide multi-column desktop DataTable (filters bar, mass-edit, CSV/PDF export) that scrolls sideways on a phone. RLS scopes it to their own jobs. Find the job, tap the job number (tap 8) → `/jobs/:id`.

5. **JobDetail on a phone.** A ~3,700-line office form loads: the job plus **five full `select('*')` lookup tables** (all customers, all fields, all 604 products, vehicles — JobDetail.tsx:1324-1328) on a field-edge connection, all to power edit dropdowns that are disabled for them (isEditable = admin/sales, line 241). They can, usefully, print the Field Sheet / Chem Report / Loader / WPS PDFs (ungated, line 2535-2552).

6. **STALL #2 — cannot start the job.** The job is `scheduled`. The Start Job button requires isEditable (line 2561) — hidden for applicators — even though the `start_job` RPC *explicitly authorizes the assigned applicator* (migration 20260611211058). FieldView has no start either; grep confirms JobDetail is the only start_job call site in the app. **The applicator phones the office: "can you start job 1042?"** Someone at a desk clicks Start. (If the office forgets, nothing else can proceed: complete_job requires `in_progress`, migration 20260702175000:88 — the wrong-order guard is correct but the applicator has no way to satisfy it.)

7. **Sprays the field.** The app plays no role during application. Actual per-field acres, passes, and lot numbers go on paper or in their head.

8. **Records completion — the one thing that works.** Back on JobDetail (status now ACTIVE), the **Complete Job** button is visible (canComplete has no role gate, line 2491; complete_job authorizes the assigned applicator server-side). Tap Complete (tap 9) → modal: wind, direction, temp, humidity, actual gallons, notes — **all optional** (low burden, good) — with a one-tap "Use current weather at [field]" Open-Meteo auto-fill (line 3509-3513, genuinely nice). Tap Complete (tap 10) → confirm dialog (tap 11). Inventory deducts, an application record is created. **~11 taps + two heavy page loads + one phone call to the office**, assuming they knew to skip their own namesake page.

9. **Poor-signal reality check.** If the Complete RPC fails on weak signal: error toast, modal stays open, idempotency key is preserved for retry (safe). But there is **no offline queue for jobs** — offlineSync.ts:179 has a `complete_job` replay branch that *nothing ever enqueues* (queueAction exists only in the driver pages FieldStop.tsx:309 / DeliveryDetail.tsx:778). If they give up and close the tab, the entry is lost. Meanwhile on FieldView, a failed *load* renders the permanent copy "**No jobs assigned to you right now**" (FieldView.tsx:142-146 → 414-423) — a signal problem reads as a day off. The drivers — who per the owner won't reliably use phones — got the offline stepper, signature capture, and queued sync; the phones-first applicators got none of it.

10. **After completion — trap buttons.** Status flips to `completed` and the action bar now shows **Transfer to Invoice** (canTransfer, no role gate, line 2492) — tapping it returns "Not authorized: requires admin,sales_rep role" (migration 20260622020000:71). Similarly, all day long a **Cancel Job** button was visible (line 2555, no role gate) whose direct table UPDATE is RLS-blocked for applicators (phase-5 hardening, migration 20260430180000:28-32) — it can only ever error. The one thing they *should* see — "you're done, the office bills it" — isn't said.

11. **The office re-keys what the applicator knew.** Per-field applied acres (which drive `applied_acres` → remaining acres → the per-acre bill) live in AppliedRecordsManager, passed `canEdit` = admin/sales-only (JobDetail.tsx:3284); lot numbers are explicitly office-only ("applicators can view records but not edit lots", ApplicationRecords.tsx:52-53); the invoice's actual-acres/diluent/structured weather live on `/invoices/field-app/:id`, an admin/sales route (App.tsx:208-209). Only JobAttachments (GPS log files) got the assigned-applicator exception (line 3350). Everything else round-trips through paper.

**Bottom line:** the read side of the applicator's phone day is 80% built (FieldView is a genuinely good viewer; the weather auto-fill and optional fields show real phone empathy), but the *write* side is wired to the wrong screens and roles: they can't start, their page can't act, their completion can't queue offline, and their field knowledge is double-entered by the office. Fixes are mostly small UI gates and one RPC column — the server-side authorization model already supports the correct flow.


===========


# JOURNEY: delivery-day

## Persona walkthrough — delivery day, both completion paths (Channel A)

### Path (a): driver on a phone at the farm

1. **Operations → My Route** (`/my-route`, nav at `Sidebar.tsx:185`; drivers see only their assigned stops — `FieldRoute.tsx:4-8`). **Tap 1:** tap the stop card → opens FieldStop (`FieldRoute.tsx:170`).
2. **Arrive step** — address + delivery notes shown. **Tap 2:** "I'm Here — Start Delivery" (`FieldStop.tsx:468-476`) → calls `confirm_delivery` (scheduled → in_progress). Online-only by design (offline shows "connect to start", `:199-201`). *Round-trip 1.*
3. **Verify step** — quantities pre-filled to full; +/- steppers for shorts, short lines get a "→ remainder" chip (`:510-513`). **Tap 3:** "All Full — Continue" (`:526`).
4. **Sign step** — **must type the signer's name** (button disabled until non-empty, `:547-550`); finger-signature canvas is optional. **Tap 4:** "Continue to Photo".
5. **Photo step** — optional, but skipping still costs **Tap 5:** "Skip — No Photo" (`:571-574`).
6. **Review step** — summary + "email receipt" checkbox. **Tap 6:** "Complete Delivery" (`:599-601`) → **Tap 7:** a second generic ConfirmModal "Complete" (`:621-630`) → calls `complete_delivery` with `p_signed_by` (required — no default, migration `20260620220000:25`), `p_quantities` only when partial. *Round-trip 2.* Offline completion queues for replay (`:307-329`).
7. **Done screen** shows "Draft invoice INV-xxx created" when one was made, then "Next Stop" (tap 8) back to the route.

**Phone total: 7 taps + typing the signer's name per stop** (8 with Next Stop). Solid guided flow; the fat is the double-confirm and the forced photo-skip tap (findings), and there's no "nobody present" option for shed drops.

### Path (b): office keys in yesterday's paper ticket

The delivery sits at **scheduled**. There is **no single "mark delivered" affordance anywhere**:

1. **Click 1:** Operations → Deliveries. The list's quick **Complete** button only renders for `in_progress` rows (`Deliveries.tsx:1046-1056`) — a paper-ticket delivery never qualifies.
2. **Click 2:** open the delivery row → DeliveryDetail.
3. **Click 3:** "Start Delivery" (`DeliveryDetail.tsx:1500-1508`) → StartDeliveryModal opens and warns about *verifying items are loaded on the truck/trailer* (`StartDeliveryModal.tsx:39-48`) — the truck came back yesterday.
4. **Click 4:** "Start Delivery" in the modal → `confirm_delivery`. *Round-trip 1*, page refetches, Complete section appears (`:2055`).
5. Type "Signed By" off the paper ticket (required); adjust quantities if the ticket shows shorts.
6. **Click 5:** "Complete Delivery" (`:2155-2162`) → **Click 6:** confirm in a second ConfirmModal (`:2441-2453`) → `complete_delivery`. *Round-trip 2.*

**Office total: 6 clicks + typing + 2 sequential server waits per ticket.** The two-step is DB-enforced — `complete_delivery` rejects non-in_progress with "Call confirm_delivery() first" (`20260430240000:72-76`, `20260620220000:74-76`) — so no UI shortcut exists today. **Stall points:** the truck-load modal (wrong mental model), the mid-flow wait for the refetch, and there's no way to backdate — `completed_at = now()`, invoice date = today (`20260620220000:144-148, 252-257`). If yesterday's stock count drifted low, the hard inventory pre-check refuses the whole entry (`:119-135`).

*If a driver started the stop but never finished it (in_progress), the office DOES have a fast path: list row → Complete → type name → Mark Complete = 3 clicks (`Deliveries.tsx:352-393, 1412-1435`) — full quantities only.*

### Creating the delivery from an order

OrderDetail → **"Schedule Delivery"** (`OrderDetail.tsx:1140`) → `/deliveries/new?order=<id>` arrives **pre-filled**: order pre-selected (`NewDelivery.tsx:53`), items defaulted to each line's remaining quantity (`:190-202`), default address auto-picked (`:186-187`), date defaults to today (`:65`); driver/time optional. Duplicate-delivery warning if the order already has an active delivery (`:365-371`). Atomic create via `create_delivery_with_items` (`:391-408`). **~3 clicks from the order — this leg is good.** (ToShip is read-only "what do I owe" — its schedule-delivery act-in-place buttons were deferred, `ToShip.tsx:9-10`.)

### Contradiction settled: the Delivery Remainders page

- **Exists:** `src/pages/DeliveryRemainders.tsx`. **Routed:** `/delivery-remainders`, admin+sales_rep (`App.tsx:84, 256`). **In the nav:** Operations → "Remainders" (`Sidebar.tsx:186`); the Deliveries page also deep-links to it (`Deliveries.tsx:1204`).
- **Does NOT call `get_customer_delivery_remainders`** — it queries the `delivery_remainders` table directly with joins (`DeliveryRemainders.tsx:51-61`). That RPC has **zero callers app-wide** (orphaned; see finding).
- **CAN create a follow-up delivery:** per-row "Follow-up" button → `create_followup_delivery` (`DeliveryRemainders.tsx:112`; also on DeliveryDetail's completed view, `DeliveryDetail.tsx:693, 2172-2179`). The RPC (`20260526151856:1101-1196`) builds a new **scheduled** delivery carrying all pending remainder items (default date tomorrow), marks remainders `scheduled`, links `followup_delivery_id`, notifies the driver.

### What `complete_delivery` auto-creates (latest: `20260620220000`)

On completion it: deducts on-hand inventory (after a **hard** sufficiency pre-check `:119-135`), writes `delivered` inventory transactions, updates order-item delivered/remaining and flips the order to fulfilled/partially_fulfilled (`:214-221`), inserts `delivery_remainders` for short lines (`:198-212`), and — **only if the order has zero active invoices** (`:244-250`) — auto-creates a **draft `chemical_sale` invoice** for the *delivered* quantities at order prices (`:250-293`), with a `financial_audit_log` breadcrumb (`:300-315`). Warns (never blocks) on completion dates inside a closed accounting period (`:78-117`). **The catch:** that "zero active invoices on the order" guard is what makes a completed follow-up delivery unbillable by every path — the top finding.


===========


# JOURNEY: billing-day

## Persona walkthrough — the billing afternoon (one office biller, both channels)

Scenario: 8 completed spray jobs to bill, 12 delivered-but-unbilled chemical orders, ~10 checks in the mail pile. Biller is office staff (role `sales_rep`; owner-as-admin variant noted where it differs).

### Part 1 — Bill the completed spray jobs (custom-application channel)

1. **Office Cockpit** (`/office-cockpit`, top-level nav). The "Unbilled Jobs (8)" tile is a real queue — completed jobs with no invoice, oldest first (OfficeCockpit.tsx:288-295). Good start. But every row links to the **job**, not to a billing action (:652-655).
2. Click job row → **Job Detail** (page 2). Hunt the header button row for **"Transfer to Invoice"** (JobDetail.tsx:2573) → confirm modal ("This will create a new invoice from the job chemicals", :3762-3769). 2 clicks. Everything pre-fills server-side: chemicals → priced quantity lines, per-acre application fee, per-field grower-share pricing, landlord/tenant share rows (transfer_job_to_invoice, 20260622020000).
3. Land on **Invoice Detail** (`/field-invoices/{id}`, page 3) — the *generic* editor, because a transferred invoice has quantity lines and no per-acre locations (FieldApplicationInvoice.tsx:768-778 bounces it here). **Mode surprise:** whether each field billed as a flat "$X/ac grower share" (chemicals zeroed out "— included in grower share") or as itemized chemicals was decided by a `price_override_cents` sitting on Field Setup, set who-knows-when — nothing on the job or the invoice announced it beforehand (20260630180000:310-341). The engine editor's split preview (`preview_field_app_invoice_split`) shows per-customer cards — tier, share acres, lines, penny-exact reconcile badge — but **only after clicking Preview** (FieldApplicationInvoice.tsx:2649), and only on engine-built invoices, which a job can't produce (no job→engine seeding exists).
4. Post from here? **Admin only** — the generic editor's Post button is `editable && isAdmin` (InvoiceDetail.tsx:1111), even though the `post_invoice` RPC allows sales reps (20260702160000:100). The rep biller must transfer all 8 jobs first, then:
5. **Field Invoices → Unposted tray** (`/field-invoices/unposted`, page 4): "Post All" posts every *visible* invoice one-by-one with honest per-invoice failure reporting (FieldInvoicesUnposted.tsx:337-366). No per-row Post exists — it's all-or-everything-shown, so posting *one* invoice means filtering the tray down to it first. Split groups (landlord/tenant) get posted member-by-member here — the group atomicity that Invoice Detail and the cockpit carefully protect (post_invoice_group) is silently bypassed (finding 6).
   - *Cockpit alternative:* "Post all clean" is genuinely good — watchdog-flag- and pricing-aware, fresh re-sweep before money moves (OfficeCockpit.tsx:490-575) — but it deliberately skips every grouped invoice, i.e. precisely the multi-grower jobs, which go back to one-at-a-time posting.
6. Per job: ~6 clicks, 3 page loads, then manual nav back to the queue. No "bill next job" chaining. 8 jobs ≈ 50 clicks / 25 page loads.
7. The confirm dialogs do say plainly "Posting locks an invoice and records it in the books" (OfficeCockpit.tsx:1003, FieldInvoicesUnposted.tsx:615). The real surprise comes later: a posted **field-app** invoice can be un-posted; a posted **chemical** invoice cannot (UI hides Unpost for chemical types — InvoiceDetail.tsx:1194 — though the RPC would allow it).

### Part 2 — Bill the delivered chemical orders

8. Good news: `complete_delivery` **auto-creates a draft invoice** from delivered quantities (20260620220000:244-296), so "delivered-but-uninvoiced" is normally already half-done. Bad news: **no queue shows these drafts.** The cockpit's "Ready to Post" tile is field-app-only (OfficeCockpit.tsx:302); the biller must *know* to open **Invoices** (page 5), where "Unposted: 12" is a non-clickable stat card, and set the single-select status filter (Draft, then again Unposted).
9. Select rows → "Post 12 Selected". For a **sales rep the entire batch bar doesn't render** (Invoices.tsx:603, admin-only) — their only chemical-posting path is opening each **Order Detail** (pages 6…17) and clicking "Post all drafts" per order (OrderDetail.tsx:1444-1448). For the admin, batch post fires **with no confirm modal** and is **all-or-nothing** at the DB: one closed-period date aborts all 12 with a single unexplained error (batch_post_invoices, 20260611211058).
10. **Landlord/tenant in this channel:** the auto-draft bills 100% to the order's customer — it never reads the order's field-owner allocations (20260620220000:250-258). The per-owner split path (`create_split_invoices_from_order`) only runs from Order Detail's "Create Invoice", which is gated off once a delivery is scheduled (OrderDetail.tsx:863-869). Normal flow ⇒ split never happens. Compare: same split concept, three implementations — per-customer invoices (orders), per-customer invoice group (field-app engine), one-invoice-plus-`invoice_shares` annotations (job transfer). The biller is expected to not notice the difference.
11. A truly *missing* invoice (auto-draft failed, or voided) surfaces only on **Integrity Cleanup** — admin-only, filed under Finance, the sole caller of `create_invoice_for_unbilled_delivery` (IntegrityCleanup.tsx:316). A biller would never look there.

### Part 3 — Enter today's checks

12. **Payments** (`/payments`, page ~6-18 depending on role). This page is the bright spot: type 2 letters → pick customer → enter check amount + reference → **Auto-Allocate** (oldest-first) or type per-row amounts → Record; remainder auto-becomes prepay credit with an explicit confirm; "Next Check" keeps the customer loaded. 5-7 clicks per check.
13. **Stall point #1 (the big one):** the invoice list loads `status='posted'` only (PaymentAllocation.tsx:152). The 6 AM cron flips past-due invoices to `overdue` daily (20260316121800:18) — so the oldest invoices, the ones this check is *for*, are invisible. Invoice Detail's Record Payment is also posted-only + admin-only (InvoiceDetail.tsx:1163). An overdue invoice is unpayable through the UI; the check dead-ends into prepay.
14. **Stall point #2:** a landlord paying the share printed on their statement (from a job-transfer invoice's `invoice_shares`) has **no invoice under their customer_id** — the biller searches the landlord, finds nothing, and has to guess (prepay? key it under the tenant?).

### Tally

- **Pages touched:** admin ≈ 6 distinct (Cockpit, JobDetail×8, InvoiceDetail×8, Unposted tray, Invoices, Payments) with ~35+ page loads; sales rep adds Order Detail×12 ≈ 7 distinct / ~50 loads.
- **Queues that hand you work:** cockpit unbilled-jobs tile, cockpit ready-to-post tile (field-app only), unposted tray. **Places you must hunt:** chemical drafts (filter the Invoices list), delivered-uninvoiced (admin-only Integrity Cleanup), overdue invoices to pay (invisible), landlord shares (not payable), which billing mode a field will use (invisible until Preview/posted).


===========


# JOURNEY: application-only-job

## Persona walkthrough — "I bought my own chemical; just spray it on" (application-only job, customer-supplied product)

**Cast:** office/sales user on desktop creating and billing the job; applicator on a phone completing it. Customer wants 200 acres sprayed with a jug of glyphosate he bought at the co-op.

### The attempt

1. **Create the job** — Jobs → New Job (2 clicks), fill customer, date, applicator, add the field + acres (~8–10 interactions). Smooth so far.
2. **Enter the chemical** — the chemical row's only input is a catalog product search (`JobDetail.tsx` product picker, `is_active=true` products only). Type the customer's brand → **"No products match" — dead end.** There is no "customer-supplied" checkbox, no free-text line (`job_chemicals.product_id` is NOT NULL, migration `20260215200000:75-86`; repo-wide grep for any supplied-by concept = 0 matches).
3. **Stall #1 — invent a product.** Office detours to Products → New Product and creates the customer's jug as a full sellable catalog item (name, form, units, tier prices — ~10 fields). That pseudo-product now appears in QuoteBuilder and every order picker forever (`QuoteBuilder.tsx:381` filters the same `is_active` flag, so hiding it also removes it from the job picker).
4. **Stall #2 — the price trap.** Picking the product auto-fills its tier price onto the line. Nothing indicates this line will be *billed*; the office must know to hand-zero `price_per_unit_cents` or the customer gets charged for chemical he already owns (`transfer_job_to_invoice` bills `price × quantity`, `20260622020000:148,170`).
5. **Save → schedule.** The moment the job saves as scheduled, the auto-reserve engine places a **full-demand hold on our warehouse** for the customer's own chemical (`_sync_job_holds`, `20260702174000:92-108`). The product has no stock, so dispatch shortfall warnings report the full demand (`:119-120`) — every dispatcher now sees a phantom shortage.
6. **Applicator completes on phone.** `complete_job` deducts physical stock for every line with quantity > 0 — for a never-stocked product it **inserts a negative inventory row** (`20260702175000:221-223`) and writes a `job_applied` transaction flagged "SHORT STOCK — review required" (`:232-242`). Our books now say we own −40 gallons of a product we never bought. (Upside: the application record is correct — product, rate, quantity, weather, fields, `:124-177`.)
7. **Bill it** — JobDetail → **Transfer to Invoice** (1 click, `JobDetail.tsx:2576`). Result: an invoice with a $0 chemical line and **no application fee** — total **$0.00**. The fee branch exists (`20260622020000:233`) but keys on `jobs.application_service_id`, which **no code path ever sets** (live-verified: `save_job`/`create_job_from_quote_section` never touch it; JobDetail has no service picker; 0 of 2 live jobs have it). The per-acre fee — the entire revenue of this job — cannot be billed from the job. **Hard stall.**
8. **Recovery — a second document.** Office navigates to `/invoices/field-app/new` and re-keys everything: customer's fields (one by one), applied acres per field, picks the Application Service → save. This **works** — `save_field_app_invoice` emits the fee line independent of chemicals (`20260630180000:496-527`), so a clean fee-only invoice exists (~12–15 clicks, all data typed twice).
9. **Aftermath.** The fee invoice has no `job_id` (`20260630180000:62` — the RPC can't take one), so the job stays `completed`: it nags in **Field Invoices → Unbilled forever** (`UnbilledApplications.tsx:15,77-79`), and the still-live Transfer button is a one-click duplicate-invoice trap (automatic, if auto-draft is ever switched on — `complete_job:266-285`). The standalone invoice also wrote **no application record** (0 `application_records` writes in `save_field_app_invoice`).

### The alternative branch (skip the chemical to protect inventory)

Leave the chemical off the job: steps 3–6's corruption vanishes — but the permanent spray record's `product_data` is `[]` ("nothing was applied"), the REI/PHI watchdog never fires for that product (it joins `job_chemicals` — `20260629220000:440`), and the proof-of-application shows no products. The billing dead-end at step 7 is unchanged. A third, undiscoverable hack exists — hand-enter quantity 0 and keep the rate (deduction loop filters `quantity > 0`, `20260702175000:197`; holds filter `SUM > 0`) — which keeps the product on the record but states 0 applied, and no screen hints that this trick exists.

### VERDICT — exists via workaround, and the workaround is a fork

There is **no single path** that yields (a) an honest spray record, (b) untouched inventory, and (c) a billable application fee. Today the owner must choose two of three:
- **List the chemical** → record ✓, inventory ✗ (negative stock + phantom holds), fee ✗ (dead on the job rail);
- **Omit the chemical** → inventory ✓, record ✗ (empty, safety flags silent), fee ✗;
- **Standalone invoice only (skip jobs)** → fee ✓, inventory ✓, but no scheduling/dispatch/applicator flow and no record.
The working full sequence is a two-document workaround (chem-less job for ops + re-keyed standalone invoice for the fee) that permanently pollutes the Unbilled list and leaves a duplicate-bill trap armed. Roughly **25–30 clicks plus double data entry** for what should be one flow. Root causes are small and fixable: no job-level application-service picker (kills the fee), and no customer-supplied flag on job chemicals (fuses record-keeping to stock deduction and billing).