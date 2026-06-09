# Phase 5 — Customer 360 and Navigation Audit

**Date:** 2026-05-04
**Auditor:** Claude (Opus 4.7, 1M context)
**Scope:** Read-only deep-dive on `CustomerDetail`, `Customers`, `Fields`, `FieldSetup`, `FieldDashboard`, sidebar/topbar/command-palette/page-titles, `Dashboard` quick actions and `ActionQueue`. Extends — does not duplicate — the prior 2026-05-04 UI/nav audit.
**Input doc:** `docs/audits/2026-05-04-ui-navigation-workflow-audit.md` (general nav findings — kept; this doc goes deeper on the customer story and on what that prior audit missed).

---

## Plain-English Summary

Today the Customer screen is **a tabbed filing cabinet, not a 360**. The top of the page tells you the farm name and five small KPI cards (`AR Balance`, `Orders this season`, `Deliveries this season`, `Tier`, `Last Activity`). Everything that actually drives a sales/admin conversation — open quotes, scheduled deliveries, unposted invoices, posted-with-balance, prepay balance, fields needing attention, recent notes/tasks — lives one or two tabs deep. To answer a phone call ("where are we with Page Farms?") a user must visit at least 3 tabs (`quotes`, `orders`, `deliveries`, `financials`) and mentally stitch the answer together. The data is all there — `get_customer_summary`, `get_ar_aging`, `get_customer_statement`, `prepay_credits`, `delivery_remainders`, `activity_feed` — it is just rationed across tabs.

Navigation-wise, the prior UI/nav audit caught the big stuff (sidebar overload, hidden Ctrl+K, passive transaction thread, payment context loss, customer tab sprawl). This phase confirms those and adds five things it missed: (1) `FieldDetail.tsx` is **dead code** — not routed (App.tsx uses `FieldSetup`); (2) `FieldDashboard` is the real per-field 360 but is **two clicks deep** from the customer (must go `/fields/:id/dashboard`, never linked from CustomerDetail's fields tab); (3) the command palette `global_search` RPC only covers 5 entity types — quotes, jobs, blend tickets, fields, application records, payments are NOT searchable, and that is a *database* change not a frontend list change; (4) page title for `/customers/:id` falls back to "Customer Database" — it should show the farm name (and the same is true for every other `/foo/:id` route); (5) sidebar `/notifications` link is missing entirely (route exists at `App.tsx:162`, no nav entry), so users only reach notifications via the bell icon in TopBar.

The single biggest improvement in this phase is **a Customer 360 panel above the tabs**: balance, prepay, credit utilization, open work counts (with click-through), top 3 next-best actions, top 5 recent activity items. It can be built today from existing tables without schema changes; the only new SQL is one read-only `get_customer_overview` RPC that bundles 9 counts into a single round trip.

---

## Evidence Reviewed

| Source | What it told me |
|---|---|
| `CLAUDE.md` | Lifecycle rules, schema gotchas (no `orders.total_paid` — use `invoices.balance_cents`) |
| `docs/workflows/UI_PATTERNS.md` | Tab pattern, page-list, table conventions |
| `docs/audits/2026-05-04-phase-0-current-state-audit.md` | Customer 360 owned by Phase 5; passive `TransactionThread`; `FieldDetail.tsx` flagged |
| `docs/audits/2026-05-04-ui-navigation-workflow-audit.md` | Prior 8-tab finding, sidebar/operations name collision, hidden Ctrl+K |
| `src/pages/CustomerDetail.tsx` (1,400+ lines) | 8 tabs, financials embedded inside one tab |
| `src/pages/Customers.tsx:22` | List page — uses DataTable; no balance/last-activity columns |
| `src/pages/Fields.tsx:30` | Map+list view; no per-customer filter chip when arriving from a customer |
| `src/pages/FieldSetup.tsx:34` | The ROUTE behind `/fields/:id` — boundary editor, customer assignment, billing split editor |
| `src/pages/FieldDetail.tsx:33` | Dead code — never reachable via router |
| `src/pages/FieldDashboard.tsx:50` | The "real" per-field 360 (overview/applications/billing/details/crop_history) — only at `/fields/:id/dashboard` |
| `src/components/customers/CustomerSummaryBar.tsx:34` | The 5-card top strip; backed by `get_customer_summary` RPC |
| `src/components/layout/Sidebar.tsx:79` | Nav structure; standalone "Operations" link still labeled `Operations` (collision with Operations category) |
| `src/components/layout/TopBar.tsx:10` | Title + notifications only — no visible search trigger |
| `src/components/layout/AppLayout.tsx:24` | Ctrl+K binding |
| `src/components/ui/CommandPalette.tsx` | `global_search` RPC + `ALL_PAGES` array |
| `src/hooks/usePageMeta.ts:3` | Hard-coded base-path map; no `:id` resolver |
| `src/components/dashboard/ActionQueue.tsx:35` | 6 categories; not customer-filtered |
| `src/pages/Dashboard.tsx:535` | Quick Actions: New Order, New PO, Schedule Delivery, Inventory, Receiving |
| `src/components/ui/TransactionThread.tsx:117` | Passive labels (`No invoices`, `No deliveries`); no next-step button |
| `src/pages/TeamBoard.tsx:58` | Unified note/task hub; only loosely linked to customers via `linked_entity_id` |
| `src/pages/Notifications.tsx:14` | Full inbox; no sidebar link |
| `supabase/migrations/20260404040100_global_search_rpc.sql` | `global_search` covers `customer/order/invoice/delivery/product` only |
| `supabase/migrations/20260404040200_get_customer_summary_rpc.sql` | Backs `CustomerSummaryBar`; returns AR + counts + tier + last activity |

---

## Findings — Customer 360 (P5-1 through P5-9)

### P5-1 — Customer screen is 8 tabs without an at-a-glance overview
- **Business risk:** Sales rep takes a call, can't see balance + open work + next action without clicking. Slow phone calls. Higher chance of forgetting the prepay balance or the unposted invoice. The very thing a "Customer 360" exists to prevent.
- **Evidence:**
  - 8 tabs declared at `src/pages/CustomerDetail.tsx:78` and re-listed at `src/pages/CustomerDetail.tsx:467` (`info`, `timeline`, `fields`, `quotes`, `orders`, `deliveries`, `financials`, `history`).
  - Default tab is `'info'` (`src/pages/CustomerDetail.tsx:78`) — i.e. the form to *edit* the customer, not a dashboard.
  - The 5-card `CustomerSummaryBar` (rendered at `src/pages/CustomerDetail.tsx:534`) is helpful but shallow: AR balance, order count, delivery count, tier, last activity. It does not show prepay, credit utilization, scheduled deliveries this week, unposted invoices, or open quote total.
  - All financials sit *inside* the `financials` tab (`src/pages/CustomerDetail.tsx:1196`–`:1346`) — AR summary, aging buckets, transactions, prepay credits — none surfaced on landing.
- **Fix direction:** Default tab → a new `Overview` tab that renders a **Customer 360 panel** above the existing tab strip. Keep all 8 detail tabs as-is. The panel pulls from already-existing RPCs (see "Recommended Customer 360 Layout" below) and adds a "Next-best actions" row (3 buttons max).
- **Likely files:** `src/pages/CustomerDetail.tsx` (add overview tab + panel component), `src/components/customers/CustomerSummaryBar.tsx` (extend or replace), new `src/components/customers/Customer360Panel.tsx`.

### P5-2 — Prepay balance and credit utilization are buried inside the Financials tab
- **Business risk:** Prepay balance is one of the *most expensive* things to forget. If a customer has $40k of prepay sitting on `prepay_credits` and a sales rep quotes them again without applying it, the rep's commission, the customer's invoice, and the AR all go wrong. Today this number lives at `CustomerDetail.tsx:1219` — three clicks deep.
- **Evidence:**
  - Prepay credits queried at `src/pages/CustomerDetail.tsx:260` only when the financials tab is opened.
  - Credit utilization bar at `src/pages/CustomerDetail.tsx:1228` — same tab.
  - `CustomerSummaryBar` (top strip) does NOT include prepay or credit-util (`src/components/customers/CustomerSummaryBar.tsx:76`–`:107`).
- **Fix direction:** Add `Prepay Balance` and `Credit Utilization %` to the always-visible top strip. If util > 80% color it amber; > 100% red. Combine with `get_ar_aging` results into a single overview RPC.
- **Likely files:** `src/components/customers/CustomerSummaryBar.tsx`, `supabase/migrations/<new>` — add `get_customer_overview` RPC that returns aging buckets + prepay + credit limit + scheduled deliveries this week + unposted invoices + open quote $ + active order $ in one round trip.

### P5-3 — Open work counts (quotes/orders/deliveries/invoices) require visiting each tab
- **Business risk:** A user has to click 4 tabs to know "this customer has 2 open quotes, 1 active order, 1 scheduled delivery, 1 unposted invoice". That is the literal definition of tab-hopping the prior audit flagged.
- **Evidence:**
  - Quotes loaded only when the quotes tab is selected: `src/pages/CustomerDetail.tsx:183`.
  - Orders only when orders tab is selected: `src/pages/CustomerDetail.tsx:190`.
  - Deliveries + remainders only when deliveries tab is selected: `src/pages/CustomerDetail.tsx:226`.
  - No invoice list per customer at all in CustomerDetail (the `financials` tab shows transactions, not invoices). Invoices are reachable only by going to `/invoices` and filtering — there is no `tab === 'invoices'` branch.
- **Fix direction:** The Customer 360 panel surfaces 4 small status pills:
  - `2 open quotes — $34,500`
  - `1 active order — 60% fulfilled`
  - `1 scheduled delivery — Wed 5/7`
  - `1 unposted invoice — $12,400`

  Each pill is a click → jumps directly to the corresponding tab pre-filtered.
- **Likely files:** `src/pages/CustomerDetail.tsx`, or a new RPC `get_customer_overview` that returns these counts in one call.

### P5-4 — Invoices are not a tab on CustomerDetail at all
- **Business risk:** This is the most surprising gap. There is a `quotes` tab, an `orders` tab, a `deliveries` tab, but no `invoices` tab. A user looking at a customer cannot directly see "all invoices for this customer" — only "transactions in the last 90 days" inside the `financials` tab.
- **Evidence:**
  - Tab list at `src/pages/CustomerDetail.tsx:467`: `['info','timeline','fields','quotes','orders','deliveries','financials','history']` — note the absence of `invoices`.
  - The `financials` tab loads `get_customer_statement` for the last 90 days (`src/pages/CustomerDetail.tsx:259`) — that's a **transaction list**, not an **invoice list**. Users cannot see voided invoices, draft invoices, or invoices older than 90 days from the customer view.
- **Fix direction:** Add an `Invoices` tab between `deliveries` and `financials`. Query `invoices.*` filtered by `customer_id`, show status badge + posted date + balance + age. The 360 panel should also show "Posted invoices with balance: 3 — $18,400" at the top.
- **Likely files:** `src/pages/CustomerDetail.tsx`.

### P5-5 — Notes and tasks are siloed on Team Board, not unified into the customer story
- **Business risk:** Notes/tasks linked to a customer (gate codes, "call back about pricing", "needs sprayer the 14th") live in `team_notes` keyed by `linked_entity_id`. Today CustomerDetail renders `<RelatedNotes>` only at the *bottom of the info tab* (`src/pages/CustomerDetail.tsx:765`). The user has to scroll past the customer form to see them, and they are hidden on every other tab.
- **Evidence:**
  - `RelatedNotes` rendered at `src/pages/CustomerDetail.tsx:765` — inside the `info` tab, after Notes textarea, after the Save button.
  - On all other tabs (`fields`, `quotes`, `orders`, `deliveries`, `financials`, `history`), `RelatedNotes` is **not rendered** — switching tabs hides them.
  - The `timeline` tab (`src/pages/CustomerDetail.tsx:774`) shows `activity_feed` but NOT team notes/tasks. So one tab shows "system did this" and another tab shows "humans wrote this", and they are never combined.
- **Fix direction:**
  1. Move `RelatedNotes` above the tab strip, between the action buttons and the new 360 panel — so it shows on every tab.
  2. Optional: unify timeline + notes + comments into a single combined feed (sort by `created_at`, mix `activity_feed` rows with `team_notes` rows). One scrollable river.
- **Likely files:** `src/pages/CustomerDetail.tsx`, `src/components/team/RelatedNotes.tsx`.

### P5-6 — Field-level history is not visible from the Customer screen
- **Business risk:** Field-level history (per-field acreage, applications applied this season, crop type, last application date) is the single richest data the app holds for a sales conversation. Yet from the customer's `fields` tab, users only see a static table (name, acres, crop, county, legal description, status). To see what's actually happened on a field, they have to click into `/fields/:id` (which routes to `FieldSetup` — the *editor*), THEN navigate manually to `/fields/:id/dashboard` — which is where the real history lives.
- **Evidence:**
  - Fields table at `src/pages/CustomerDetail.tsx:846`–`:888`: just static field metadata.
  - Row click navigates to `/fields/:id` (`src/pages/CustomerDetail.tsx:861`) → `FieldSetup` editor (`src/App.tsx:171`), NOT to the dashboard.
  - `FieldDashboard` (the real per-field 360) is at `/fields/:id/dashboard` (`src/App.tsx:172`) but no link from CustomerDetail points to it.
  - `FieldDashboard` HAS the rich data: applications, billing splits, crop history (`src/pages/FieldDashboard.tsx:35`).
- **Fix direction:**
  1. On the customer's fields tab, change the row click target to `/fields/:id/dashboard` (the dashboard) and provide an "Edit field" button on the dashboard for the editor case.
  2. Or add a "Dashboard" button column next to each field row.
  3. On the 360 panel, show "Fields with applications this season: 4" — click → filtered field list.
- **Likely files:** `src/pages/CustomerDetail.tsx`, `src/pages/FieldDashboard.tsx` (add prominent Edit button).

### P5-7 — `FieldDetail.tsx` is dead code
- **Business risk:** Low (no user impact). But it confuses any future agent reading the codebase, and it bloats the build/test surface.
- **Evidence:**
  - `src/pages/FieldDetail.tsx:33` — full editor component, 600+ lines, completely unused.
  - `src/App.tsx:43` imports `FieldSetup`, NOT `FieldDetail`.
  - `src/App.tsx:171` routes `/fields/:id` to `FieldSetup`.
  - No `import.*FieldDetail` anywhere in `src/`.
- **Fix direction:** Delete `src/pages/FieldDetail.tsx`. Update `pages-routes.md` and `UI_PATTERNS.md:69` which still lists FieldDetail as a real page.
- **Likely files:** `src/pages/FieldDetail.tsx` (delete), `docs/workflows/UI_PATTERNS.md:69`, `docs/reference/pages-routes.md`.

### P5-8 — Customer page title shows "Customer Database" instead of the farm name
- **Business risk:** When the user has multiple customer tabs open in the browser, every tab is labeled "Customer Database" — they can't tell them apart. Same problem on every detail page.
- **Evidence:**
  - `src/hooks/usePageMeta.ts:46` slices the path to the first segment, so `/customers/:id` returns the same meta as `/customers`.
  - `src/hooks/usePageMeta.ts:5`: `'/customers': { title: 'Customer', accent: 'Database' }` — that's the only entry for the customer family.
  - Same problem on `/fields/:id`, `/orders/:id`, `/quotes/:id`, `/invoices/:id`, `/deliveries/:id`, etc.
- **Fix direction:** Add a `usePageTitle(title, accent?)` setter hook that writes to context + `document.title`. Have `CustomerDetail` and other detail pages call it on load with the entity's number/name. The prior audit's finding #3 was about *missing* page-meta entries — this is a deeper issue: even *present* entries are wrong for detail pages.
- **Likely files:** `src/hooks/usePageMeta.ts`, all detail pages.

### P5-9 — `Customers.tsx` list does not show open-work hints
- **Business risk:** When opening `/customers`, the user sees farm name, contact, phone, tier, total acres, status. Nothing tells them which customers have overdue invoices, scheduled deliveries today, or expiring quotes — they have to click into each one to find out.
- **Evidence:**
  - Columns at `src/pages/Customers.tsx:73`–`:97`: name, contact, phone, tier, acres, status. No balance, no last-activity, no "needs attention" flag.
  - `get_customer_summary` RPC (used by `CustomerSummaryBar` at `src/components/customers/CustomerSummaryBar.tsx:44`) already returns `ar_balance_cents` and `last_activity` — could be batched.
- **Fix direction:** Add columns: `AR Balance`, `Last Activity (days ago)`, `Has overdue?` badge. Sortable. Filter chips: "Has open quote", "Has scheduled delivery", "Overdue". Reuse the existing summary RPC (extend to a bulk version, e.g. `get_customer_summary_bulk(customer_ids[])`).
- **Likely files:** `src/pages/Customers.tsx`, `supabase/migrations/<new>` (bulk overview RPC).

---

## Findings — Navigation (P5-10 through P5-15)

These extend or deepen the prior UI/nav audit. I do NOT repeat its findings; I add what it missed.

### P5-10 — `global_search` RPC is the real bottleneck, not the page list
- **Business risk:** Prior audit said "command palette only searches 5 entities." The deeper truth is it's not a code list to expand — it's a **SQL UNION inside an RPC** at `supabase/migrations/20260404040100_global_search_rpc.sql:1`. To add quotes/jobs/blend-tickets/fields/payments/application-records/POs to search, you have to extend the RPC, redeploy, and then teach the frontend new entity types. The prior audit suggested "expand command palette coverage" without flagging that this is a database change requiring a migration.
- **Evidence:**
  - `supabase/migrations/20260404040100_global_search_rpc.sql` UNIONs `customers`, `orders`, `invoices`, `deliveries`, `products` only.
  - `src/types/index.ts` declares `SearchEntityType` as `'customer' | 'order' | 'invoice' | 'delivery' | 'product'`.
  - `src/components/ui/CommandPalette.tsx:62`–`:84` hard-codes icon/path maps for those 5 types only.
- **Fix direction:** Migration that extends `global_search` to UNION quotes (`quote_number`), jobs (`job_number`), blend tickets (`ticket_number`), purchase orders (`po_number`), application records (`record_number`), payments (by `reference`/`check_number`), fields (`field_name`), customer phone digits, and customer addresses. Keep `p_limit` per category to avoid a wide search dominating. Update `SearchEntityType` and the icon/path maps in `CommandPalette.tsx`. Add an E2E test that searches each new type.
- **Likely files:** `supabase/migrations/<new>_global_search_extend.sql`, `src/components/ui/CommandPalette.tsx`, `src/types/index.ts`.

### P5-11 — Sidebar is missing the Notifications entry point
- **Business risk:** The bell icon in TopBar (`src/components/layout/TopBar.tsx:29`) is the only way to reach `/notifications`. There is no sidebar link. Power users who collapse the bell or who navigate by keyboard never see notifications listed.
- **Evidence:**
  - `Notifications` route exists at `src/App.tsx:162`.
  - `src/components/layout/Sidebar.tsx:79`–`:204` — no entry for `/notifications`. Standalones are dashboard, getting-started, team-board, settings.
  - `usePageMeta.ts:35` HAS a meta entry for `/notifications` ("Notifications") — so the team built the page intending it to be a real navigable destination.
- **Fix direction:** Add a sidebar standalone link for Notifications (Bell icon) between Team Board and Settings. Show unread badge.
- **Likely files:** `src/components/layout/Sidebar.tsx`.

### P5-12 — TopBar has no visible search trigger and no "Recently viewed" pin
- **Business risk:** Mason's daily workflow is "open the same 5 customers a day". Today every visit goes through `/customers` (a 500-row table), or Ctrl+K (hidden). There is no "pinned customer" or "recently viewed" surface in the chrome.
- **Evidence:**
  - `src/components/layout/TopBar.tsx:11`–`:33` — only menu button, title, notifications panel.
  - `src/lib/recentPages.ts` records visits (used by `CommandPalette.tsx:271`) but is never surfaced in TopBar.
- **Fix direction:** Add to TopBar (in priority order):
  1. A visible `Search ⌘K` button (also closes the discoverability gap from prior audit finding #2).
  2. A "Recent" dropdown showing the last 5 detail pages visited (customer/order/invoice). Click → navigate. Reuses `recentPages.ts`.
  3. (Stretch) A "Pin" button on each detail page that adds it to a persistent pinned list.
- **Likely files:** `src/components/layout/TopBar.tsx`, `src/lib/recentPages.ts` (extend with pins).

### P5-13 — Sidebar is page-list shaped, not workspace shaped — and Field Application work straddles three groups
- **Business risk:** A sales rep's workflow for a customer = open customer → see fields → start a field application invoice → schedule a job → print blend ticket. Today those live in three sidebar groups (Customers, Sales/Invoices, Operations). The prior audit flagged sidebar overload generally; the *specific* split that hurts most is **Field Application** straddling 3 groups.
- **Evidence:**
  - `src/components/layout/Sidebar.tsx:118`: Customers group has `Customers`, `Fields`, `Crop Programs`.
  - `src/components/layout/Sidebar.tsx:149`: Operations group has `Job Schedule`, `Dispatch Board`, `Deliveries`, `Remainders`, `Vehicles`, `App Services`, `Blend Tickets`, `App Records`, `Program Tracker` — 9 items, including 4 that are field-app-specific (`Blend Tickets`, `App Records`, `Dispatch Board`, `Job Schedule`).
  - There is no single "Field Application" sidebar entry — only the indirect path via `/invoices` (`Sales > Invoices`) → "New Field Application" button (`src/pages/Invoices.tsx:583`).
- **Fix direction:** Two options:
  1. **Conservative** — add a new top-level sidebar standalone "Field Application" linking to `/invoices/field-app/new`, keeping current groups. Lowest risk.
  2. **Workspace** — introduce a new sidebar category "Application" containing `Field App Invoice`, `Job Schedule`, `Dispatch Board`, `Blend Tickets`, `App Records`. Move those out of Operations. Operations becomes deliveries/vehicles only.

  Pick option 1 for Phase 5; consider option 2 in Phase 8 (mobile/perf) where the sidebar gets a thorough rework.
- **Likely files:** `src/components/layout/Sidebar.tsx`.

### P5-14 — Dashboard quick actions miss the customer-facing daily flows
- **Business risk:** A sales rep's "start work" buttons are New Order, New PO, Schedule Delivery, Inventory, Receiving (`src/pages/Dashboard.tsx:539`–`:583`). New Quote, Field Application, Record Payment, Quick Receive, and Dispatch are missing. The Quick Action grid is the closest thing to a homepage and it currently favors warehousing operations over sales.
- **Evidence:**
  - Quick action buttons enumerated at `src/pages/Dashboard.tsx:535`–`:586`.
  - No "New Quote" button despite `/quotes/new` existing at `src/App.tsx:174`.
  - No "Field Application" button despite `/invoices/field-app/new` existing at `src/App.tsx:181`.
  - `ActionQueue` (`src/components/dashboard/ActionQueue.tsx:35`) is good but reactive — it shows what's already broken. Quick Actions should be proactive (start new work).
- **Fix direction:** Add quick actions: `New Quote`, `Field Application`, `Record Payment`, `Quick Receive`. Make role-aware (admin sees all; sales_rep sees New Quote/New Order/Field Application/Record Payment; driver/applicator see different sets).
- **Likely files:** `src/pages/Dashboard.tsx`.

### P5-15 — Page-meta map is not just incomplete (prior audit), it's wrong for ALL detail pages
- **Business risk:** Already covered as P5-8 for customers. Generalizes here: every detail-page route falls back to its base path, so `/orders/abc-123` shows "Order Management" instead of "Order #SO-2026-0042 — Page Farms". Browser-tab disambiguation fails for all detail pages.
- **Evidence:**
  - `src/hooks/usePageMeta.ts:46` — single base-path lookup.
  - No mechanism for child pages to override.
- **Fix direction:** Add a `usePageTitle(title, accent?)` setter hook that writes to context + `document.title`. Have `CustomerDetail`, `OrderDetail`, `InvoiceDetail`, `DeliveryDetail`, `QuoteBuilder`, `JobDetail`, `BlendTicketDetail`, `FieldSetup`, `FieldDashboard`, `PurchaseOrderDetail`, `VehicleDetail`, `VendorBillDetail`, `ApplicationServiceDetail`, `ProductDetail` call it on load with the entity's number/name.
- **Likely files:** `src/hooks/usePageMeta.ts`, all the detail pages above.

---

## Recommended Customer 360 Layout (concrete)

When the user opens `/customers/:id` and the customer is non-new, render this **above the existing tab strip**:

```
+-----------------------------------------------------------------------------+
|  [Page Farms]   Tier 1   Active   Acct PG-0142   Last activity: 2h ago     |  <- header (existing)
|                                       [Create Task] [New Quote] [New Order]|  <- existing action row
+-----------------------------------------------------------------------------+
|                                                                             |
|   AR Balance     Prepay Bal     Credit Util    Open Quotes    Active Orders|
|   $18,432.10     $12,000.00     62%            2 ($34,500)    1 (60% ful.) |  <- 5 cards (NEW)
|   [3 overdue]    [auto-apply]   [bar amber]    [-> tab]       [-> tab]     |
|                                                                             |
|   Sched. Del.    Unposted Inv.  Posted+Bal.    Open Remndrs.   Fields      |
|   1 (Wed 5/7)    1 ($12,400)    3 ($18,400)    2 (12 gal)      14 active   |  <- 5 cards (NEW)
|   [-> tab]       [-> tab]       [-> tab]       [-> tab]        [-> tab]    |
|                                                                             |
+-----------------------------------------------------------------------------+
|  Next Best Action                                                           |
|   ->  Apply $12,000 prepay to Invoice INV-2026-0419   [Apply]  [Skip]       |
|   ->  Schedule delivery for Order SO-2026-0181 — 60% remaining  [Schedule] |
|   ->  Send overdue statement (3 invoices, 31-60 days)  [Send]               |
+-----------------------------------------------------------------------------+
|  Recent Activity (last 5, mixed system + team notes)                        |
|   * [activity] Invoice INV-2026-0419 posted by Mason — 2h ago               |
|   * [note]     "Call about prepay reapply" — Sarah, 5h ago                  |
|   * [activity] Delivery DEL-2026-0301 completed — yesterday                 |
+-----------------------------------------------------------------------------+
|  [Overview] [Info] [Timeline] [Fields] [Quotes] [Orders] [Deliveries]       |  <- TAB STRIP (now 10: Overview + Invoices added)
|  [Invoices] [Financials] [History]                                          |
+-----------------------------------------------------------------------------+
```

Default tab when opening a non-new customer = `Overview`. Default for new customer = `Info` (form). This **does not break existing flows** — every tab remains. The form moves one click deeper, which is correct: editing a customer is the rare path; reading is the common path.

### Backing data — already exists, no schema change needed

| Card | Source |
|---|---|
| AR Balance, Aging | `get_ar_aging` (called at `src/pages/CustomerDetail.tsx:258`) |
| Prepay Balance | `prepay_credits` table query (`src/pages/CustomerDetail.tsx:260`) |
| Credit Limit, Utilization | `customers.credit_limit_cents` + AR balance |
| Open Quotes | `quotes` filter `customer_id` + status in (`draft`,`sent`,`revised`) |
| Active Orders | `orders` filter `customer_id` + status in (`confirmed`,`partially_fulfilled`) |
| Scheduled Deliveries | `deliveries` filter `customer_id` + status in (`scheduled`,`in_progress`) |
| Unposted Invoices | `invoices` filter `customer_id` + status in (`draft`,`unposted`) |
| Posted+Balance | `invoices` filter `customer_id` + status=`posted` + `balance_cents` > 0 |
| Open Remainders | `delivery_remainders` filter `customer_id` + status=`pending` |
| Active Fields | `fields` count where `customer_id` and `is_active` |
| Next-best action | derived rules in frontend; no RPC needed initially |
| Recent activity | `activity_feed` + `team_notes` UNION ordered by `created_at` |

**Recommendation:** wrap the 9 counts above into a single new RPC `get_customer_overview(p_customer_id uuid)` so the 360 panel does ONE round trip on load. That keeps the page snappy.

---

## What's Already Working

Carry these forward — do not touch.

- `CustomerSummaryBar` is the right *idea*, just shallow — keep the visual style, extend the data.
- `RelatedNotes` already accepts `entityType` + `entityId` — reusable on every tab.
- `get_customer_summary` and `get_customer_year_end_summary` RPCs are clean SECURITY DEFINER + idempotent.
- `assertRpcResult` discipline is enforced everywhere (`CustomerDetail.tsx:178`, `:259`, `:432`, `:478`).
- Tab structure with breadcrumbs and unsaved-changes guard (`useUnsavedChanges` at `:115`) is mature.
- The `financials` tab has a beautiful aging-bucket bar (`:1247`–`:1278`) — preserve this, lift the summary up, leave the detail behind.
- `ActionQueue` is well-designed (6 categories, dismiss-for-today, create-task) — just needs a per-customer scoped variant.
- `TransactionThread` link strip (already flagged passive in the prior audit) — keep, just upgrade to active.
- `recentPages.ts` already records every detail page visit — usable for TopBar "Recent" dropdown immediately.

---

## Open Questions for Mason

These are decisions only you can make. Phase 5 implementation should not start until at least the first three are answered.

1. **What is THE most important number on a Customer 360?** My guess is **AR balance** (or "Posted invoices with balance"). But it could be **prepay remaining** (most often forgotten), **next scheduled delivery date** (operational), or **open quote total** (sales pipeline). Whatever you pick goes biggest, top-left.

2. **Should the customer overview show *this season* or *all-time*?** Today `CustomerSummaryBar` is season-bound. AR is all-time. Prepay can be both. If a card mixes scopes the user has to read the labels carefully — do we standardize on "this season" with an "all-time" toggle?

3. **Notes vs activity — one feed or two?** Engineer's instinct says merge them (one timeline). Sales-rep instinct often says separate ("notes are mine, activity is the system's"). What feels right to you?

4. **Should opening a customer remember the last tab visited (per-user)?** If a sales rep always opens `Quotes` first, should we restore that? Or always start on the new `Overview`?

5. **Field row click — to dashboard or to editor?** P5-6 fix direction is "click goes to dashboard". Do you ever edit a field's name/boundary outside of FieldSetup directly? If yes, the dashboard needs a prominent Edit button.

6. **Pinned customers in TopBar — nice or noise?** Power users love it; first-time users find it confusing. Defer to Phase 8?

---

## Recommended Fix Order Within Phase 5

Prioritized for **highest customer-day-saved-per-line-of-code-changed** first.

1. **P5-7** — Delete `FieldDetail.tsx`. (5 minutes, removes confusion permanently.)
2. **P5-8 / P5-15** — Add `usePageTitle` setter; wire it from `CustomerDetail` (and the 5 most-used detail pages). Browser tabs become useful. (1 hour.)
3. **P5-1 + P5-2 + P5-3 + P5-4** — Build `Customer360Panel` + `Overview` tab + add `Invoices` tab. New RPC `get_customer_overview`. This is the headline. (1 day.)
4. **P5-5** — Move `RelatedNotes` above the tab strip. (1 hour.)
5. **P5-6** — Fix the customer→field-dashboard navigation. (1 hour.)
6. **P5-9** — Extend `Customers.tsx` list with balance + last-activity columns + filter chips. (Half day.)
7. **P5-11** — Add Notifications sidebar link. (15 min.)
8. **P5-12** — TopBar visible search button + Recent dropdown. (2 hours; closes prior audit finding #2.)
9. **P5-14** — Add Quick Actions for New Quote / Field Application / Record Payment. (1 hour.)
10. **P5-10** — Extend `global_search` RPC + add new entity types in CommandPalette. (Half day.)
11. **P5-13** — Add Field Application sidebar entry (conservative variant). (15 min.)

Items 1, 2, 4, 5, 7, 9, 11 are all small enough to land in a single PR. Items 3 and 10 are the substantive changes.

---

## What This Phase Did NOT Do

- Did not touch any code, run lints, or run tests.
- Did not enumerate every customer-facing RPC — see `docs/reference/rpc-functions.md`.
- Did not assess accessibility/keyboard support of the tab strip — out of scope (Phase 8).
- Did not redesign the field-app workflow — Phase 2 owns that. P5-13 is a navigation hook only.
- Did not propose new database tables — only one new read-only RPC (`get_customer_overview`) which is just a UNION of existing reads.

---

*End of Phase 5. The single most disruptive question to answer first is Open Question #1 above — once Mason picks "the headline number", the 360 panel design follows in a few hours.*
