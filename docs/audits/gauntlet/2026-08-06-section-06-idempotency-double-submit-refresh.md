# Section 6 — Idempotency and Double-Submit Safety Refresh

**Audit date:** 2026-08-06  
**Audit checkout:** `25a6ee83b5a87331aaa56277391677cd16b58382` (clean current `origin/main` at capture)  
**Live evidence captured:** 2026-08-06 12:54:52 UTC  
**Scope:** authenticated mutating RPC contracts, frontend callers, replay semantics, double-submit guards, and retry ambiguity  
**Mode:** read-only; no repository code, live schema, or live data changed

## Verdict

**0 BLOCKER / 1 HIGH / 3 MED / 2 LOW**

The server-side idempotency foundation is broad and materially stronger than the caller layer: keyed mutating RPCs generally lock, fingerprint, and replay correctly, and the live receipt ledger showed no partial intent bindings. The open risk is concentrated in frontend sequencing and unstable or omitted keys. The most serious case can finalize a cycle count from stale persisted quantities while item saves are still in flight.

## Publication refresh — 2026-08-07

Before publication, `origin/main` advanced to `b34b5ddb1968173af169eca36e7fc0496388ef86`. The finding-bearing caller files cited below and the local ESLint rule were unchanged from the audit checkout. The new `log_customer_fact` RPC and its registry entry were reviewed: it requires a nonblank key, fingerprints the request, replays through the shared helpers, and is included in the dynamic contract inventory. Current `test:idempotency` and `test:contracts` proof was rerun for publication. The live counts below remain the dated August 6 packet rather than being relabeled as August 7 evidence.

## Findings

### HIGH — Cycle Count can complete against stale persisted quantities

`src/pages/CycleCounts.tsx:621-628` calls `update_cycle_count_item` from every quantity `onChange`. The asynchronous handler at `:242-280` has no per-row queue, latest-intent token, or shared pending registry. The Complete action at `:283-325` and button at `:692-707` are disabled only for the completion request itself, not for outstanding item writes.

The database functions both lock the parent count, but that provides mutual exclusion rather than intent ordering. `update_cycle_count_item` takes the parent lock and writes `counted_qty`/variance (`supabase/migrations/20260501130000_field_app_workflow_phase18.sql:82-122`). `complete_cycle_count` takes the same parent lock and applies the quantities already persisted to inventory and transactions (`supabase/migrations/20260501120000_field_app_workflow_phase17.sql:67-139`). A fast edit followed by Complete can therefore let completion acquire the lock before the latest item RPC, or allow an older rapid-input request to land last. Inventory may be finalized from an old value even though the screen showed the new one.

**Fix:** keep local row drafts, save on blur/Enter or through an ordered per-row queue, track every outstanding write, and disable Complete until the latest intended value for every row is acknowledged. Add delayed and out-of-order RPC tests plus explicit Complete gating.

### MED — Bulk Field Import creates a fresh key for each retryable row attempt

`src/components/fields/BulkFieldImport.tsx:396-444` calls `save_field` with `p_field_id: null` and a new `crypto.randomUUID()` inside each attempt. The current `save_field` implementation replays only the same key and inserts whenever the field id is null (`supabase/migrations/20260729222311_bind_save_field_actor.sql:44-82`). There is no natural uniqueness constraint or pre-insert lookup that turns a changed key into the same field.

The `uploading` flag mitigates a direct same-render double-click, but it does not protect a lost-response retry, closing and reopening the import, or rerunning the same file. Those paths create a second field with a different key. The fresh live probe found **0** active duplicate customer/field-name groups, so this is a reachable defect without observed current residue.

**Fix:** derive and retain one stable key per imported row for the entire import intent, including retry/reopen recovery. Prefer an atomic field-plus-boundary server operation where practical, and add a lost-response replay test.

### MED — Blend Recipe Duplicate omits the key and has no row-level in-flight guard

Normal recipe save uses a stable key (`src/pages/BlendRecipes.tsx:62,203-229`), but the Duplicate handler calls `save_blend_recipe` with a null recipe id and no `p_idempotency_key` (`:242-278`). Its row button remains enabled during the request (`:371-379`). The RPC inserts a new header whenever the id is null and only checks/saves replay state when a key is supplied (`supabase/migrations/20260619150000_save_blend_recipe_carry_price.sql:43-81,138-145`). Recipe names are intentionally non-unique.

A double-click or a retry after a lost success response can create duplicate recipe headers and item sets. The live probe found **0** active duplicate recipe-name groups.

**Fix:** cache a stable key per source-row duplicate intent until confirmed success, disable that row while it is in flight, and consider requiring a key server-side on the create path.

### MED — Negative-inventory reconciliation can append a second false audit event on retry

`src/components/inventory/IntegrityCleanupPanel.tsx:317-349` creates a fresh UUID for each reconciliation attempt and carries a local lint suppression. `reconcile_negative_inventory` checks only the same supplied key but always performs an update and inserts an inventory transaction for a new key (`supabase/migrations/20260501160000_field_app_workflow_phase22.sql:72-115`).

If the first request commits but its response is lost, retrying with a fresh key adds a second zero-delta “reconciliation” transaction. Quantity does not move twice, but the audit trail falsely records a second business action.

**Fix:** retain the reconciliation intent key through ambiguous failure/retry and add a replay test asserting one transaction row.

### LOW — Damaged-receipt notification retries can duplicate admin alerts

`src/lib/notificationTriggers.ts:404-424` creates a fresh UUID for each call. The receiving callers invoke it after the protected receiving operation (`src/pages/PurchaseOrderDetail.tsx:306-315`; `src/components/purchase-orders/QuickReceivePanel.tsx:342-350`). The notification RPC replays only the same key and otherwise inserts one notification per administrator (`supabase/migrations/20260527020457_grant_authenticated_on_frontend_secdef_helpers.sql:156-193`), with no business-key deduplication.

Receiving itself remains protected, so the consequence is duplicate alerts rather than duplicate stock. Retain a deterministic key derived from the receipt/damage event or add a notification business-key uniqueness guard.

### LOW — Prevention checks are server-strong but caller-blind

The dynamic server inventory in `src/lib/rpcContracts.test.ts:2002-2396` checks that mutating RPC definitions declare and use the shared contract. It does not prove that each frontend call supplies a stable key or blocks concurrent intent. The local lint rule grandfathers known exceptions and only evaluates a `p_idempotency_key` property when that property already exists (`eslint-local-rules/eslint-local-rules.cjs:42-59,210-219`). It therefore cannot catch the Blend Duplicate omission and cannot distinguish a key generated per attempt from a key retained per business intent.

Add AST-based caller coverage for mutating RPC calls, with narrow documented exemptions, plus focused regressions for Bulk Field Import, Blend Duplicate, reconciliation, and Cycle Count completion sequencing.

## Server and live evidence

- Live migration ledger: **943** rows through `20260806023048`.
- Direct-DML heuristic: **151** authenticated application-owned mutating signatures; **144** keyed and **7** classified as natural/maintenance operations: `check_remainder_reminders`, `check_unpriced_orders`, `reconcile_prepay_balances`, `refresh_watchdog_flags`, `release_expired_quote_holds`, `set_primary_customer_contact`, and `settle_applied_record_acres`.
- **170** authenticated RPC names declared `p_idempotency_key` in the audit snapshot.
- Frontend AST inventory: **221** non-test RPC call sites.
- Shared helpers lock the key, bind the operation, fingerprint payloads where required, and preserve cross-operation separation.
- Live receipt ledger: **35** receipts; **0** partial intent bindings and **0** unexpired legacy unbound rows.
- `save_job_applied_record` retained its table-native partial uniqueness and `unique_violation` replay protection.
- Fresh live duplicate probes found **0** active customer/field-name duplicate groups and **0** active blend-recipe duplicate-name groups.

## Verified-safe omissions and non-findings

- `stamp_job_printed` is an absolute last-stamp update; repeated calls do not compound business state.
- `confirm_job_notification_sent` row-locks the failed-to-sent transition and no-ops after success; the edge email path uses a deterministic key.
- `update_field_app_applied_info` is an absolute draft/unposted update rather than an additive mutation.
- `mark_inventory_row_verified` is an absolute verification stamp.
- `create_invoice_for_unbilled_delivery` retains its business uniqueness guard.
- Repeating `update_cycle_count_item` with the same payload is safe at the RPC layer; the scored defect is frontend ordering across different intended values and completion.
- `log_failed_notification` records each distinct caught failure occurrence. It was not scored as a replay of a successfully committed business mutation.

## Proof run

- `npm run test:idempotency` — **3 files / 22 tests passed**. These tests validate/print the SQL chains; they do not execute the live RPCs.
- `npm run test:contracts` — **3 files / 101 tests passed** at audit time.
- Focused companion contract run — **101 tests passed**; it selected the existing contract files and confirmed there was no dedicated Bulk Field Import or Blend Recipe regression.
- ESLint — passed.
- Gauntlet loop deterministic test — passed.
- Changed-only SQL validator — passed with **0 changed SQL files** on the audit checkout.
- Graph refreshed from the audit SHA: **9,278 nodes / 19,507 edges**; material edges were verified in source and migrations.
- Two independent skeptical reviews unanimously confirmed the Cycle Count finding as HIGH. Both confirmed the Bulk Field Import defect, with a HIGH/MED severity split; it is conservatively scored MED because the immediate double-click is gated and no live duplicate residue was found.

## Limits

The official Section 6 settlement tool was unavailable, so the section was adjudicated manually from current source, migration bodies, generated inventories, and the fresh read-only live packet. No independent signed-in browser reproduction or live mutating RPC execution was performed because this was a read-only audit. The concurrency findings are established from caller behavior and lock/write ordering; their recommended fixes require delayed/out-of-order execution tests.

## Next section

Section 7 — commissions, splits, payout batches, cancellations, and voids.
