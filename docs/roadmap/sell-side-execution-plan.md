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
- **DB is FILE-ONLY:** write + review migrations, prove with rolled-back `execute_sql` smoke tests (ROLLBACK at end — zero prod footprint). **Never** `apply_migration`, never push/merge/deploy. (Overrides `/ship`'s auto-apply.)
- Every migration → full review gate (rls-security-reviewer + migration-drift-reviewer [+ types/pdf/compliance as relevant]) → `/codex-review` → fix until clean → write the `.claude/session-state/migration-review-<name>.json` proof.
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

### #2 — Ship-now / price-later — `IN_PROGRESS`  [dep: #5 DONE ✅; gate G3 ANSWERED ✅ → price-month]
> G3 = price-month: `price_order` (v2) sets the linked invoice `invoice_date` to the pricing date (default today), never the ship date.
- ✅ **v1a SHIPPED (iteration 3, file-only):** `20260613170000_pricing_status_columns_and_post_gate.sql` — adds `orders.pricing_status`/`order_items.pricing_pending`/`invoices.pricing_pending`; CREATE OR REPLACE `post_invoice`+`post_invoice_group` (verbatim + `PRICING_INCOMPLETE` gate). Types + `RpcErrorCodes.PRICING_INCOMPLETE` updated. Reviewers CLEAN (rls 0/0/0+1 procedural NIT; drift 0/0/0; types 0/0/0; tsc green). Smoke `02a-pricing-gate.sql`. **⚠ /codex-review PENDING — Codex rate-limited until ~12:52 local 2026-06-13; MUST run on commit before G5.** Gate-before-producer (dormant until v1b).
- ⏭ **v1b NEXT:** `create_rush_order` RPC (strict-actor; admin/sales_rep/driver/applicator; order confirmed + needs_pricing; items price 0 + pending; snapshot tier price; prebook WARN-not-block; NO commissions; audit + notify) + Orders `needs_pricing` filter & nav badge. (First re-confirm W1 `create_direct_order` role gate is live before modeling on it.)
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
- **Iter 3 (2026-06-13):** #2 → IN_PROGRESS. Gate G3 answered (price-month). v1a migration `20260613170000_pricing_status_columns_and_post_gate.sql` (FILE-ONLY): 3 pricing columns + `PRICING_INCOMPLETE` posting gate on post_invoice/post_invoice_group (verbatim + gate). Types + token updated; tsc green. 3 reviewers CLEAN (rls/drift/types). Doc counts 441→442; AGENTS.md regen. Smoke `02a-pricing-gate.sql`. **/codex-review PENDING (Codex rate-limited ~12:52 local) — next wakeup runs it before v1b.** NOT applied/pushed.

## Follow-ups / deferred
- **#5 hardening (LOW, optional):** the Decline/Cancel drawn-booking guard is frontend-only (small TOCTOU window; worst case = orphaned holds, not financial corruption) — same convention as the existing bulk-delete skip. A belt-and-suspenders fix would be a DB-side trigger blocking sent/revised→declined/cancelled when `quote_product_draws.quantity_drawn > 0`. Bundle into a later #5/#6 migration if this protection class is ever hardened.

## Environment notes (this build session)
- **Supabase MCP is READ-ONLY here.** `execute_sql` cannot run write transactions (`25006: read-only transaction`) — even rolled-back ones. No local Postgres/Supabase (CLI shim broken, no psql). Consequence: migrations in later iterations will be WRITTEN + reviewed + `/codex-review`'d + have a rolled-back smoke SCRIPT saved under `docs/roadmap/smoke/`, but the live rolled-back smoke RUN is deferred to a write-capable session / the G5 apply step. Live function/constraint/trigger DEFINITIONS are still fully inspectable (read path), so verify-before-asserting still holds.

## GO-LIVE CHECKLIST (loop fills this in only when PROGRAM STATUS = ROADMAP-COMPLETE)
- (pending)
