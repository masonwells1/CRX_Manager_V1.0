# CRX Live Foundation Gauntlet — Section 4 Refresh

**Section:** Quote → order → delivery → invoice → payment lifecycle wiring  
**Audit date:** 2026-08-05  
**Audit-start source:** clean `origin/main` commit `44b5b6d16a7c4d51290fc26fefc03c1daef76969`  
**Live database:** Supabase project `rhyzpcqhnizqbxphqdkr`  
**Verdict:** 0 BLOCKER / 1 HIGH / 0 MED / 0 LOW

## Production risk

**HIGH production risk was confirmed.** Bulk Order Import was a second order-creation path that could create an impossible fulfillment state and skip inventory reservation, commission creation, and the atomic order activity record. Exact-commit reviews also proved that PostgreSQL's non-finite `numeric` values (`NaN`, `Infinity`, and `-Infinity`) needed an explicit authoritative rejection guard and that an omitted optional cost could be inferred as zero, overstating profit and commission liability. All three risks are now closed live. The normal quote, order, delivery, invoice, and payment paths reviewed in this section were otherwise aligned with the live lifecycle constraints.

## Scope and evidence discipline

This audit used current repository code, Graphify navigation, migrations on disk, and read-only live Supabase catalog queries. It did not inspect Sentry, Vercel, GitHub pull requests, browser sessions, or production runtime telemetry.

The shared `C:\CRX_Manager` checkout started behind `origin/main` with pre-existing audit/handoff changes. Those files were recorded and left untouched. The audit ran in clean worktree `C:\Users\mason\.codex\worktrees\section4-lifecycle-20260805\CRX_Manager` from fresh `origin/main`.

Primary lifecycle evidence:

- Bulk quote import now uses `save_quote` rather than direct lifecycle-table inserts: `src/components/quotes/BulkQuoteImport.tsx:668-682`; its regression starts at `src/components/quotes/BulkQuoteImport.test.tsx:103`.
- Quote conversion callers use the idempotent `convert_quote_to_order` path: `src/pages/Quotes.tsx:52`, `src/pages/QuoteBuilder.tsx:227`, and the conversion regression at `src/pages/QuoteBuilder.test.tsx:1169-1199`.
- Direct order and delivery creation use canonical RPCs: `src/pages/NewOrder.tsx:516-530` and `src/pages/NewDelivery.tsx:410-436`.
- Delivery progression is confirm then complete: `src/pages/DeliveryDetail.tsx:750-755` and `src/pages/DeliveryDetail.tsx:815-838`.
- Order billing selects the split or non-split atomic RPC: `src/pages/OrderDetail.tsx:862-885`; split groups post atomically at `src/pages/OrderDetail.tsx:963-970`.
- Payment entry uses `allocate_payment`: `src/pages/InvoiceDetail.tsx:1019-1035` and `src/pages/PaymentAllocation.tsx:286-299`.
- Live catalog evidence showed one overload for each reviewed public lifecycle RPC, fixed `search_path=public, pg_temp`, Row Level Security enabled on the lifecycle tables, and live CHECK values aligned with current callers.

## Finding

### HIGH — Bulk Order Import bypassed the canonical order lifecycle

**Exact evidence**

- At audit-start commit `44b5b6d1`, `src/components/orders/BulkOrderImport.tsx:57-62`, `:247`, and `:425-436` accepted an optional imported status and forwarded it to `bulk_import_order`.
- The latest pre-fix disk definition, `supabase/migrations/20260513140000_bulk_import_order_seed_quantity_remaining.sql:65-73`, accepted `confirmed`, `partially_fulfilled`, `fulfilled`, or `cancelled`. It then initialized every imported line with `quantity_delivered = 0` and `quantity_remaining = total_units_needed` at `:87-111`.
- Live `pg_proc` evidence matched that disk body exactly: signature `bulk_import_order(text,uuid,text,numeric,numeric,numeric,numeric,date,jsonb,text,text)`, MD5 `c835fe992c8a2011d46aa7610c7fe06a`, `SECURITY DEFINER`, fixed search path, anon denied, authenticated allowed. The live body contained the partial/terminal status CASE and did not contain `_insert_commissions_for_order`, an `inventory.quantity_prebooked` update, a booked `inventory_transactions` insert, or an `activity_feed` insert.
- The canonical direct-order implementation performs all omitted effects: inventory prebooking and a `booked` ledger row at `supabase/migrations/20260614142939_create_direct_order_customer_po_param.sql:172-187`, commissions at `:190-193`, and activity at `:195-205`.
- Live `orders_status_check` permits partial and terminal statuses, so the database CHECK did not reject the structurally inconsistent rows. Live `order_items` constraints only required nonnegative delivered/remaining quantities and likewise did not tie those quantities to the order status.

**Plain-English business risk**

A CSV or OCR import could label a completely undelivered order as partly fulfilled, fulfilled, or cancelled. Even a normal confirmed import did not reserve stock, so Net Position could show inventory as free for another sale. The same side door skipped commission creation and the atomic audit event. That creates oversell risk, missing commission liability, misleading fulfillment status, and downstream delivery/invoice behavior based on an order state that never occurred.

**Suggested fix**

Keep the RPC signature for deployed caller compatibility, but allow imports to create only `confirmed` orders. Validate active actors/customers/products, explicitly reject non-finite quantities/prices/costs, normalize legacy dollar inputs to cents, snapshot the active Product's current cost when an import omits it, recompute totals server-side, seed correct order-line totals and remaining quantities, prebook inventory, write the booked inventory ledger, create commissions from the customer's split, and write the order-created activity inside the same transaction. Reject non-confirmed statuses in the frontend for a clear operator message and again in PostgreSQL as the authoritative guard.

**Prevention action**

Register a rollback-only `bulk_import_order` business-chain smoke and a migration-body contract test. The smoke must prove terminal-status rejection, all three non-finite values are rejected for quantity/price/cost with zero residue, sub-cent normalization, omitted-cost Product snapshot, malformed-cost rejection, server-recomputed totals, inventory prebooking, booked ledger, commission, activity, and idempotent replay. The frontend regression must prove every successful import sends `p_status: 'confirmed'`, rejects terminal-status files before calling the RPC, leaves omitted cost absent so PostgreSQL snapshots it transactionally, and preserves an explicit zero.

## Remediation prepared in this run

- Forward-only migration `supabase/migrations/20260805211951_harden_bulk_order_import_lifecycle.sql` implements the database fix. Supabase assigned ledger version `20260805211951` to the submitted `20260805204716` candidate; the disk file was B7-renamed content-identically. Key guards/effects are at `:49-88`, `:91-130`, `:132-243`, and `:245-294`.
- The first exact-commit Sol review correctly blocked publication because PostgreSQL accepts non-finite `numeric` values. Forward-only follow-up `supabase/migrations/20260805220757_reject_nonfinite_bulk_import_values.sql:112-137` rejects all non-finite quantity/price/cost values and rounds unit and extended dollar amounts to cents before writes. It leaves the already-applied migration immutable.
- The second exact-commit Sol review correctly blocked publication because missing optional cost was being inferred as zero. Forward-only live follow-up `supabase/migrations/20260805224819_snapshot_bulk_import_product_cost.sql` snapshots `products.current_cost` when cost is absent, preserves explicit zero, rejects malformed/unavailable cost, and uses one normalized item snapshot for every downstream write.
- `src/components/orders/BulkOrderImport.tsx:57-61`, `:164-195`, `:235-312`, `:384`, `:446-497`, and `:558-559` enforce confirmed-only imports, validate numeric CSV fields, resolve Product cost without destroying explicit zero, and explain the behavior.
- `src/components/orders/BulkOrderImport.test.tsx` proves canonical status, terminal-status rejection, omitted cost remains absent for the transactional PostgreSQL snapshot, malformed-cost rejection, and explicit-zero preservation.
- `src/lib/rpcContracts.test.ts` pins the lifecycle effects, finite/cents guards, Product fallback, malformed-cost guard, and normalized snapshot.
- `scripts/smoke/smoke-bulk-order-import-lifecycle.sql` and its `smoke-specs.json` registration provide the full rollback-only business chain, including nine non-finite cases, omitted/malformed cost, commission-basis proof, and residue checks.

## Proof completed before live apply

- Focused frontend/RPC contracts: 95 passed.
- TypeScript: passed.
- ESLint: passed with `--quiet`.
- Changed-migration SQL validator: 3 files, 0 violations, 0 warnings. The full historical mode exceeded the command window; changed-only is the repository's documented per-change zero-baseline gate.
- Drift tests: 235 passed, 78 skipped.
- Full Vitest suite: 4,275 passed, 123 skipped.
- Production build: passed.
- Correction/safety guards: passed.
- All 21 live invariant predicates: zero unallowlisted violations.
- Pre-apply live rehearsal: candidate migration + `plpgsql_check` + full smoke reached `SMOKE_PASS_ROLLBACK` in one aborted transaction.
- Rollback verification: live function hash remained `c835fe992c8a2011d46aa7610c7fe06a`; zero smoke orders, customers, products, or idempotency receipts remained.
- Follow-up pre-apply rehearsal replaced the live function inside an aborted transaction, rejected `NaN`/`Infinity`/`-Infinity` for all three imported numeric fields, normalized sub-cent prices, and reached `SMOKE_PASS_ROLLBACK`. The prior live hash `8432af00f788d364b934782d12a6c640` and zero-residue counts were unchanged afterward.
- Final pre-apply rehearsal replaced the live function inside an aborted transaction, proved omitted cost snapshots the active Product cost, proved malformed cost fails before every lifecycle write, verified commission basis, and reached `SMOKE_PASS_ROLLBACK`. The prior live hash `4c38bd47d81f7c5dec54533cb7d57bca` and zero-residue counts were unchanged afterward.

## Live apply and post-apply proof

- Supabase applied lifecycle ledger version `20260805211951`, finite-number follow-up `20260805220757`, and Product-cost snapshot follow-up `20260805224819` successfully.
- Live catalog: one overload; `SECURITY DEFINER`; `search_path=public, pg_temp`; anon denied; authenticated/service access preserved; final MD5 `4d2846e11bd8b1e0753c667c2d194abf`.
- Live body markers confirm confirmed-only status, server totals, Product-cost fallback, one normalized item snapshot, malformed-cost rejection, inventory prebooking, booked ledger, commissions, activity, and operation-scoped idempotency.
- Applied business-chain smoke returned `SMOKE_PASS_ROLLBACK`, including all nine non-finite cases plus omitted/malformed cost; zero smoke orders, customers, idempotency receipts, or inventory transactions remained.
- Supabase advisors returned the expected generic authenticated-`SECURITY DEFINER` warning for this intentionally exposed, active-role-gated RPC and no target performance finding.
- The live-introspection schema registry now records high-water `20260805224819` and all three applied migration names; generated-column/status/no-`updated_at` counts remain 11/38/91.
- Both content-bound migration reviewer charters were CLEAN on `gpt-5.6-sol` / high for each migration. Branch-level exact-commit reviews found the non-finite-input and missing-cost gaps before publication; both required forward-only fixes are implemented and live.

Protected pull-request publication remains governed by the repository's final exact-SHA review, required checks, and CodeRabbit review gates.

## Next section queued

**Section 5 — database drift** is next: it is the lowest-numbered section among the oldest remaining 2026-07-22 refreshes.
