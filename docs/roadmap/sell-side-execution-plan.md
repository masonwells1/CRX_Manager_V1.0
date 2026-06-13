# CRX Sell-Side Roadmap — Execution Plan & Live State

> **This file is the build loop's durable memory.** The `/loop` reads it at the start of
> every iteration and updates + commits it at the end. It survives context compaction —
> any fresh iteration resumes from here. Do not delete; only append/update.

**PROGRAM STATUS:** `IN_PROGRESS`
**Integration branch:** `chore/sell-side-roadmap` (worktree `C:\CRX_QuoteLifecycle`, based on `recovery/overlapping-sessions-2026-06-13`)
**Source spec (full depth):** `docs/audits/2026-06-10-sell-side-excellence-audit.md` §5
(retrieve: `git show docs/sell-side-excellence-audit-prompt:docs/audits/2026-06-10-sell-side-excellence-audit.md`)
**Loop body / contract:** `docs/roadmap/sell-side-roadmap-kickoff.md`

**Status tokens:** `TODO` · `IN_PROGRESS` · `BLOCKED-GATE:<id>` · `DONE` · `DEFERRED:<reason>`

---

## Hard rails (never violate)
- **DB is FILE-ONLY:** write + review migrations, prove with rolled-back `execute_sql` smoke tests (ROLLBACK at end — zero prod footprint). **Never** `apply_migration`, never merge-to-main, never deploy. (Overrides `/ship`'s auto-apply.)
  - **Backup-push AUTHORIZED 2026-06-13 (Mason):** after each iteration's commit, ALSO `git push origin chore/sell-side-roadmap` to keep the GitHub backup current. This is deploy-safe (non-`main` branch → no Vercel deploy, no migration apply). Still NEVER push/merge to `main` and NEVER apply/deploy — those remain the G5 owner gate.
- Every migration → full review gate (rls-security-reviewer + migration-drift-reviewer [+ types/pdf/compliance as relevant]) → fix until clean → write the `.claude/session-state/migration-review-<name>.json` proof.
  - **AMENDED 2026-06-13 (Mason: "continue without codex"):** `/codex-review` is DEFERRED from per-migration to ONE comprehensive `codex review --base main` run **immediately before G5 go-live** (Codex CLI hit its hourly usage cap). The in-house reviewer gate above stays MANDATORY + CLEAN per migration. Each file-only migration records `codex=PENDING`; **G5 is BLOCKED until the batch Codex pass is clean** and any findings fixed. Pending-codex migrations so far: `20260613170000` (#2 v1a) — plus every later migration this loop ships.
- One feature/stage per iteration, committed on `chore/sell-side-roadmap`. After each: `lint && build && test` green + the feature's rolled-back smoke chain passes ("fixed" = full chain, never an isolated probe).
- Money: bigint cents where stored as cents; numeric dollars order-side; append-only `financial_audit_log`; new entity_type/operation values added as CHECK **supersets**; idempotency + strict-actor + `search_path=public,pg_temp` on new RPCs; tokens in `RpcErrorCodes`; callers use `hasRpcCode` + `assertRpcResult`.
- **PAUSE** (ask Mason, don't guess, don't reschedule) at any owner gate below.
- Never edit `C:\CRX_Manager` (parallel session's WIP). Never touch the 3 blank-recipient commission rows. Never apply migration `20260611132115`.

## Owner gates (Mason-only decisions)
- **G1** — 3 blank commission recipients (Test Farm Alpha / Tim Jondle / Yeley Farms): correct names. `OPEN`
- **G2** — RUP expired-license classification: WARNING vs NON-COMPLIANT. `OPEN`
- **G3** — #2 revenue policy: rush orders post into ship-month or price-month? `ANSWERED 2026-06-13 → PRICE-MONTH`. When `price_order` finalizes a rush order, the linked invoice's `invoice_date` = the pricing/finalization date (default today), NOT the ship date — so revenue always posts into the current open period and never back-dates into a closed period. RESOLVED.
- **G4** — #7 driver-role credit behavior: warn vs block-with-override. `OPEN`
- **G5** — FINAL GO-LIVE (apply migrations + merge recovery+roadmap → main + deploy). Loop NEVER does this. `OPEN`
- **G-AE** (#5 auto-expire) — `ANSWERED 2026-06-13 → Option 1`: auto-expire ad-hoc sent/revised quotes past `expires_at` (release holds), but SKIP Planned Programs and drawn bookings. Implemented file-only in `20260613160000_auto_expire_quotes_skip_planned_and_schedule.sql`. RESOLVED.

---

## Roadmap items

### #5 — Unstick quote lifecycle — `DONE`  [dep: none]
- ✅ **UI slice SHIPPED (iteration 1, commit on `chore/sell-side-roadmap`):**
  - Decline + Cancel Quote buttons in `QuoteBuilder.tsx` (direct `quotes.status` UPDATE under RLS; the live `release_holds_on_quote_status_change` trigger releases holds on every terminal path). Guarded against abandoning an open booking's holds (skips when `quote_product_draws.quantity_drawn > 0`, parity with the Quotes bulk-delete skip).
  - Admin-only **Un-accept / Reopen** button wired to the hardened `revert_quote_status` RPC (idempotency + `assertRpcResult` + `hasRpcCode`; reason required; blocks accepted-with-order).
  - **"Cancelled"** option added to the Quotes list status filter (badges already existed via `statusToBadgeVariant`).
  - Verified vs LIVE DB: status CHECK has all 7 statuses; transition trigger allows sent/revised→declined/cancelled and accepted→sent; hold-release trigger covers all terminal paths.
  - Gate: lint 0, build clean, full suite 1997 passed/70 skipped, `compliance-reviewer` CLEAN. No migration in this slice → per-migration reviewers + `/codex-review` N/A.
  - Smoke chain WRITTEN as `docs/roadmap/smoke/05-quote-lifecycle.sql` (P1 decline / P2 expire-sim / P3 un-accept / P4 order-block). Could NOT run live: this session's Supabase MCP is **read-only** (see Environment notes). All four contracts verified by direct inspection of the live trigger/RPC bodies instead.
- ✅ **Auto-expire decision RESOLVED (gate G-AE = Option 1, iteration 2):** migration `20260613160000_auto_expire_quotes_skip_planned_and_schedule.sql` (FILE-ONLY) adds `AND q.is_planned = false` to `auto_expire_quotes` (skip Planned Programs; drawn bookings already skipped) and schedules it on pg_cron at 06:05 daily. Reviewers CLEAN (rls + drift); Codex iterated 3× (doc-drift, smoke `hold_type`, ledger placement) → SHIP. Context: WITHOUT this nothing auto-expired quotes — the 6:15 `release_expired_quote_holds` cron only mops up holds on quotes *already* declined/expired; it never read `expires_at`.
- **Done:** decline/cancel/un-accept reachable in UI ✅; expiry decision implemented ✅ (file-only migration, applies at G5); smoke scripts `05-quote-lifecycle.sql` + `05b-auto-expire-skip-planned.sql` written + reviewer/Codex-verified (live-run deferred — read-only MCP this session).

### #2 — Ship-now / price-later — `DONE`  [dep: #5 DONE ✅; gate G3 ANSWERED ✅ → price-month]
> G3 = price-month: `price_order` (v2) sets the linked invoice `invoice_date` to the pricing date (default today), never the ship date.
- ✅ **v1a SHIPPED (iteration 3, file-only):** `20260613170000_pricing_status_columns_and_post_gate.sql` — adds `orders.pricing_status`/`order_items.pricing_pending`/`invoices.pricing_pending`; CREATE OR REPLACE `post_invoice`+`post_invoice_group` (verbatim + `PRICING_INCOMPLETE` gate). Types + `RpcErrorCodes.PRICING_INCOMPLETE` updated. Reviewers CLEAN (rls 0/0/0+1 procedural NIT; drift 0/0/0; types 0/0/0; tsc green). Smoke `02a-pricing-gate.sql`. **⚠ /codex-review PENDING — Codex rate-limited until ~12:52 local 2026-06-13; MUST run on commit before G5.** Gate-before-producer (dormant until v1b).
- ✅ **v1b SHIPPED (iteration 4, file-only):** `20260613180000_create_rush_order.sql` — NEW SECDEF `create_rush_order` (canonical strict-actor; roles admin/sales_rep/driver/applicator; order confirmed + needs_pricing, $0 totals; items price/cost 0 + pending + tier-price snapshot in new `order_items.suggested_price`; prebook WARN-never-block; NO commissions; audit to activity_feed; idempotency scoped; ACL mirrors create_direct_order) + Orders `needs_pricing` filter (`Orders.tsx`). W1 `create_direct_order` role gate confirmed LIVE. Reviewers CLEAN (rls 0/0/0+1 NIT; drift 6/6 +doc-row; types 0/0/0; tsc green). codex=PENDING (pre-G5 batch). Smoke `docs/roadmap/smoke/02b-create-rush-order.sql`.
- ✅ **v2 SHIPPED (iteration 5, file-only):** `20260613190000_price_order.sql` — NEW SECDEF `price_order(order, [{order_item_id,price}])` (canonical strict-actor + admin/sales_rep; prices lines from `cost_at_time_cents` snapshot, recompute total/profit/margin, clear pending; when none pending → `pricing_status='priced'` + DEFERRED commissions on final profit [transition-gated, no double-insert] + sweep linked draft/unposted invoices dollars→cents + invoice_date=CURRENT_DATE [G3] + clear pricing_pending). Token `INVALID_PRICE`. Reviewers CLEAN (rls 0/0/0+2 NIT, N1 applied = sweep gated on transition; drift 0/0/0). Smoke `docs/roadmap/smoke/02c-price-order.sql` = the full done-criteria chain (rush→post-blocked→price→post-ok). codex=PENDING. **#2 BACKEND FLOW NOW COMPLETE.**
- ✅ **UI consolidation COMPLETE (frontend; nav badge deferred-optional):**
  - ✅ **Pricing screen SHIPPED (iteration 6, frontend-only):** OrderDetail "Set Pricing" panel — renders for `pricing_status='needs_pricing'` orders (admin/sales_rep); per-line price inputs default to `order_items.suggested_price`; "Finalize Pricing" → `price_order` (idempotency + assertRpcResult + hasRpcCode). compliance-reviewer CLEAN; tsc + lint green. No migration (no count change).
  - ✅ **Create-rush-order entry SHIPPED (iteration 7, frontend-only):** NewOrder "Ship now, price later (rush order)" toggle → `submitOrder` branches to `create_rush_order` (items {product_id,qty}); price/cost inputs disabled + banner in that mode; existing `create_direct_order` path byte-unchanged when off. compliance-reviewer CLEAN (1 NIT: resetKey-before-assert ordering, pre-existing convention shared with create_direct_order — deferred). tsc + lint green. No migration.
  - ✅ **Rep notification SHIPPED (iteration 8, frontend-only):** `notifyOrderNeedsPricing` (`notificationTriggers.ts`) fans out to admin + sales_rep via `profile_public_view`; called fire-and-forget from NewOrder's price-later branch after `create_rush_order`. tsc + lint green; self-reviewed vs red lines (mirrors `notifyAdmins`/`notifyLargeOrder` exactly — no money/RPC-assert/dialog surface).
  - 🟡 **Orders nav `needs_pricing` count badge → `DEFERRED:optional-polish`:** the Orders `needs_pricing` filter (v1b) + the rep notification already surface unpriced orders; a nav count badge needs a data-fetch inside the Sidebar nav component (+ a `Sidebar.test` supabase mock) for marginal at-a-glance value. Revisit post-G5 if Mason wants the count bubble.
- ✅ **v3 COMPLETE:**
  - ✅ **check_unpriced_orders cron SHIPPED (iteration 9, file-only):** `20260613200000` — adds `orders.pricing_reminder_sent_at`/`pricing_escalation_sent_at` + SECDEF `check_unpriced_orders()` (48h reminder + 7d escalation → notify admins + assigned sales rep; deduped via sent-at columns; cron 06:10). Reviewers CLEAN (rls/drift/types). Order type += 2 stamp columns. Smoke `02d`. codex=PENDING. Apply AFTER 170000.
  - ✅ **MonthEndClose checklist SHIPPED (iteration 10, frontend-only):** "Rush orders priced" pre-close review item in `MonthEndClose.tsx` — counts needs_pricing orders dated ≤ period end; `done` at 0 or admin-confirmed (mirrors payments/commissions review pattern); folded into `allChecksPassed` (stricter close gate). compliance-reviewer CLEAN; tsc + lint + MonthEndClose.test green.
  - 🟡 **Credit-surfacing → `DEFERRED:undefined-until-priced`:** an unpriced rush order has no $ amount until `price_order` sets it, so credit exposure is undefined; the existing `check_customer_credit_limit`/`checkCreditLimit` already fires at the real amount on normal order creation and at post time. Revisit only if Mason wants a projected-exposure estimate from `suggested_price`.
- ✅ **#2 DONE** (core flow + full UI + cron + month-end gate; nav badge + credit-surfacing deferred-optional with rationale).
- Migration: `orders.pricing_status` text NOT NULL DEFAULT 'priced' CHECK in ('priced','needs_pricing'); `order_items.pricing_pending` bool default false; `invoices.pricing_pending` bool default false. (Verify W1's `create_direct_order` role gate is live — CLAUDE.md says fixed `20260610142204`; confirm, don't re-fix blindly.)
- RPC `create_rush_order(customer, items[{product_id,qty}], notes, performed_by, idem)`: strict-actor; roles admin/sales_rep/driver/applicator; order confirmed + needs_pricing; items price 0 + pending; snapshot tier price; prebook (WARN never block); NO commissions yet; audit `order_created` (needs_pricing); notify reps.
- RPC `price_order(order_id, items[{order_item_id,price}], performed_by, idem)`: admin/sales_rep; FOR UPDATE; bypasses W2 fulfillment lock (price-only); recompute totals/profit; when no pending → priced + insert commissions on final profit + sweep linked DRAFT/UNPOSTED invoices (unit/extended cents, total, invoice_date, clear pending).
- **Gate:** `post_invoice` + `post_invoice_group` raise `PRICING_INCOMPLETE` if any pending; invoice CREATION still allowed, only POSTING blocked. Money-critical → Codex-worthy.
- UX: Orders filter `needs_pricing` + nav badge; pricing screen (price-only inputs, tier suggestion). Cron `check_unpriced_orders` (48h/7d). MonthEndClose checklist: 0 needs_pricing.
- **G3:** ship-month vs price-month revenue (invoice_date policy).
- Stages: v1 columns+create_rush_order+post-gate+filter; v2 price_order+invoice sync+deferred commissions+pricing screen; v3 cron+month-end+credit surfacing.
- **Done when:** rush order creatable unpriced, cannot mis-post; priced order posts; smoke chain (rush→post blocked→price→post ok) passes.

### #3 — Quote → farmer — `TODO`  [dep: none; only Stage A is autonomous]
- **Stage A (SHIP):** wire the dead "Email to Grower" button (`QuoteBuilder.tsx` ~2497) to the existing `send-email` Edge Function with the quote PDF; log to `email_log`.
- **Stage B (DEFER unless Mason opts in):** tokenized public quote-view page (signed UUID, read-only, Accept/Decline via narrow SECDEF RPC → accepted-pending / declined; gives W3's `declined` a real source).
- **Stage C (DEFER):** grower portal (booking balances from #1, invoices, statements, online pay).
- **Done(A) when:** email sends + logs; smoke proves end-to-end. Mark B/C `DEFERRED:portal-scope` unless Mason opts in.

### #4 — Order billing cockpit — `TODO`  [dep: none]
- OrderDetail billing panel listing all invoices; "Consolidate drafts" RPC (merge draft per-delivery invoices into one — Agvance pattern; draft-only, period/audit untouched, idempotent, audited); "Post all drafts" (loop `post_invoice`, one idem scope). Guard W5: block `create_invoice_from_order` when ANY non-cancelled delivery exists (today only checks pending).
- **Done when:** drafts consolidate + post in one step; double-representation prevented; smoke passes.

### #6 — Prepay-backed bookings — `TODO`  [dep: #1 live (yes); G1 if commissions touched]
- Link prepayments to a booking quote (`prepayments.quote_id` or join table); a draw's invoice auto-applies that booking's prepay first (extend existing auto/batch prepay apply); booking settlement view (booked/drawn/prepaid/remaining $ + qty); season-end rollover report.
- **Done when:** prepay links to booking; draw invoice auto-applies; settlement view; smoke passes.

### #7 — Credit enforce-with-override — `TODO`  [dep: gate G4]
- Order-creating RPCs: projected exposure > limit → raise `CREDIT_LIMIT_EXCEEDED` unless `p_credit_override=true` (admin/sales_rep), which proceeds + writes override + actor to `financial_audit_log`. UI: ConfirmModal showing the numbers.
- **G4:** driver-role behavior (warn vs block-with-override).
- **Done when:** over-limit blocks without override, proceeds+audits with override; smoke passes.

---

## Iteration log (loop appends one line per iteration)
- **Iter 1 (2026-06-13):** #5 UI slice — Decline/Cancel/Un-accept(Reopen) buttons + Cancelled filter (`QuoteBuilder.tsx`, `Quotes.tsx`). Frontend-only (no migration; DB triggers/RPC already live). lint 0 / build clean / 1997 tests pass / compliance-reviewer CLEAN. Smoke script `docs/roadmap/smoke/05-quote-lifecycle.sql` (verified by live-def inspection; live-run blocked by read-only MCP). PAUSED for gate G-AE (auto-expire schedule-vs-retire). Commit `ee3b4a2`.
- **Iter 2 (2026-06-13):** #5 → DONE. Gate G-AE answered (Option 1). Migration `20260613160000_auto_expire_quotes_skip_planned_and_schedule.sql` (FILE-ONLY): `auto_expire_quotes` += `is_planned=false` skip + pg_cron 06:05. Review gate: rls-security + migration-drift CLEAN (byte-fidelity confirmed vs live); Codex 3 rounds → SHIP (caught: doc-drift, smoke `hold_type` 'planned'→'crop_program' invalid-CHECK, ledger placement — all fixed). Doc counts 440→441; AGENTS.md regen. Smoke `05b-auto-expire-skip-planned.sql`. NOT applied/pushed.
- **Iter 3 (2026-06-13):** #2 → IN_PROGRESS. Gate G3 answered (price-month). v1a migration `20260613170000_pricing_status_columns_and_post_gate.sql` (FILE-ONLY): 3 pricing columns + `PRICING_INCOMPLETE` posting gate on post_invoice/post_invoice_group (verbatim + gate). Types + token updated; tsc green. 3 reviewers CLEAN (rls/drift/types). Doc counts 441→442; AGENTS.md regen. Smoke `02a-pricing-gate.sql`. Codex hit usage cap → committed `f3459ea` codex=PENDING. Per Mason ("continue without codex"), codex deferred to ONE pre-G5 batch (commit `7a0c6c7`). NOT applied/pushed.
- **Iter 4 (2026-06-13):** #2 v1b. Migration `20260613180000_create_rush_order.sql` (FILE-ONLY): NEW SECDEF `create_rush_order` + `order_items.suggested_price` column + Orders `needs_pricing` filter + `OrderItem.suggested_price` type. W1 gate confirmed live. In-house gate CLEAN (rls 0/0/0+1 NIT; drift 6/6 safety +1 MED doc-row fixed; types 0/0/0; tsc green). Doc counts 442→443 (+RPC 219→220); AGENTS.md regen. Smoke `02b-create-rush-order.sql`. codex=PENDING (pre-G5 batch). NOT applied/pushed.
- **Iter 5 (2026-06-13):** #2 v2. Migration `20260613190000_price_order.sql` (FILE-ONLY, MONEY-CRITICAL): NEW SECDEF `price_order` (price lines from cost snapshot → priced + deferred commissions + invoice sweep dollars→cents, invoice_date=today per G3). Token `INVALID_PRICE`. In-house gate CLEAN (rls 0/0/0+2 NIT [N1 sweep-gate applied]; drift 0/0/0); tsc green. Doc counts 443→444 (+RPC 220→221); AGENTS.md regen. Smoke `02c-price-order.sql` (full done-criteria chain). codex=PENDING. **#2 backend complete.** NOT applied/pushed. UI consolidation next.
- **Iter 6 (2026-06-13):** #2 UI — pricing screen. `OrderDetail.tsx` "Set Pricing" panel (needs_pricing orders, admin/sales_rep) → `price_order` with `suggested_price` defaults. Frontend-only (no migration). compliance-reviewer CLEAN; tsc + lint green. Committed `cbefd5f` + pushed.
- **Iter 7 (2026-06-13):** #2 UI — create-rush-order entry. `NewOrder.tsx` "Ship now, price later" toggle → `create_rush_order` (items {product_id,qty}); price/cost disabled + banner in rush mode; create_direct_order path unchanged when off. Frontend-only (no migration). compliance-reviewer CLEAN (1 NIT deferred: resetKey ordering, pre-existing convention). tsc + lint green. Committed `cddff03` + pushed.
- **Iter 8 (2026-06-13):** #2 UI — rep notification. `notifyOrderNeedsPricing` (notificationTriggers.ts) → admin+sales_rep fan-out; wired into NewOrder price-later branch. Frontend-only (no migration). tsc + lint green; self-reviewed vs red lines (pattern-identical to notifyAdmins). **#2 UI consolidation COMPLETE** (nav badge deferred-optional). Committed `fcd87fd` + pushed.
- **Iter 9 (2026-06-13):** #2 v3 — cron. Migration `20260613200000_check_unpriced_orders_cron.sql` (FILE-ONLY): orders dedupe stamps + SECDEF `check_unpriced_orders()` (48h/7d notify, deduped) + pg_cron 06:10. In-house gate CLEAN (rls 0/0/0/0+1 info; drift 0/0/0+2 info; types 0/0/0). Doc counts 444→445 (+RPC 221→222); AGENTS.md regen. Smoke `02d-check-unpriced-orders.sql`. codex=PENDING. Committed `1af29d9` + pushed.
- **Iter 10 (2026-06-13):** #2 v3 — MonthEndClose checklist + close out #2. `MonthEndClose.tsx` "Rush orders priced" pre-close review item (count needs_pricing ≤ period end; review-checkbox pattern; stricter close gate). Frontend-only. compliance-reviewer CLEAN; tsc + lint + MonthEndClose.test (4/4) green. Credit-surfacing DEFERRED (undefined until priced; existing credit check covers it). **#2 DONE.** Next: #3 Stage A. NOT applied/pushed-to-main.

## Follow-ups / deferred
- **#5 hardening (LOW, optional):** the Decline/Cancel drawn-booking guard is frontend-only (small TOCTOU window; worst case = orphaned holds, not financial corruption) — same convention as the existing bulk-delete skip. A belt-and-suspenders fix would be a DB-side trigger blocking sent/revised→declined/cancelled when `quote_product_draws.quantity_drawn > 0`. Bundle into a later #5/#6 migration if this protection class is ever hardened.

## Environment notes (this build session)
- **Supabase MCP is READ-ONLY here.** `execute_sql` cannot run write transactions (`25006: read-only transaction`) — even rolled-back ones. No local Postgres/Supabase (CLI shim broken, no psql). Consequence: migrations in later iterations will be WRITTEN + reviewed + `/codex-review`'d + have a rolled-back smoke SCRIPT saved under `docs/roadmap/smoke/`, but the live rolled-back smoke RUN is deferred to a write-capable session / the G5 apply step. Live function/constraint/trigger DEFINITIONS are still fully inspectable (read path), so verify-before-asserting still holds.

## GO-LIVE CHECKLIST (loop fills this in only when PROGRAM STATUS = ROADMAP-COMPLETE)
- (pending)
