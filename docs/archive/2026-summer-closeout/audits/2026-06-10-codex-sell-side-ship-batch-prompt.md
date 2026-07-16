# Codex Cross-Review Packet — 2026-06-10 sell-side ship batch

**Verdict requested:** SHIP / SHIP-WITH-FOLLOWUPS / NEEDS-WORK, with file:line evidence for every finding.
**Scope:** two stacked branches, both already **applied to the live DB** (reversible via follow-up migration), **NOT pushed/merged** (`main` = production):

1. `ship/create-direct-order-role-gate` (commit `27fe55e`) — migration `20260610142204_create_direct_order_role_gate.sql`
2. `ship/partial-quote-draw-down` (commit `bfddbdf`, stacked on 1) — migration `20260610145253_partial_quote_draw_down.sql` + `src/pages/QuoteBuilder.tsx` + `src/types/index.ts` + `src/lib/db.ts` + doc updates

Background: both implement findings from `docs/audits/2026-06-10-sell-side-excellence-audit.md` (W1 and roadmap #1 v1). Each went through the standard gate: parallel reviewers clean (rls-security, migration-drift, compliance; + types-drift for #2), apply-guard proof, MCP apply, post-apply md5 fidelity check, rolled-back smoke tests (4-path for #1; 9-path e2e for #2), B7 disk rename.

## Job 1 — `create_direct_order` role gate (audit W1)

Claim to attack: the live function previously authorized ANY authenticated user (it binds `auth.uid()` + actor-mismatch but never checked role). The fix inserts the canonical `admin`/`sales_rep` `INSUFFICIENT_ROLE` gate after the actor-mismatch check and BEFORE the idempotency check; body otherwise byte-verbatim from live (pre-apply prosrc md5 `b16e630f34242ea92ffe0ee89d1bf0f7`; post-apply check: prosrc minus the two inserted fragments == that md5 → TRUE).

Review questions:
- Q1: Is the role set correct vs. every caller? (Sole UI caller `NewOrder.tsx:339`, route `admin`/`sales_rep` at `App.tsx:178`. No Edge Function / cron callers found.)
- Q2: Gate placement before idempotency — any cached-result leak path left?
- Q3: We deliberately kept the legacy error strings ('Authentication required'/'Actor mismatch') — any caller-visible breakage risk we missed?

## Job 2 — partial quote→order draw-down (roadmap #1 v1)

Design decisions to attack hardest:
- **D1 (the load-bearing one):** draw-down lives in a NEW per-(quote, product) ledger table `quote_product_draws`, NOT on `quote_items`, because live `save_quote` does `DELETE FROM quote_sections … -- (cascade deletes items)` on every edit — item-level tracking would be wiped by any revision. Verify this is true in live `save_quote` and that the product-keyed ledger has no consistency hole when a partially-drawn quote is revised (booked quantity can drop below drawn → remaining clamps to 0 by `GREATEST`; is that acceptable, or does it need a guard in `save_quote`?).
- **D2:** `draw_down_quote` only allows status `sent`/`revised`; full drain sets `accepted` WITHOUT `app.admin_override` (live `_enforce_quote_status_transition` allows sent/revised→accepted). Partial draws leave status unchanged. Concurrency: quote row `FOR UPDATE` serializes draws; ledger re-read per line inside the lock; duplicate product_ids within one p_draws array are safe (re-read per iteration). Try to construct an overdraw race anyway.
- **D3:** inventory semantics per draw: active holds for (quote, product) decrement FIFO (`quantity` floor 0, deactivate at 0) while `inventory.quantity_prebooked` increments by the drawn qty — Net Free (available − holds − prebooked) invariant. Verify no path double-counts (especially the final draw, where the status trigger `release_holds_on_quote_status_change` then deactivates leftover holds — deactivation only, no quantity restoration, per the no-phantom-restoration model).
- **D4:** draw orders carry ONE order_item per product at the booking-weighted average price of that product's quote lines (`quote_item_id` NULL, acres prorated). Known v1 simplification — exact when all lines of a product share one price. Is any downstream consumer (create_invoice_from_order / create_delivery_with_items / complete_delivery / update_order_items) broken by `quote_item_id` NULL or aggregated lines?
- **D5:** `convert_quote_to_order` reproduced verbatim from live (pre-apply md5 `c3ad989f37c703864a41b5ce43f077f8`; post-apply fidelity TRUE) + exactly: (a) `BOOKING_CLOSED` status guard (rejects draft/declined/expired/cancelled — audit W7) + `BOOKING_PARTIALLY_DRAWN` guard (no whole-convert of a drawn quote); (b) fully-drawn ledger upsert. Note the UI still calls it after `saveQuote('accepted')`, so the guard allows `accepted`-with-no-order. Attack the guard logic for gaps (e.g. revert_quote_status edge: accepted→sent revert of a DRAW order's quote — the ledger persists, so re-drawing is bounded; whole-convert after such a revert is blocked by the partially-drawn guard; is any double-booking path left?).
- **D6:** backfill marks accepted-with-order quotes fully drawn — live count was 0 accepted quotes total (no-op), and 0 sent/revised quotes have linked orders (rls-reviewer M2 check). Confirm.
- **D7:** money: order side stays numeric dollars (existing convention); line totals `ROUND(x, 2)`; audit-log impact `ROUND(total*100)::bigint`; commissions on drawn profit per draw order (sum over draws ≈ whole-quote commission, rounding at line level). Any cents/rounding drift worth blocking on?

Smoke evidence (all rolled back): partial 200/500 → hold 500→300, prebooked +200, quote stays sent, line 200@$10=$2,000; overdraw → BOOKING_OVERDRAWN; legacy convert → BOOKING_PARTIALLY_DRAWN; completing draw → accepted + ledger 500/40 + hold 0/inactive; accepted → BOOKING_CLOSED; empty → blocked; driver → INSUFFICIENT_ROLE; forged → ACTOR_MISMATCH; no-auth → AUTH_REQUIRED.

## How to verify (read-only)

- Live defs: `SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname IN ('create_direct_order','draw_down_quote','convert_quote_to_order','save_quote') AND pronamespace='public'::regnamespace;`
- Fidelity equations are stated in each migration header (md5s above).
- Table: `quote_product_draws` — RLS enabled, one SELECT policy (`is_admin() OR is_sales_rep()`), no write policies, UNIQUE(quote_id, product_id).
- Frontend: `QuoteBuilder.tsx` — `openDrawDownModal`/`handleDrawDown` + "Partial Order" button (visible only at `canConvert` = status 'sent') + modal; `db.ts` tokens; `types/index.ts` `QuoteProductDraw`.

## Known deferred (don't re-flag)
- Quotes-list drawn-progress indicator + cancel-order draw restoration + "Close booking" action = stage v2 (documented in the audit's spec).
- Tokens registered but no `hasRpcCode` callsite consumes them yet (UI surfaces raw message — convention-legal).
- `create_invoice_from_delivery` unused idempotency key + `'pending'` dead branch in `update_order_items` = parked audit findings, untouched here.
