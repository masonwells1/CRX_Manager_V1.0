# CRX Manager — UI Overhaul v2 Build Loop (5 features)

Date started: 2026-06-23
Branch: `feat/ui-overhaul-v2` (branched off `origin/main` = current production `db9b32ea`) — **NEVER `main`**
Owner: Mason (zero coding experience — he reviews by looking at a live preview link, not diffs)

This is the authoritative, self-contained spec for a self-paced build loop that ships the **five
improvements Mason chose on 2026-06-23** from the grounded UX audit (54 findings, see
`docs/build-loops/ui-overhaul/` for the prior, now-shipped, command-center + visual-refresh work).

## Owner decisions already made (baked in — the loop does NOT re-ask these)
- **Ship model = HOLD FOR REVIEW.** Build all five on this branch. Deploy NOTHING. Push the *feature
  branch* so Mason gets a Vercel preview per feature; he says "ship it" in the morning and a separate
  step merges that feature to `main`. One-click Vercel rollback always applies.
- **Action style = CONFIRM POPUP, STAY ON PAGE.** For "act from the list" + the Receiving Hub, a row's
  action opens a small confirmation popup (shows $, customer, order/PO #) → confirm → calls the
  **existing tested RPC in place** → toast + row refresh. No page navigation. These are real writes →
  **review-gated + Mason-tested before live** (see Write-actions rule below).

---

## The five features (priority order — lowest-risk / highest-value first)

> Each feature is independently reviewable and independently shippable. Build F1 fully, prove it,
> commit, push; then F2; etc. Verify every file target against live code before editing (names below
> are from the 2026-06-23 grounding pass).

### F1 — Search by product everywhere  ·  frontend-only · zero DB · AUTONOMOUS
**Pain:** *"search by product name instead of clicking on all the individual orders."* To-Ship solved
this for shipping; the rest of the app still can't.
- **`Orders.tsx`** — add a product-name search box that filters the list to orders containing a matching
  product. Orders don't carry product names today, so denormalize: fetch `order_items` product names for
  the visible orders (reuse the **two-query pattern from `ToShip.tsx`** — fetch orders, then their items —
  do NOT add a DB view/RPC). Show a small "contains: Atrazine ×2" hint on matched rows.
- **`Quotes.tsx`** — same product-name search over `quote_items`.
- **`CommandPalette.tsx`** — add the individual report names (AR Aging, Product Mix, Customer
  Profitability, Commissions) so typing "AR" jumps straight there. (Quick, frontend-only.)
- **Stretch (only if cheap):** a "Field applications by product" filter on `FieldInvoices.tsx` /
  `UnbilledApplications.tsx`. If it needs more than a frontend filter → mark `[!]`, skip.
- **Proof:** green gate + push for preview; cross-check via read-only SQL that a known product maps to
  the right orders/quotes.

### F2 — One customer = one screen (Customer 360)  ·  frontend · reads existing data · AUTONOMOUS
**Pain:** *"very spread out… bouncing around"* — the 8-tab customer view is the worst offender.
- **FIRST read the existing `src/components/customers/CustomerSummaryBar.tsx` and
  `src/components/team/CustomerContextCard.tsx`** — Customer 360 is partly built. EXTEND these; do not
  rebuild. Find what RPC/queries they already use (likely `get_ar_aging` / a customer summary source).
- **`CustomerDetail.tsx`** — ensure a **sticky summary strip** sits above the 8 tabs: total owed, open
  orders, # fields, license expiry, next compliance need — each number clickable to its tab. If
  `CustomerSummaryBar` already covers some, fill the gaps; don't duplicate.
- **Customer 360 drawer** — a slide-out (reuse/extend `CustomerContextCard`) openable from list rows on
  `Orders.tsx`, `Invoices.tsx`, `Deliveries.tsx`, `Customers.tsx`: recent orders, pending deliveries,
  open invoices + balance, and quick "new order / new quote / add note" buttons (the create buttons may
  deep-link to the existing New-* flows pre-filled with the customer — those navigations are safe/read-only).
- **Fields tab** — show each field's outstanding balance, color-coded, if the data is already available.
- Zero DB; reuse existing RPCs only. If a needed number has no existing source → mark `[!]`, skip that number.
- **Proof:** green gate + preview; cross-check the strip's numbers against the customer's own tabs.

### F3 — Act from the list (inline confirm-popup actions)  ·  REAL WRITES · REVIEW-GATED · Mason-tested
**Pain:** *"very clicky"* — the open-scroll-act-go-back loop on every record.
For each, **reuse the exact RPC the detail page already calls** (read the detail page to get the precise
RPC name + args — do NOT guess), wrapped in a confirm popup. Every write path carries
`useIdempotencyKey()` + `assertRpcResult()` + actor binding, exactly like the detail page.
- **`Orders.tsx`** — "Create Invoice" on confirmed orders → confirm popup → the same RPC `OrderDetail.tsx` uses.
- **`Quotes.tsx`** — "Convert to Order" on sent/revised quotes → confirm popup → `convert_quote_to_order`
  (as `QuoteBuilder.tsx` calls it).
- **`Deliveries.tsx`** — "Mark Complete" → popup capturing the required signed-by (and qty if needed) →
  the two-step `confirm_delivery` then `complete_delivery` exactly as `DeliveryDetail.tsx` does.
- **`InventoryPage.tsx`** — "Reorder" on a low-stock row → pre-filled New PO (this can stay a deep-link
  like To-Ship's Reorder; a confirm popup isn't needed for a navigation).
- **`BlendTickets.tsx`** — inline "Link Order" / "Create Invoice" using the blend-ticket RPCs the detail
  page uses.
- **Write-actions rule (NON-NEGOTIABLE):** the loop writes the *code* and runs the gate + the
  `compliance-reviewer` (and `rls-security-reviewer` if any SQL — there should be none) review subagents,
  but it **MUST NOT click-execute these against the live preview** (that creates a real invoice/order in
  prod). Prove with `[E2E]`-prefixed data per the E2E protocol, or leave the click for Mason in review.
  When F3 is the active feature, build it but mark the live exercise `[!]` for Mason.

### F4 — Merge the money pages into one AR workspace  ·  frontend consolidation · REVIEW-GATED (money)
**Pain:** *"what does this customer really owe me after credits?"* split across 4 pages.
- Merge **`ARaging.tsx` + `PaymentHistory.tsx` + `PrepaymentManager.tsx` + `CustomerTransactionReview.tsx`**
  into one tabbed **Accounts Receivable** workspace, customer chosen once. Tabs: Aging / Payments History /
  Prepayments / Ledger. **No change to any underlying action or RPC** — pure consolidation.
- 🚩 **HARD ROLE RULE:** those four are all **admin-only** → the merged workspace is **admin-only**.
  **DO NOT fold `/payments` (`PaymentAllocation.tsx`, which is `admin + sales_rep`) into it** — that would
  lock sales reps out. `/payments` STAYS a separate page. (CLAUDE.md red line; confirmed in `pagePermissions.ts`.)
- **Keep every old route working as a redirect** to the right tab so muscle memory + deep links don't break.
- Add a **"Net Money Position"** card: owed − unused prepay = true exposure, color-coded.
- Review-gated (touches money display); Mason reviews on preview before ship.

### F5 — Receiving Hub (To-Ship, for inbound)  ·  frontend + confirm-popup receive · REVIEW-GATED writes
**Pain:** receiving the same shipment can be done three ways; "what's truly available" is in three places.
- New page **`/receiving-hub`** (roles match Receiving = `admin + sales_rep`; **add the
  `pagePermissions.ts` entry or the route is deny-by-default**). Search a product → see every open PO line
  for it across vendors (`ordered − received`) → inline **"Receive"** confirm popup → the **same receive
  RPC `QuickReceive.tsx` / `PurchaseOrderDetail.tsx` already call** (read them for the exact name/args).
- Per-product **Commitment Snapshot** (On Floor · On Hold · On Order · Spoken-For · Available) reusing the
  already-fetched `get_inventory_position()`.
- Add a nav link + a Dashboard/Inventory entry point.
- Same Write-actions rule as F3: build + review + Mason-tests; never auto-receive against live prod.

---

## ⛔ HARD SAFETY ENVELOPE (this loop runs unattended — non-negotiable)
1. **Branch only.** All work on `feat/ui-overhaul-v2`. NEVER push `main`, NEVER merge to `main`, NEVER
   deploy, NEVER call `deploy_to_vercel`. Pushing *this feature branch* to origin is allowed (a non-`main`
   push does NOT deploy) and is how Mason gets a preview.
2. **ZERO database changes.** No migration / `apply_migration` / new-or-changed RPC / edge function /
   `execute_sql` write. Everything reuses EXISTING columns + EXISTING RPCs. **If a feature seems to need a
   DB change → STOP that piece, write a plain-English note in `STATE.md` under "Needs Mason," move on.**
   (Live DB changes always need Mason's explicit OK — they are never part of an unattended run.)
3. **Read-only on the live DB.** `SELECT`/introspection only, to verify data + RPC names. Never mutate live data.
4. **Frontend + docs only.** Touch `src/`, `tailwind.config.*`, and `docs/build-loops/ui-overhaul-v2/`.
   Respect every CLAUDE.md rule: lazy-load new pages, Tailwind (`crx-green`) + Lucide only, shared types in
   `src/types/index.ts`, single client `src/lib/db.ts`, `checkMutationResult()`/`assertRpcResult()` on every
   mutation, `useIdempotencyKey()` on writes, no `confirm()`/`alert()` (use the Modal component), no `any`.
5. **Write-actions are review-gated + human-tested, NOT fired blind.** (F3 + F5.) Write the code, run the
   gate + review subagents, but DO NOT execute the live write in the preview. Leave the click for Mason or
   prove with `[E2E]`-prefixed data. Mark the live exercise `[!]`.
6. **Preserve roles.** Never widen or narrow a page's `roles` without it being the explicit task. The
   `/payments` page MUST remain `admin + sales_rep`. New pages need a correct `pagePermissions.ts` entry.
7. **Never delete/redirect a routed page without proving it's safe.** Keep old money routes as redirects
   (F4); any actual removal goes in its own labeled commit.
8. **Done = ran and proven** — adapted to this worktree: **the worktree has NO `.env`, so the local dev
   server CANNOT boot and local screenshots are impossible.** Proof per task =
   `npm run lint && npm run typecheck && npm run build && npm run test` ALL green, **plus** a read-only SQL
   cross-check of any data the feature computes, **plus** pushing the branch so the Vercel preview builds
   for Mason. (Typecheck = `npm run typecheck`, which uses `tsconfig.app.json` — the only real typecheck.)
9. **Solo check each tick.** Re-read `STATE.md` fresh; confirm `git branch --show-current` is
   `feat/ui-overhaul-v2` and the tree has no changes you didn't make. Parallel-session collisions have bitten
   this repo — if you see unexpected edits, STOP and note it under "Needs Mason."
10. **Small commits.** One coherent task ≈ one commit, clear message, update `STATE.md` in the SAME commit.

---

## Pre-identified gates (why the loop can run unattended)
Mason's two decisions are baked in, so the only things that should stop the loop are genuinely his call:
- **A feature needs a NEW RPC/migration** (e.g. an aggregation too slow for a frontend query, or a receive
  path with no existing RPC) → `[!]` Needs Mason. Never write SQL.
- **The live exercise of a write action** (F3/F5) → `[!]` for Mason to click in review.
- **Final ship of each feature** → Mason reviews the preview and says "ship it."
- **A genuine aesthetic / business judgment** (e.g. which 5 numbers belong in the customer strip, if unclear).
- **A destructive removal** of any page/route.
Everything else (build, prove, commit, push the branch) proceeds without pausing.

## Per-iteration procedure (one tick)
1. Read `STATE.md`; solo-check; confirm branch.
2. Pick the next `[ ]` task in F1→F5 order; mark `[~]`.
3. Implement surgically (shared components first; reuse existing RPCs; match style).
4. Prove: green gate (lint+typecheck+build+test) + read-only SQL cross-check + (optionally) push branch.
5. Commit to `feat/ui-overhaul-v2`, updating `STATE.md` in the same commit.
6. If a piece hits a gate above → mark `[!]`, note it plainly in STATE, move on.
7. Self-pace the next tick. When only `[!]` Needs-Mason items remain, write the **Morning Summary** in
   STATE (per-feature: built / preview link / what needs Mason) and STOP (omit ScheduleWakeup).

## Morning review protocol (for Mason)
The loop deploys nothing. In the morning Mason opens the Vercel preview for the branch, clicks through
each feature (and exercises the F3/F5 action buttons himself), says yes/no per feature. Only with his
explicit OK does a separate step merge + deploy that feature. Anything he dislikes never went live.
