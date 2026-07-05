# CRX Manager — Business Workflow & Daily-Use Review

**Date:** 2026-07-04/05 · **Scope:** whole app, both sales channels, read-only · **For:** Mason (owner)

**How this was done:** 13 analyst agents each walked one slice of the app (7 "day in the life" persona walkthroughs + 6 structural analyses) against the real code and the live database, producing **121 candidate findings**, a **navigation blueprint**, and an **entry-point consolidation proposal**. Every finding carries a code citation. An adversarial verification pass re-checks each finding (status recorded in `findings.json`); the four headline money findings were **additionally verified by hand** (files opened, lines read) and key screens were **walked in the live production app** (see `live-app-anchors.md`). Known items from previous audits (units bug, label data, thin scheduling UI, etc.) were excluded and appear only in the wave plan.

**Companion files in this folder:** `findings.json` (all 121, with citations) · `journeys.md` (the 7 walkthroughs with click counts) · `proposals.md` (full navigation blueprint + entry-point catalog) · `live-app-anchors.md` (what was verified in the running app).

---

## 1. Executive summary

**The foundation is good.** The two-channel architecture — chemical sales (quote → order → delivery → invoice) and custom application (job → dispatch → apply → field invoice) — is correctly separated in the database: bookings, inventory holds, and job draws don't double-count, prices lock correctly, posting/AR machinery is solid, and several suspected problems turned out to be **already handled well** (delivery remainders have a full page + reminder emails; quote versioning is complete; posting warns before locking and can be undone; the order-detail invoice button is one smart button, not two confusing ones).

**But the app is not ready to run the business day-to-day, for three reasons:**

1. **The spray-side billing rail has real money bugs.** The per-acre application fee — the core revenue of your application channel — is **never billed** on any job-created invoice (the field that triggers it is never set by any screen). Follow-up deliveries of shorted product **can never be billed** (the money leaks silently on every partial delivery). The morning after an invoice goes overdue, it **disappears from the payments screen** — the exact invoices checks arrive for become unpayable. And there's no way to record spraying a customer's own chemical without corrupting your inventory.

2. **The people you said will use it can't do their jobs on it.** Applicators (your phone users) get a **read-only** phone page: they cannot start their own job, complete it, or even see the date on the job card — every status change routes through the office. The office, in turn, can't mark yesterday's paper-ticket delivery delivered in fewer than 6 clicks and 2 modals, and the one-screen phone-order tool (Quick Delivery) is hidden behind a gray secondary button on a page nobody would look at.

3. **The menu doesn't match the business, and the app doesn't tell you what needs attention.** 64 links in 8 groups; "Finance" is a 19-item junk drawer holding licenses and recall lookups; the two channels are shredded across three groups. Meanwhile the signals that would run your day — job scheduled with no applicator, planned booking silently holding stock past its date, product below zero, quote about to auto-expire after a revision — either don't exist or were **built and never plugged in** (a "expiring planned holds" alert RPC exists in the database with zero callers; all 17 currently-negative products are invisible to every low-stock filter).

**The plan:** three waves before Oct 1. Wave 1 fixes the money and lifecycle correctness (mostly small database migrations, each individually gated). Wave 2 makes the four daily flows fast (applicator phone day, phone orders, dispatch, billing/delivery afternoons). Wave 3 re-organizes navigation around the two channels and wires up the safety-net signals. Nothing is deleted anywhere; ~10 decisions are yours to make (listed in §6 with recommendations).

---

## 2. The target picture

### 2a. One obvious path per real-world situation

Today there are **7 ways to create an order, 12 ways to create an invoice, and 2 ways to create a job** — ~22 create-buttons across 13 pages. The engines under them are mostly right; the problem is presentation. The consolidation (full detail in `proposals.md`):

| Situation | The ONE path (after) | What changes |
|---|---|---|
| Big-account program booking | QuoteBuilder, one **"Create Order ▾"** control (Convert whole / Draw part) | merges the two side-by-side buttons; Convert works on revised quotes (today it vanishes) |
| Fast phone order (book now, deliver later) | **New Order** — promoted to first Dashboard quick action | page already good; needs customer pre-fill + booking-awareness (§3.6) |
| Counter sale (walks out the door now) | **Quick Delivery**, renamed **"Sell & Deliver Now"**, on the Dashboard + top bar | today it's invisible; it's the only 1-screen order+delivery+invoice tool |
| Create a spray job | **New Job** button on both Jobs and Dispatch Board | today hidden in a "..." menu on the board schedulers live on |
| Bill a completed job | **"Create Invoice" directly on the unbilled-jobs queue** (job-linked transfer) | today: 3 pages per job; the prominent "New Field Application" button everywhere creates *unlinked* invoices → double-bill risk |
| Bill a delivery | unchanged — auto-draft on completion (already right) | fix its two bugs (§3.2, §3.3) |
| Misc charge (freight, a fee) | a **"Misc Charge"** button (owner decision — the page exists today but has NO button anywhere) | today reachable only by typing the URL |
| Credit memo | unchanged — Returns → Issue Credit (already exactly one path) | make the credit *applicable* to invoices (§3.5) |

### 2b. The new menu (summary — full 82-route mapping in `proposals.md`, nothing lost)

- **Top:** **Today** (renamed Office Cockpit — your morning screen and post-login landing) · **To-Ship** (the load-out board) · a global **"+ New"** button in the top bar (Quote · Order · Delivery · Job · Field Invoice · PO · Quick Receive) so every create is 2 clicks from anywhere.
- **SELL & DELIVER** (chemical channel): Quotes & Bookings · Orders · Deliveries · My Route · Remainders · Invoices — Chemical · Returns.
- **SPRAY FIELDS** (application channel): Job Schedule · Dispatch Board · Field Invoices · Record Book · Program Tracker · Blend Recipes.
- **CUSTOMERS & FIELDS** · **INVENTORY & BUYING** (products, POs, receiving) · **MONEY** (payments, A/R workspace with its tabs, A/P, month-end, commissions) · **COMPLIANCE & RECORDS** (licenses, lot trace, watchdog, label review, **blend tickets — moved off the daily path per your answer**) · **INSIGHTS** (reports) · **SETUP**.
- **Role-aware:** applicators land on **My Day** (`/field`) with a 5-item phone menu; drivers land on My Route. Today an applicator logging in gets your office KPI dashboard.
- Fixes on the way: `/payment-history` orphan gets a home; 3 duplicate A/R menu entries collapse into the A/R workspace tabs; command palette gets the ~14 pages it's missing (including all three role landing pages); the Settings permission screen adopts the same group names as the menu.

Click counts after: phone booking **2 clicks from anywhere**, spray-job scheduling **2**, load-out **1**, "what needs attention" **0** (it's the landing page).

---

## 3. The top 10 improvement areas

Severity is about *your daily money and time*, not code style. Effort: S = under a day, M = 1–3 days, L = a week-plus. "DB" means a database migration (each one individually reviewed + your explicit OK before it touches live).

### 3.1 · CRITICAL — The spray-job billing rail doesn't bill your application fee (and can't handle customer-supplied chemical)

**What's wrong (verified by hand):**
- The invoice engine only adds your **per-acre application fee** when the job carries an `application_service_id` — and **no screen in the app ever sets it** (zero references in the job form; 0 of the 2 live jobs have it). Every job-billed invoice today is **chemicals-only**; a fee-only job bills **$0.00**. The core revenue of the application channel is silently missing. (`20260622020000:233`, JobDetail.tsx: no matches)
- There is **no "customer supplied" concept** on job chemicals. Recording the honest truth (the chemical that was sprayed) forces you to create it as a sellable catalog product, lets the reservation engine phantom-hold your shed for it, **deducts your inventory negative** at completion, and bills the customer for product they own. Leaving it off instead produces a **legal application record that says nothing was sprayed** and disables the REI/PHI safety flags. (`20260215200000:75-86`, `20260702175000:193-243`)
- A job can be scheduled from an **accepted** (already fully delivered) booking with no warning — it re-bills the full chemical price and re-deducts stock. That's your exact "deliver it, then they ask us to spray it too" scenario. (`20260703200000:457-459`)
- Voiding a posted job invoice **permanently strands the job** — it can never be re-billed (blend tickets got this safety net; jobs didn't). (`20260622020000:90`)
- Billing a job via the standalone field-invoice editor (the prominent button) leaves the job "unbilled" forever and leaves a live path to **double-bill** it.

**The fix (Wave 1, DB+UI, ~4 small migrations + form fields):** add the ApplicationServicePicker to the job form (+ optional per-customer default) so the existing fee branch starts working; add a `customer_supplied` checkbox on job chemicals (skip stock deduction + bill at $0, keep the legal record complete); block/warn Schedule-Job on accepted bookings; revert job → completed when its invoice voids; put the job-linked "Create Invoice" on the unbilled queue and demote the manual editor. **Risk: low** — each piece is small and additive.

### 3.2 · CRITICAL — Money leaks and dead-ends on the billing/payments day (mostly one-line fixes)

**What's wrong (verified by hand):**
- **Overdue invoices vanish from the Payments page** (it loads `status='posted'` only; a 6am cron flips past-due invoices to `overdue`). The check that arrives for an old invoice can't be applied to it; the money dead-ends into prepay credit or newer invoices, making aging look worse. The database RPC already accepts overdue — this is a **one-line UI fix**. Same gate hides the Record Payment button on the invoice page. (PaymentAllocation.tsx:152 — confirmed)
- **Follow-up deliveries can never be billed.** First delivery goes out short → invoice #1 covers the delivered part → the remainder ships later → its completion finds "order already has an invoice" and creates nothing, and the true-up only touches invoices tied to *this* delivery — so nothing ever adds the remainder to invoice #1. Every other path is guarded off, and the "unbilled deliveries" finder is blind to it (it filters by order). **Product leaves un-billable on every partial delivery.** (mig `20260620220000:226,244-250` — confirmed by hand)
- **Return credit memos float forever**: a -$2,000 credit memo can't be applied against the $10,000 invoice the customer still owes, so the shorted invoice ages, goes overdue, and triggers dunning emails while the credit sits next to it.
- `allocate_payment` never checks that allocations sum ≤ the check amount (server-side) — a money-path hard-guard gap.
- Posting rights are a patchwork (a sales rep can bulk-post field invoices but not chemical ones; the DB says both may post) and the chemical batch-post is all-or-nothing with one opaque error, unlike every other posting surface.

**The fix (Wave 1, DB+UI):** widen the payments query + button gate to include `overdue` (S); make the delivery auto-invoice check per-delivery instead of per-order (S, one migration — each completed delivery bills its own quantities exactly once); add `apply_credit_memo_to_invoice` (M); add the one-line over-allocation guard (S); pick one posting policy and align all five surfaces (S, owner decision §6). **Risk: low-medium** — the delivery-billing change is the one to review carefully (Codex gate + rolled-back live smoke, as usual).

### 3.3 · HIGH — Landlord/tenant splits and commissions behave differently per channel (you use both)

**What's wrong:**
- **Splits:** chemical orders split into real per-owner invoices (each landlord gets a bill, a statement, an AR balance). Spray jobs instead produce **one invoice to the tenant with "shares" annotations** — the landlord's share prints on their statement, but there is **no landlord invoice to pay**: their check can't be allocated, the tenant's AR carries 100%, and their reminders fire for money the landlord owes. The delivery auto-invoice also ignores order field-splits entirely (mono-bills the primary customer), and the split path is gated off once a delivery exists — so in the *normal* flow, splits never happen even on the chemical side.
- **Commissions:** fulfilling a booking as a *delivery* pays the rep's commission; fulfilling the *same booking* by *spraying it* pays **zero** (no commission logic anywhere on the job rail). Reps get financially punished whenever the customer picks application.

**The fix (Wave 1–2, DB, L total):** make per-customer invoices the one split model everywhere — job billing emits an invoice group per owner (the engine already does this on the standalone editor), and the delivery auto-draft becomes allocation-aware. Copy `commission_split` onto jobs and insert commission rows on job invoicing (after you confirm the business rule — §6). **Risk: medium** — this is the biggest Wave-1 item; staged migrations, heavy review.

### 3.4 · HIGH — The applicator's phone day is read-only (your #2 daily flow doesn't work from the field)

**What's wrong (verified by hand):** the database *authorizes* the assigned applicator to start their own job, but no screen shows them a Start button (JobDetail gates it `isEditable` = office roles — confirmed at `JobDetail.tsx:2561`); "My Field Jobs" — their namesake page — has **zero action buttons**, no link to the job, no date on the card face, sorts by job number, and keeps DONE/CANCELLED cards forever. So the field lifecycle stalls until the office clicks Start on a desktop. Meanwhile the buttons an applicator *does* see (Cancel Job, Transfer to Invoice) **always fail with errors** for their role. There's no offline queueing for their one write (`complete_job`) even though the replay machinery exists as dead code (the drivers — who you said *won't* use phones — got the full offline treatment). A failed fetch shows "No jobs assigned to you right now" (a poor-signal lie), they land on the office KPI dashboard at login, no notification fires when a job is assigned/moved (drivers get one), and the per-acre billing data (applied acres per field, lots) is office-only so it gets keyed twice.

**The fix (Wave 2, mostly UI, M-L):** make **My Day** (`/field`) their whole world — date on the card, Today-first sort, Done section, **Start / Complete buttons on the card** (RPCs already authorize them), the same offline queueing pattern FieldStop uses, role-based landing, assignment/reschedule notifications, honest error state, hide the office-only trap buttons, and (owner decision) let the applicator enter per-field applied acres at completion so the office reviews instead of re-types. **Risk: low** — server authorization already exists; this is UI + one RPC field addition.

### 3.5 · HIGH — Job assignment is two disconnected systems, and a stalled job is invisible

**What's wrong:** JobDetail's "Applicator" dropdown writes `jobs.applicator_id`; the Dispatch Board wizard writes `job_location_dispatches`. **The phone page reads only the second; the office Jobs list reads only the first.** Assign Bob on JobDetail → nothing ever reaches Bob's phone. Dispatch via the wizard → the Jobs list still shows "-" (or the old name). Bulk reassign edits only the first. Nothing anywhere shows "scheduled but never dispatched" — no column, filter, tile, or alert — so a job can quietly miss its spray window (the classic failure: morning arrives, nobody was told). Dispatch rows also never close (completed/cancelled jobs stay "dispatched" forever, burying the phone list), the per-job "Dispatch Locations" button opens the *global* wizard with nothing pre-selected, and re-dispatching silently steals a location from whoever had it, with no warning.

**The fix (Wave 2, DB+UI, M):** one action does both — saving an Applicator auto-creates/refreshes the whole-job dispatch (wizard remains for split crews); a "Needs dispatch" cockpit tile + Jobs-list badge; a tiny migration to close dispatch rows when the job completes/cancels; job-scoped wizard opening; an "already assigned to X" chip + confirm on reassign. **Risk: low-medium.**

### 3.6 · HIGH — The fast phone-order path is hidden, inconsistent, and booking-blind

**What's wrong:** Quick Delivery (the only 1-screen book+deliver+invoice tool) is invisible — not on the Dashboard, palette, or customer page, and it's the *secondary* button on Deliveries. The two ways to book the same 20-gal order enforce **opposite stock rules** (Quick Delivery hard-blocks on today's net stock — ignoring Wednesday's incoming PO for a Thursday delivery — while New Order warns and counts on-order stock). **No order screen knows the caller has an open booking**, so the natural direct-order double-counts demand against the booking's hold, bills today's tier price instead of the locked program price, and leaves a phantom booking balance. "Deliver Thursday" has no field on the order — the promise lives in the operator's head across three screens, and nothing chases a missed promise. Plus stacked friction: no-search customer dropdown, a 7-day duplicate-order interrupt on every repeat buyer, a double-confirm, no stock numbers in the Quick Delivery picker.

One more, upgraded by the verification pass: the Quick Delivery product picker **displays the tier-1 price to every customer** — a tier-3 customer sees $40 for product that will actually bill $28; the tier-aware pricing helper exists in the same file and simply isn't used in the picker (QuickDeliveryModal.tsx:556 vs :165-170).

**The fix (Wave 2, mostly UI, M):** promote Quick Delivery ("Sell & Deliver Now") to the Dashboard/top bar; a **"this customer has an open booking for X at $Y — draw from booking?"** banner on New Order + Quick Delivery (one query; the RPC exists); unify the stock rule (owner decision §6 — recommended: warn-not-block, counting on-order); show the customer's real tier price + stock numbers in the picker; requested-delivery-date on the order (or auto-open Schedule Delivery pre-filled after save); searchable customer picker; soften the duplicate check; drop the double-confirm. **Risk: low** apart from the stock-policy migration.

### 3.7 · HIGH — Season bookings: silent hold expiry, no honest closure, and a send button that doesn't send

**What's wrong:** Planned-program holds silently lapse 14 days after each section's Needed-By date (or **never**, if the date was left blank) — the quote page never shows hold status, expiry, or lapse; the "expiring planned holds" alert RPC **exists in the live DB with zero callers**; and a stale planned booking subtracts from Net Free (the number you trust when taking phone bookings) all season. (The verifier confirmed the mechanism and added a fair caveat: no test booking has actually run past its expiry yet, because the app isn't live — this fires the first real season.) End of season, a partially-drawn booking the customer walks away from **cannot be closed at all** — every terminal path refuses, rollover leaves the source open forever. In the send flow, the **big green primary button ("Mark as Presented") doesn't email anything, and its tooltip claims it does** — while a genuinely failed email still leaves the quote frozen as "sent" with zero lasting evidence either way. Draw-down numbers show **no units** ("remaining 150" — gallons or jugs?), the stale-price warning fires wrongly on every mid-season pull (prices are locked by design — it trains staff to ignore warnings), attaching a Field to a section doesn't default the acres (typed 6 times for a 6-line program), and converting a *revised* quote works from the list but the button vanishes inside the builder.

**The fix (Waves 1–2, mixed, M):** a "Close booking — release remainder" action (new terminal status, mirror of the applied-close — owner semantics §6); wire the existing expiring-holds RPC into a cockpit tile + red past-expiry styling; hold status line on planned quotes; swap the send buttons' prominence + honest tooltip + "Emailed <date> ✓" chip read from the email log; units on every booked/drawn/remaining number; skip the stale-price banner on draw-downs; field-acres defaulting; convert-on-revised parity. **Risk: low** — the closure status is the only real DB change.

### 3.8 · HIGH — Deliveries: both completion paths are slower than they should be, one policy blocks reality

**What's wrong:** the office path for yesterday's paper ticket is 6 clicks + 2 modals + 2 server waits (Start Delivery — with truck-loading copy — then Complete), the list's one-click Complete only appears for in-progress rows, and even Quick Delivery lands back in that slow march. After-the-fact entries **record the wrong delivered date** (no backdating; invoice date starts the terms clock late). The phone flow spends 2 of its 7 taps on pure ceremony and **has no "nobody home" option** — drivers will type junk signatures. `complete_delivery` (and Quick Delivery) **hard-block on stock** while your stated policy everywhere else is warn-never-block — with 17 products already negative, real paper tickets will be un-enterable (the count is what's wrong, not reality). Remainders never flip to "fulfilled" (the status update was dropped in a rewrite), so the Remainders page's filter is permanently empty. The list also sorts farthest-future-first, burying today's trucks.

**The fix (Waves 1–2, DB+UI, M):** one-shot office "Mark Delivered" dialog (chains confirm+complete — no DB change); optional backdated `p_completed_at`; warn-with-override instead of the hard stock block (owner decision §6); "no one present" tap; remainder-fulfilled one-line UPDATE; today-first sort; cancelled/voided filters so mistakes are findable. **Risk: low-medium** (the stock-policy migration is the meaningful one).

### 3.9 · MEDIUM — Navigation, labels, and the billing queue (the "can't find things" fixes)

Everything in §2 (nav blueprint + entry-point consolidation), plus: one **billing home** on the cockpit (a "chemical drafts to post" tile and a "delivered, not invoiced" tile — today chemical drafts have no queue anywhere and the backstop lives on an admin integrity page a biller would never open); batch job-billing ("Create invoices" on the unbilled queue + "bill next job (N left)" chaining); draft/unposted presented as one "Ready to Post" state (they're a distinction without a difference in daily use); voided/cancelled records findable again (commission batches, deliveries, orders); the two "trap" controls fixed (order Change-Status modal offers transitions that always fail; the phone-order path forces a PDF-preview detour just to flip a draft quote to sent — add "Book as Order" on draft quotes); Unpost parity for chemical invoices (the DB allows it; the UI hides it — today a typo means void-and-rebuild); live-app fixes from my own walkthrough: the Quotes filter is missing the new "Fulfilled (Applied)" status, ~150-option native dropdowns need searchable pickers, and the icon-only unlabeled buttons on Quotes/Jobs/FieldInvoices need labels. **Effort: mostly S items in bulk; UI-only. Risk: low.**

### 3.10 · MEDIUM — Safety nets & compliance records (wire what exists, snapshot what the law needs)

**What's wrong:** **all 17 live negative-stock products are invisible** to every low-stock surface (each filter requires a reorder point > 0; the `requires_review` flag complete_job writes is read by no screen). Revised quotes auto-expire with **no warning** (the warning watches 'sent' only; the sweep kills 'sent'+'revised'; the sweep's own log line is known-broken and swallowed). The two client-side alert checks only run if somebody opens the Dashboard that day. No signal exists for "job date arriving, nobody assigned" (the Action Queue has the exact delivery-side sibling). Prepay credit is invisible on the AR/collections screen — you can dun a farmer for money you're already holding. The legal application record is stamped with the **scheduled** date, not the actual spray date, and never snapshots the applicator's license number — weak audit defense once real spraying starts. Blend-ticket ↔ job double-billing has no cross-guard (rare path for you, but it's a money bug when it fires). Season is stamped from different clocks (job date vs billing date) so late-September work lands in one season's spray reports and the next season's revenue.

**The fix (Waves 1–2, small DB+UI, mostly S):** "below zero counts as low stock" (three one-line changes); align expiry warning sets + make the sweep write real notifications; move the two client-side checks into the existing 6am cron family; "unassigned jobs" Action-Queue category + cockpit badge; prepay column on AR aging; record date from actual start + license-number snapshot columns; blend/job cross-guard; season stamped from the job for job-born invoices. **Risk: low.**

---

## 4. Wave plan (to Oct 1)

Each wave ships through the normal pipeline (implement → prove it runs → review gates → your OK on each live migration). Nothing deletes data; all changes are additive or UI-level.

**Wave 1 — "The money is right" (≈ 2–3 weeks of sessions, mostly small DB migrations)**
1. Application-fee billing on jobs + customer-supplied chemical flag + accepted-booking guard + void-un-strands-job (§3.1)
2. Overdue-payable fix + per-delivery auto-invoice fix + credit-memo application + over-allocation guard (§3.2)
3. Split model unification + job commissions (§3.3 — after your two §6 calls)
4. Stock-policy unification (warn-not-block) on quick delivery + delivery completion (§3.6/3.8 — after your §6 call)
5. Compliance record integrity (actual date + license snapshot) + season stamping (§3.10)
6. **The already-known `complete_job` unit-conversion bug** — its prerequisite (the canonical units module + rate-unit dropdowns, "WaveB Phase 1") **shipped to production 2026-07-04 in a parallel session**, so the deduction fix itself is now unblocked; this wave is its natural home
7. Booking closure status (`closed_short` or your preferred name) (§3.7)

**Wave 2 — "The daily flows are fast" (≈ 3–4 weeks, mostly UI)**
8. Applicator My Day rebuild (start/complete on the card, offline, landing, notifications) (§3.4)
9. Assignment unification + needs-dispatch visibility + dispatch-row closure (§3.5)
10. Phone-order fast path (Sell & Deliver Now promotion, booking banner, prefills, friction removal) (§3.6)
11. Office one-shot Mark Delivered + backdating + no-one-present + remainder status (§3.8)
12. Billing home on the cockpit + batch job billing + posting-rights alignment (§3.9)
13. Booking hygiene UI (hold status, units, send-button swap, emailed chip, close action) (§3.7)
14. Safety-net signals (negative stock, expiry alignment, unassigned jobs, prepay-on-AR, cron-ized checks) (§3.10)

**Wave 3 — "It reads like your business" (≈ 1–2 weeks, UI-only)**
15. Navigation blueprint + role landings + "+ New" button + command-palette completion (§2b)
16. Entry-point demotions + label fixes + searchable pickers + accessible buttons (§2a, §3.9)
17. Data hygiene for go-live: clean the junk customer records ("Test Farm Alpha", "A1 TEST FARM", the PO bucket, your own company) — **your call on each record, I only flag them**
18. Buffer + regression pass (full E2E suite) + a fresh `/foundation-ultra-review` once the first real billing cycle has data

**Deliberately NOT in scope:** label CSV load (owner data task) and the grower portal. *(Update while this review ran: the previously-parked P2-8 vendor master, A5 blend-unit conversion, A9 month-end catch-up, and WaveB units Phase 1 all **shipped to production 2026-07-04/05** in the parallel Structure-Wave-2 session — they're done, not parked. None of the 121 findings here are affected by those changes.)*

---

## 5. What was checked and found sound (so you don't wonder)

- Channel separation (order draws vs job holds vs planned bookings) — correct, including the 2026-07 Layer-2 work.
- Delivery remainders: page exists, in nav, auto-created, one-click follow-up, 7/14-day reminder crons — the earlier "no page calls the RPC" suspicion was **false** (one orphaned RPC should be dropped in the next dead-object pass).
- Quote versioning (snapshot/compare/restore incl. job re-sync), post-invoice warnings + unpost as undo, the OrderDetail invoice button (one smart button with guardrails), AP vendor-bill RPCs (all live — one suspected name simply differs), the "Close — Applied" vs "Convert" distinction (well-labeled with help text).

---

## 6. Owner decision list (each with a recommendation)

| # | Decision | My recommendation |
|---|---|---|
| 1 | **Stock policy on Quick Delivery + delivery completion:** warn (allow negative, flag for review) or keep hard blocks? | **Warn-not-block**, matching everything else you decided; keep a hard block only for same-day physical load-out if you want one |
| 2 | **Commissions on the application channel:** does spray revenue (chemical portion? fee?) pay commission? | Commission the **chemical portion** (matches delivered outcome), fee optional — but this is genuinely your pay policy |
| 3 | **Canonical landlord/tenant model:** per-owner invoices everywhere? | **Yes** — one model, both channels; keep single-invoice-with-shares only as an explicit per-job choice |
| 4 | **Closing a walked-away booking remainder:** new terminal status ("closed short")? | Yes; releases holds, keeps drawn history, never bills |
| 5 | **Flip `auto-draft invoice on job completion` ON at go-live?** | **Yes** — it's draft-only, can't duplicate, can't block; decide separately whether applicator completions should also auto-draft (needs a deliberate role-gate loosening) |
| 6 | **Misc charges:** legitimize with a button, or close the hidden route? | Legitimize — you will bill freight/fees eventually; the rule stays for chemical sales |
| 7 | **Who may post invoices:** admin-only or admin+sales? | **Admin + sales** (the DB already says so); align all surfaces |
| 8 | **Applicator data entry depth:** should the phone capture per-field applied acres (and lots)? | Yes for acres (office reviews instead of re-types); lots as phase 2 |
| 9 | **Should the field phone card show customer prices?** | Hide the dollars (rate/quantity is what the sprayer needs) — but it's a business call |
| 10 | **Junk customer cleanup list** (test farms, PO bucket, own company) | I'll produce the exact list; you approve each before anything is touched |
| 11 | **Wave 1 order of operations** | As listed in §4; splits/commissions (item 3) is the biggest and can slide to early Wave 2 if you want faster wins first |

---

## 7. Verification appendix

- **Method:** 13 finder agents (persona walkthroughs read the real pages/RPCs end-to-end; structural agents verified against the live schema with read-only queries) → 121 findings, all cited → adversarial verify pass (an independent agent per batch tries to refute each finding) → main-loop hand-verification of the anchor claims → live-app walkthrough of key screens (`live-app-anchors.md`).
- **Adversarial pass results: 69 CONFIRMED · 2 ADJUSTED · 0 REFUTED · 50 no-verdict** (those batches were lost to a transient API rate limit, not to disagreement — of 71 verdicts rendered, zero findings were refuted). Per-finding status is in `findings.json`. The 2 adjustments: the Quick Delivery picker finding was **upgraded** (it shows the wrong tier price, not just missing stock numbers), and the stale-planned-holds finding gained the "not yet observed in test data" caveat.
- **Hand-verified by me (files opened, lines read) — covers every claim that anchors a §3 section, including the ones the rate-limit skipped:** application-fee-never-billed (§3.1) · customer-supplied concept absent (0 matches repo-wide) · overdue-unpayable (§3.2, `PaymentAllocation.tsx:152`) · follow-up-delivery-unbillable (§3.2, mig `20260620220000:226,244-250`) · applicator-can't-start (§3.4, `JobDetail.tsx:2561`) · FieldView has zero write calls (§3.4) · applicator lands on office dashboard (§3.4, `Dashboard.tsx:381-382`) · job-invoice splits are share-annotations + payment requires the header customer (§3.3, `20260622020000:210`, `20260513110000:126`) · both inventory hard-blocks (§3.6/3.8, `20260702132000:107`, `20260620220000:132`) · application-record date source (§3.10) · wrong tier price in Quick Delivery picker (§3.6, `QuickDeliveryModal.tsx:556`).
- **Verified in the running production app:** nav structure & group contents · Office Cockpit tiles · Deliveries list one-click complete (in-progress rows only) · Delivery Remainders page live and filtered · Quotes filter missing the new status · junk customer records in live dropdowns · To-Ship per-line schedule actions · Payments record-a-check flow.
- **Proposal critique note:** the two independent critique agents were also lost to the API limits. Compensating checks: the nav blueprint contains its own complete 82-route old→new mapping (spot-checked against `App.tsx` routes and the live sidebar), and the entry-point consolidation removes only *buttons*, never routes or RPCs — no functionality can be lost by construction. Both proposals should still get the normal review gate when implemented (Wave 2/3).
- **Excluded as already known:** `complete_job` unit-conversion bug (P1 — scheduled into Wave 1 here; its units-module prerequisite shipped 2026-07-04) · rate-unit free text (WaveB Phase 1 — shipped 2026-07-04) · label data 0/604 (owner task) · scheduling calendar/day-board UI (known) · P2-8 / A5 / A9 (shipped 2026-07-04/05 by the parallel Structure-Wave-2 session).
- **Main moved during the review:** 4 migrations (`20260704120000`–`20260705000000`) + the WaveB frontend landed on `main` while this review ran, from a branch cut earlier. Checked: they touch blend tickets, vendor master, month-end seeding, and rate-unit inputs — no overlap with any finding in this report.
- **Residual:** 39 low/medium findings remain UNVERIFIED in `findings.json` (none anchor a report section). Standard practice applies: the implementing session re-reads the cited code before changing anything.
