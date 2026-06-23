# CRX Manager — UI / Workflow Overhaul Build Loop

Date started: 2026-06-23
Branch: `feat/ui-overhaul` (NEVER `main`)
Owner: Mason (zero coding experience — review is by looking at screenshots, not diffs)

This is the authoritative spec for a self-paced overnight build loop that restructures
CRX Manager to be far less "clicky" and gives it a full visual refresh. It was derived
from a 6-way grounded research pass of the live codebase (2026-06-23) plus the
already-approved-but-never-built `docs/archive/2026-spring/2026-05-04-ui-improvement-plan.md`.

---

## North Star (what "fixed" means)

Mason's words: *"it is very spread out… so many pages and different places to go… very clicky…
I feel we can put a lot more of these pages and features on the same page to keep from bouncing
around… being able to search by product name instead of clicking on all the individual orders."*

So the goal is, in priority order:
1. **Search-driven** — find anything (a product, customer, order) from a visible search box, and
   land on a screen that answers the question instead of a list to drill through.
2. **Consolidated** — more on one screen; combine related list + detail + actions; stop forcing
   page-hops; remember context as the user moves through a deal.
3. **A full visual refresh** — Mason explicitly asked to "refresh the whole look," done consistently
   and on-brand (see Visual Language below).

App context: internal staff tool, ~2 main users + occasional drivers/applicators. Heavy mobile use
for field/driver/applicator roles. Brand color `crx-green` #28A26A. React 18 + TS + Vite + Tailwind.

---

## ⛔ HARD SAFETY ENVELOPE (this loop runs unattended — these are non-negotiable)

Mason chose **"hold everything for review"** and a full visual refresh. Therefore:

1. **Branch only.** All work on `feat/ui-overhaul`. **NEVER** push `main`, **NEVER** merge to `main`,
   **NEVER** deploy to Vercel, **NEVER** call `deploy_to_vercel`. Pushing the *feature branch* to
   origin is allowed (a non-`main` branch push does NOT deploy) so Mason gets a PR to look at.
2. **ZERO database changes.** No migrations, no `apply_migration`, no new/changed RPCs, no edge
   functions, no `execute_sql` writes. The To-Ship screen and everything else use **frontend queries
   against EXISTING columns/RPCs only**. If a task seems to need a DB change → STOP that task, write a
   plain-English note in `STATE.md` under "Needs Mason," move on. Do not write SQL.
3. **Read-only on the live DB.** Only `SELECT`/introspection to understand data. Never mutate live data.
4. **Frontend + docs only.** Touch `src/`, `tailwind.config.*`, and `docs/build-loops/ui-overhaul/`.
   Respect every CLAUDE.md architecture rule: lazy-load pages, Tailwind only (crx-green), Lucide icons
   only, shared types in `src/types/index.ts`, single Supabase client `src/lib/db.ts`,
   `checkMutationResult()` / `assertRpcResult()` where mutations exist (we are not adding any).
5. **Never delete a page/route without proving it's unused.** Grep for the route in `App.tsx`, the nav
   link in `Sidebar.tsx`/`routesConfig`, and all imports. NOTE: `NewOrder`, `NewDelivery`,
   `NewPurchaseOrder`, `NewVendorBill`, `ApplicationServiceDetail` ARE routed — do **not** treat them as
   dead. Any removal goes in its **own clearly-labeled commit** so Mason can reject just that one.
6. **Done = ran and proven.** Before every commit: start the dev preview, open the affected page(s),
   take a **screenshot**, check the console for errors, and run `npm run lint && npm run typecheck &&
   npm run build && npm run test`. A change is only "done" when it renders correctly in the browser.
   Aesthetic sign-off is Mason's (morning) — the loop proves it *works*, Mason judges if it *looks right*.
7. **Solo check each tick.** Before starting work, confirm no parallel session is mid-write (git status
   clean-ish, no other process editing the same files). Re-read `STATE.md` fresh each tick. (Parallel-
   session collisions have bitten this repo before.)
8. **Small commits.** One task ≈ one commit, clear message. Update `STATE.md` in the same commit.

### Write-actions addendum (2026-06-23 scope change — Mason chose "actions are the point" + "ops command center")
The flagship now includes buttons that **create real records** (a delivery via `create_delivery_with_items`,
a PO via the existing New-PO flow, a driver assignment via `reassign_delivery`, a pick-list PDF). These
reuse EXISTING RPCs/flows — **still zero migrations** — but they MUTATE the live database. Therefore:
- **Read-only tasks** (the board, reporting, search, filters) follow the normal loop: build → screenshot →
  green checks → commit. These can run autonomously.
- **Write-action tasks are review-gated and human-tested — NOT done blind.** The loop may write the *code*
  and run lint/typecheck/build/test + the review subagents (`rls-security-reviewer`, `compliance-reviewer`),
  but it must **NOT auto-click the action in the live preview** (that would create a real delivery/PO in prod).
  Prove these either against clearly-prefixed `[E2E]` test data per the E2E protocol, or leave them for
  Mason to exercise during review. Every write path must carry idempotency (`useIdempotencyKey`) +
  `assertRpcResult`/`checkMutationResult` + actor binding per CLAUDE.md. When a write-action task is the
  next item, mark it `[!]` for a reviewed build rather than silently shipping an untested mutation.

---

## Visual Language (the refresh direction)

Refresh the look **through the shared component library + Tailwind theme**, NOT by hand-editing 80
pages. Most pages already render through `Card`, `DataTable`, `Modal`, `Button`, `Badge`, `Breadcrumbs`,
`CommandPalette`, etc. Restyle those + the `Sidebar`/`TopBar` shell and the new look propagates
everywhere consistently and reversibly.

Target aesthetic (reference: the mockup shown to Mason on 2026-06-23):
- **Brand:** `crx-green` #28A26A as primary; keep the logo. A calm neutral-gray surface palette.
- **Surfaces:** `rounded-xl` cards, hairline borders, soft shadow, generous internal padding; a clear
  page-header band (title + subtitle + primary action) on every page.
- **Typography:** one clear hierarchy — page title / section heading / body / caption. Tabular numerals
  for money and quantities.
- **Tables:** denser rows, sticky headers, zebra/hover states, right-aligned numeric columns, status
  shown as a color-coded `Badge` keyed to the lifecycle (draft/sent/confirmed/posted/paid/overdue/…).
- **Density done right:** summary "stat strips" (3–6 KPI chips) at the top of list & detail pages so the
  answer is visible without opening anything; inline expanders instead of new pages where reasonable.
- **Empty states:** icon + one-line explanation + a primary action (create an `EmptyState` component if
  one doesn't exist).
- **Buttons:** one green **primary** (the next step), outlined **secondary**, ghost **tertiary**, and a
  `More ▾` overflow for rare/destructive actions.
- **Shell:** refined sidebar with section dividers + clear active state; a top bar with a **visible
  search box** (⌘K) and a "Recent" affordance.
- **Mobile/touch:** ≥44px tap targets, card fallbacks for tables on phones, drawer nav on tablet.
- **A11y:** visible focus rings, sufficient contrast.

---

## Phases (priority order — each is independently reviewable)

> Build Phase 0 first (it makes the refresh consistent), then the flagship Phase 1 (Mason's vivid pain),
> then 2→5. File targets below are from the 2026-06-23 research; verify each against live code before editing.

### Phase 0 — Design-system foundation
Restyle the shared library so the refresh lands everywhere at once.
- `tailwind.config.*` — formalize tokens (spacing, radius, shadow, neutral ramp, status colors).
- `src/components/ui/`: `Card`, `Button`, `Badge`, `DataTable`/`EditableDataTable`, `Modal`,
  `Breadcrumbs`, `Combobox`, and a new `EmptyState`, `PageHeader`, `StatStrip` if missing.
- `src/components/layout/`: `Sidebar`, `TopBar`, `AppLayout` shell polish.
- Proof: before/after screenshots of Dashboard, one list page (Orders), one detail page (OrderDetail).

### Phase 1 — 🚩 Flagship: Operations Command Center (route `/ops` or `/command-center`)
Mason's expanded ask (2026-06-23): better **reporting** + **finding** + **acting in place**, grown into a
unified **operations hub**. Built in two layers so the safe read-only half can ship first and the
write-actions get review.

**Build A — read-only board (autonomous loop, frontend-query only, zero DB):**
- New page (admin+sales_rep), unified streams as filterable sections/cards:
  1. **To-Ship** (the core): demand from `order_items.quantity_remaining > 0` on confirmed/partially_fulfilled
     orders, grouped By Product / By Customer / By Delivery date. Per product: owed vs **free stock** vs
     **inbound-on-PO + arrival date**; **Ready-to-ship vs Blocked** split; **$ to ship**; **aging** of oldest
     waiting lines.
  2. **Today/▷ deliveries** — `deliveries` scheduled today/this week + status.
  3. **Inbound POs** — open `purchase_order_items` (ordered − received) grouped by expected arrival.
  4. **Delivery remainders** — `delivery_remainders` by age + tier.
  5. **Low stock / inventory pressure** — `% of stock already owed` per product (prebooked vs available),
     and reorder triggers (free < open demand AND no covering PO).
  6. **Expiring holds** — active `inventory_holds` with expiry countdown + linked quote status.
- **Findability:** visible product/customer search (lands on demand); filter chips (Short only · This week ·
  My customers · Ready now · Tier); group + sort; remember-last-view (localStorage). Also add the visible
  **Search…** button to `TopBar` + a dashboard card linking into the hub.
- Data: **frontend queries only** against existing columns/RPCs (`get_inventory_position`,
  `get_customer_delivery_remainders` as read sources — do not change them). No migration. If aggregation
  perf is poor, a read-only RPC is a SEPARATE gated item — flag it, don't write SQL in the loop.
- Proof: screenshots of each stream with real data; cross-check a known order's remaining qty vs OrderDetail.

**Build B — act-in-place (REVIEW-GATED, human-tested, still zero migration — see Write-actions addendum):**
- **Schedule delivery** from a customer's owed list → pre-fill `create_delivery_with_items` with remaining items.
- **Reorder / create PO** from a short product → existing New-PO flow, pre-filled qty (demand − free).
- **Print pick list** for the day → existing `orderPickListPdf` (extend to a batch/day variant if needed).
- **Assign driver / set priority / add note** → `reassign_delivery` + `team_notes`.
- **Bulk-select rows to act.** Each path: idempotency + `assertRpcResult`/`checkMutationResult` + actor bind.
- Built with the review subagents; tested with `[E2E]` data or by Mason — never auto-fired against live.

### Phase 2 — Navigation backbone (kills sidebar/search drift)
- **New `src/lib/routesConfig.ts`** — single source of truth `{ path, label, icon, roles, palette,
  sidebar: 'standalone'|categoryId|'hidden' }` for every route in `App.tsx`.
- Derive `Sidebar.tsx` `navigation[]` and `CommandPalette.tsx` `ALL_PAGES` from it.
- Fix the **"Operations" label collision** (`Sidebar.tsx:88` the `/` link vs the Operations category) —
  rename the home link to "Dashboard"/"Home".
- Split the **16-item Finance group** into labeled sub-sections (e.g. Accounting / Reporting / Close &
  Compliance) with dividers.
- Rewrite `usePageMeta.ts` to longest-prefix match against `routesConfig` (fixes nested-route titles).
- Add `routesConfig.test.ts` that fails if the config drifts from `App.tsx`.

### Phase 3 — Stop losing context (deep-linking everywhere)
- Clickable **customer name** + a small AR-status context card on `OrderDetail`, `InvoiceDetail`,
  `DeliveryDetail` headers (currently static text).
- Payment context: `OrderDetail`/`InvoiceDetail`/`CustomerDetail` "Record Payment" →
  `/payments?customer={id}&invoice={id}`; `PaymentAllocation.tsx` reads those params and preselects.
- `Invoices.tsx`: "+ Create Invoice ▾" dropdown deep-linking to filtered Orders / Blend Tickets / Field
  app; `Orders.tsx` & `BlendTickets.tsx` read the new filter params.
- `TransactionThread.tsx`: show lifecycle status micro-text under each step ("Accepted", "1 of 2
  complete", "Posted") — display only.
- Action-hierarchy pass on Quote/Order/Delivery/Invoice detail (one primary CTA + More ▾).

### Phase 4 — Consolidate the scattered workspaces
- **AR workspace:** merge `PaymentAllocation` + `PaymentHistory` + `ARaging` + `CustomerTransactionReview`
  into one tabbed page (Allocate / History / Aging / Ledger). Keep old routes as redirects. No logic change.
- `CustomerDetail.tsx`: add a glanceable **overview header strip** above the existing tabs (do NOT
  restructure the tabs).
- Dashboard: deep-link the `ActionQueue` cards (e.g. overdue invoices → `/invoices?status=posted&overdue=true`)
  and surface the currently-buried alerts (overdue **bills**, blend tickets awaiting approval, AR 60+).
- **Verify-then-remove** any genuinely unused page (prove unused first; own commit). Investigate
  `PrepayWorkspace` vs `PrepaymentManager` — keep both if both are reachable/used.

### Phase 5 — Mobile / tablet polish
- Move drawer breakpoint `lg`→`xl` so iPad landscape gets the mobile drawer.
- Mobile card fallback for `Deliveries.tsx` and `Jobs.tsx` (drivers/applicators on phones).
- `BlendTicketDetail.tsx` thumb-first pass; `SelectLocationsModal` Map/List/Selected segmented control.
- Implement the field-app print packet TODO (`FieldApplicationInvoice.tsx` / `invoicePdf.ts`).

---

## Per-iteration loop procedure (what each tick does)
1. **Read `STATE.md`**; pick the next unchecked task in priority order.
2. **Solo check** (no parallel writer; working tree sane).
3. **Implement** surgically — shared components first; match existing style; respect the safety envelope.
4. **Prove:** preview running → open affected page(s) → screenshot → console clean →
   `npm run lint && npm run typecheck && npm run build && npm run test` green.
5. **Commit** to `feat/ui-overhaul` (+ update `STATE.md` in the same commit). Optionally push the branch.
6. If **blocked / needs a DB change / aesthetic judgment / a destructive removal** → mark it in `STATE.md`
   under **Needs Mason**, skip it, continue. Never write SQL / merge / deploy.
7. **Self-pace** the next tick. When all non-gated tasks are done, write the **Morning Summary** in
   `STATE.md` (per-phase: what's built, screenshot paths, what needs Mason) and stop.

## Morning review protocol (for Mason)
The loop deploys **nothing**. In the morning Mason looks at the screenshots / a running preview per
phase, says yes/no, and only then — with his explicit OK — does a separate step push that phase to `main`
and deploy. Anything he dislikes is one `git revert` / one-click Vercel rollback away (and nothing went
live anyway).
