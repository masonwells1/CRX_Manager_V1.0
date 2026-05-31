# Phase 4 — Inventory and Purchasing Audit

**Date:** 2026-05-04
**Auditor:** Claude (Opus 4.7, 1M context)
**Scope:** Products, inventory page, planned holds, prebooked inventory, purchase orders, receiving log, quick receive, returns, delivery completion impacts on inventory, and cycle counts. **Read-only.** No code changed.
**Mantra:** The app's inventory must match the real product on the shelf. This phase looks for places where the books can drift from physical reality.

---

## Plain-English Summary

The good news first: the heavy lifting for inventory is already in PostgreSQL. When a delivery completes, when a PO is received, when a return comes in, when a cycle count finishes — those numbers move because of server-side RPCs (`complete_delivery`, `receive_po_items`, `receive_return`, `complete_cycle_count`, etc.) that run inside transactions, log to `inventory_transactions`, and (mostly) take idempotency keys. That is the right architecture, and it is mostly working.

The bad news is that the **Inventory page itself is not authoritative**. The big "Net Position" number on the inventory dashboard is computed in the browser by adding up four separate queries — holds, on-order, planned-quote-demand, and delivered-YTD. INVENTORY_RULES.md explicitly says "all inventory math happens in the database, NOT in React." The Inventory page violates that rule. There is also an auxiliary "Net Free" formula used elsewhere on the page (the manual-hold warning — `src/pages/InventoryPage.tsx:445`) that uses different math than the column. Two formulas, two answers, one screen.

Other concerns are smaller but real:

- **Negative inventory is allowed everywhere.** The `chk_inventory_qty_available` CHECK was deliberately dropped (migration `20260333800000`) so that `complete_delivery` never blocks. That was the right call for "driver has product on the truck, let them deliver it" — but there is no UI guardrail and no reconciliation pressure other than admin notifications. As of the most recent cleanup, 17 production rows were negative.
- **Manual holds are inserted directly from the browser.** `InventoryPage.tsx:454` does `supabase.from('inventory_holds').insert(...)` with no RPC, no `FOR UPDATE`, no atomic check against current `quantity_available`. Two admins clicking "Create Hold" simultaneously can put the system into a state where total holds exceed available — the warning before submit is opt-in.
- **`approve_return`, `issue_return_credit`, `cancel_return`, `reject_return` are not idempotent.** The first two accept `p_idempotency_key` parameters that the server quietly ignores (no `check_idempotency` call in body — confirmed by reading the actual function definitions). The last two bypass RPC entirely with bare `.update()` calls.
- **Cancelling a received return does not reverse the inventory restock.** Once `receive_return` runs, the inventory is added back. If the return is later cancelled by `Returns.tsx:333` (a bare `.update({ status: 'cancelled' })`), the inventory is NOT removed again. Books drift.

Phase 21 G2 (over-receive opt-in) is correctly implemented and is a real improvement. Phase 22 cleanup tooling (`/integrity-cleanup`) is the right place to drain the existing 17 negative rows. The remaining work in Phase 4 is to tighten the page-level controls so new drift cannot enter the system once cleanup is done.

---

## Evidence Reviewed

| Source | What I read |
|---|---|
| `CLAUDE.md` | Hard red lines, lifecycle definitions, schema gotchas |
| `docs/workflows/SAFE_DEVELOPMENT_RULES.md` | Mandatory safety rules, Migration Safety, Pipeline Change Safety |
| `docs/workflows/INVENTORY_RULES.md` | Net Free formula, 11 transaction types, "all math in DB" rule |
| `docs/workflows/QUOTE_TO_DELIVERY.md` (skim, Stage 3) | Confirm/complete/cancel/void delivery semantics |
| `docs/audits/2026-05-04-phase-0-current-state-audit.md` | Baseline; pre-flagged "inventory math in browser" |
| `docs/CHANGELOG.md` | Phase 21/22 cleanup status, integrity targets |
| `src/pages/InventoryPage.tsx` (1554 lines, read in full) | Net Position calc, hold creation, batch adjust |
| `src/pages/PurchaseOrderDetail.tsx` (read 1–270) | Receive flow, over-receive guard |
| `src/pages/QuickReceive.tsx` (lines 270–310) | Bulk receive flow, over-receive disabled |
| `src/pages/Returns.tsx` (read 1–400) | Lifecycle wiring, cancel/reject paths |
| `src/pages/CycleCounts.tsx` (read 1–380) | Complete and reverse paths |
| `src/pages/ReceivingLog.tsx` (read 1–60) | Receive history surface |
| `supabase/migrations/20260319200000_complete_delivery_remove_inventory_block.sql` | Negative-inventory-allowed delivery |
| `supabase/migrations/20260333800000_drop_inventory_qty_available_check.sql` | CHECK removal that allows negative |
| `supabase/migrations/20260331900000_fix_cancel_delivery_prebooked_release.sql` | Confirmed cancel_delivery semantics |
| `supabase/migrations/20260332000000_fix_void_delivery_batch_cancel_prebooked.sql` | void_delivery + cancel_order final form |
| `supabase/migrations/20260332300000_fix_void_delivery_three_bugs.sql` | Latest void_delivery body |
| `supabase/migrations/20260331700000_fix_inventory_transaction_type_check.sql` | The 11 allowed transaction types |
| `supabase/migrations/20260316100001_inventory_hold_restoration.sql` | Hold release on quote status change |
| `supabase/migrations/20260213180000_phase6_returns_rma.sql` | Returns RPC origins |
| `supabase/migrations/20260316100002_return_credit_ar_integration.sql` | issue_return_credit (no idem in body) |
| `supabase/migrations/20260331600000_consolidate_all_rpc_overloads.sql` | Dynamic injection that may have produced stale-idem returns RPCs |
| `supabase/migrations/20260333000000_fix_reverse_cycle_count_search_path_and_idempotency.sql` | reverse_cycle_count latest form |
| `supabase/migrations/20260304200000_quick_receive.sql` | match_quick_receive_items |
| Commit `6a61723` (Phase 21 G2) | PO over-receive default → false |
| Commit `2f2d66a` and CHANGELOG | Phase 22 / Sprint G3+G4 (integrity-cleanup) |

---

## Findings

### P4-1 — Inventory page's "Net Position" is calculated in the browser

**Business risk.** This is the single most-watched number on the inventory page — Mason and his sales reps look at "Net Position" to decide whether they have enough product to sell. The number is built in JavaScript by combining four separately-fetched queries. If any of those queries times out, returns partial data because of an RLS quirk, or if the formula in the page diverges from the formula in the database, **a sales rep will quote (or commit) inventory the company does not actually have, or refuse to quote inventory it does have**. INVENTORY_RULES.md `:88` says explicitly: *"All inventory math happens in the database, NOT in React."* This page violates that rule.

**Evidence.**
- Holds fetched separately: `src/pages/InventoryPage.tsx:174-178` (filtered by `is_active=true` and not-yet-expired)
- Open POs fetched separately: `src/pages/InventoryPage.tsx:180-183`
- Planned quote demand fetched separately: `src/pages/InventoryPage.tsx:185-189`
- Delivered YTD fetched separately: `src/pages/InventoryPage.tsx:195-199`
- Reduced into per-product maps in JS: `src/pages/InventoryPage.tsx:205-224`
- The actual Net Position arithmetic in the browser:
  ```ts
  const freeQty = onOrderQty + item.quantity_available - item.quantity_prebooked - plannedQty;
  ```
  `src/pages/InventoryPage.tsx:250`
- The "Planned" column also computed in JS at `:246` as `holds + planned-quote-items`.
- Per-row label in the UI says "Net Position" (`src/pages/InventoryPage.tsx:796`) but the help-tip on the tab says **"Net Free = Available − Prebooked − Planned Holds"** (`src/pages/InventoryPage.tsx:962`). The two are different formulas (Net Position adds On-Order; Net Free subtracts holds *and* prebooked from `available` only) and the page presents both under the same UI without explaining which is which.
- Note: there *is* an `RPC get_inventory_forecast` for the Forecast tab (`src/pages/InventoryPage.tsx:363`), so server-side aggregation is viable in this codebase — it just isn't being used for the main grid.

**Fix direction.**
1. Build a single RPC `get_inventory_position(p_location text DEFAULT 'Main Warehouse')` that returns one row per product with all of: `quantity_available`, `quantity_prebooked`, `quantity_on_order`, `holds_qty`, `planned_qty`, `delivered_ytd`, `net_free`, `net_position`, `is_low_stock`, `reorder_point`, `min_stock_level`, `current_cost`, `vendor`, `inventory_unit`. One round trip instead of 4 + 1 fallback for missing products.
2. Reuse that same RPC for the dashboard's "Inventory Position" widget, the Forecast tab's "Available" column, and the manual-hold warning at `:445`. One source of truth, one definition of "free."
3. Decide which name is canonical — Net Position or Net Free — and remove the other from the UI. Add a HelpTip that shows the formula in plain English.

**Likely files.** `supabase/migrations/<new>` (RPC), `src/pages/InventoryPage.tsx`, `src/lib/db.ts` types, `src/types/index.ts` (InventoryRow → InventoryPositionRow), `src/components/dashboard/*.tsx` if any other widget reads inventory, `docs/workflows/INVENTORY_RULES.md` (consolidate the two formula names).

---

### P4-2 — Two different "free / available" formulas on the same page

**Business risk.** Same as P4-1 but worse: the *user-facing* answer changes depending on which control they touch. Creating a manual hold consults one formula to decide whether to warn; the row's own column shows another. A user can read the column, see "12 free", then click Create Hold and be warned the inventory will go negative — because the hold validator is using `available − prebooked − holds` and the column is using `on_order + available − prebooked − planned`. Same product, same screen, different "free."

**Evidence.**
- Column formula: `freeQty = onOrderQty + item.quantity_available - item.quantity_prebooked - plannedQty;` (`src/pages/InventoryPage.tsx:250`)
- Hold-warning formula: uses `invItem.free_qty - qty` from above and warns if negative (`src/pages/InventoryPage.tsx:445-451`).
- HelpTip on the Inventory tab claims `Net Free = Available − Prebooked − Planned Holds` (`src/pages/InventoryPage.tsx:962`) — that is yet a third definition (no on-order, no planned-quote demand).

**Fix direction.** Consolidate as part of the P4-1 RPC. The data table should display the same number the hold-warning uses, and the HelpTip should match the actual formula used.

**Likely files.** Same as P4-1.

---

### P4-3 — Manual holds are inserted directly from the browser without server-side validation

**Business risk.** Two users creating holds at the same time, against the same product, can each pass the browser-side warning check and both succeed — the database has no guard against total holds exceeding `quantity_available`. The first INSERT does not lock anything. INVENTORY_RULES.md `:113` already calls this out: *"Concurrent hold creation can exceed available inventory — this is a known edge case to test."* It is more than a test edge — it is the only path for creating a hold and there is no server-side gate.

**Evidence.**
- Hold creation is a direct table insert, not an RPC: `src/pages/InventoryPage.tsx:454-462`.
- The "would this go negative" check happens in JS *before* the insert, with no transactional lock: `:444-451`.
- The warning is opt-in — clicking Create Hold a second time bypasses it: the comment at `:447-450` literally says *"Click Create Hold again to proceed anyway."*
- The release path *is* server-side and idempotent (`release_inventory_hold` RPC, `:479-483`) — so the asymmetry is unique to creation.

**Fix direction.**
1. Add `create_inventory_hold(p_product_id, p_customer_id, p_quantity, p_hold_type, p_expires_at, p_notes, p_performed_by, p_idempotency_key)` RPC. SECURITY DEFINER, `SET search_path = public, pg_temp`, `FOR UPDATE` lock on the inventory row, recompute `quantity_available − prebooked − sum(active_holds)` inside the transaction, RAISE EXCEPTION if would go negative *unless* the caller passes `p_force := true` AND is admin (matches the over-receive admin-override pattern from Phase 21 G2).
2. Front-end calls the RPC; the warning becomes a server-returned reason rather than a client guess.

**Likely files.** New migration adding the RPC, `src/pages/InventoryPage.tsx`, `docs/reference/rpc-functions.md`, `docs/workflows/INVENTORY_RULES.md`.

---

### P4-4 — Returns lifecycle has 4 places where idempotency is broken or absent

**Business risk.** Returns adjust money (credit memo) and physical stock (restock). If a user double-clicks "Issue Credit", or if a network retry replays the request, the system can issue two credit memos against AR for the same return, or restock a return twice. The `useIdempotencyKey` hook on the Returns page is *partially* protective (it generates a fresh key only after success), but the database does not enforce it.

**Evidence.**

1. `issue_return_credit` accepts `p_idempotency_key` but its body never calls `check_idempotency` and never inserts into `idempotency_keys`. Confirmed by reading the function source: `supabase/migrations/20260316100002_return_credit_ar_integration.sql:107-280`. The parameter is declared but unused.

2. `approve_return` and `receive_return` were re-created by the dynamic consolidation in `supabase/migrations/20260331600000_consolidate_all_rpc_overloads.sql` Part 2 (the `pg_get_functiondef()` + regex injection block at `:408-501`). That code injects the parameter into the signature but does not insert the body logic. The migration's own algorithm comment at `:454-459` acknowledges this: *"Stale injection: has idem param but no `check_idempotency` logic — Use only if nothing better available."* For `approve_return` (originally `void`-returning, no idem in original Phase 6 body — `supabase/migrations/20260213180000_phase6_returns_rma.sql:135-156`), there is no "explicit_idem" version to find, so the stale-idem path is what production now has.
   - **Note.** Worth confirming against the live database via `pg_proc` — the on-disk migration text is what I read; the runtime function definition could differ if a later migration consolidated again. The phase-0 audit already flagged that distinct-RPC counting from migration text is unreliable.

3. `Returns.tsx` reject and cancel are bare `.update()` calls — no RPC, no idempotency, no FOR UPDATE:
   - reject: `src/pages/Returns.tsx:306-310`
   - cancel: `src/pages/Returns.tsx:335-339`
   They use `checkMutationResult` so a silent RLS failure is caught, but a double-click still produces two activity-feed entries and two state transitions in the audit trail.

4. `useIdempotencyKey('issue_return_credit', ...)` is wired on the front end (`src/pages/Returns.tsx:64`, `:386`) but on the server side the parameter does nothing — the front end's defense is operating in the dark.

**Fix direction.**
1. Replace `approve_return`, `receive_return`, `issue_return_credit` with hand-written RPCs that have proper `check_idempotency` + `save_idempotency` calls in the body. **Do not** use dynamic injection — that is precisely the anti-pattern called out in `SAFE_DEVELOPMENT_RULES.md:97-108`.
2. Add a `cancel_return(p_return_id, p_reason, p_performed_by, p_idempotency_key)` RPC that *also* reverses the inventory restock if the return is in `received` status (see P4-5 below).
3. Add a `reject_return(p_return_id, p_reason, p_performed_by, p_idempotency_key)` RPC for symmetry.

**Likely files.** New migration consolidating returns RPCs, `src/pages/Returns.tsx`, `docs/reference/rpc-functions.md`.

---

### P4-5 — Cancelling a `received` return leaves stock added back, but the return is "cancelled"

**Business risk.** A return that was received (and inventory restocked) can still be cancelled via the front-end (`src/pages/Returns.tsx:328-339` allows status `received` in the cancellable list). The bare `.update()` flips `status` to `'cancelled'` but does NOT remove the units that were just added to inventory by `receive_return`. The result: physical product was supposed to be returned but maybe never came back, or did come back and went somewhere else, and the system shows it on hand. Books drift.

**Evidence.**
- `cancellableStatuses = ['requested', 'approved', 'received']` (`src/pages/Returns.tsx:328`)
- The cancel handler is just `.update({ status: 'cancelled' })` (`:335-339`).
- `receive_return` body restocks inventory and inserts a `'returned'` `inventory_transactions` row (`supabase/migrations/20260331600000_consolidate_all_rpc_overloads.sql:271-336`). Nothing reverses it on cancel.
- For comparison: `cancel_delivery` correctly reverses inventory when cancelling a `completed` delivery (`supabase/migrations/20260331900000_fix_cancel_delivery_prebooked_release.sql:92-125`). The Returns surface is missing the same logic.

**Fix direction.**
1. Restrict the front-end to allow cancel only on `requested` or `approved` returns (i.e. before receive). For `received`, surface an "Undo Receive" admin-only action that calls a dedicated `reverse_received_return` RPC which inserts a `'returned'` transaction with negative qty (or ideally a new `returned_reversal` transaction type, after expanding the CHECK), zeroes `restocked` flags, drops `quantity_available` back, and flips status back to `approved`.
2. Then cancel from `approved` is a clean state transition with no inventory side effects.

**Likely files.** Migration expanding the inventory_transactions CHECK to include `returned_reversal`, new RPC for reverse-received, `src/pages/Returns.tsx`.

---

### P4-6 — Negative inventory is allowed everywhere with no guardrail

**Business risk.** The `chk_inventory_qty_available` CHECK constraint was deliberately removed (`supabase/migrations/20260333800000_drop_inventory_qty_available_check.sql`) so that drivers can complete a delivery even if the system shows zero stock — that is the right call for *that* RPC. But the constraint removal is *global*, and there is no UI-level guard that warns when *any* path (manual adjust, delivery, batch adjust, manual hold) would push a row below zero. As of Sprint G3+G4 there were 17 production rows with negative `quantity_available`. The integrity-cleanup page at `/integrity-cleanup` exists to drain those, but nothing prevents new negatives from arriving.

**Evidence.**
- CHECK dropped: migration `20260333800000_drop_inventory_qty_available_check.sql:20`.
- `complete_delivery` notifies admins and writes to activity feed when delivery causes negative inventory (`supabase/migrations/20260319200000_complete_delivery_remove_inventory_block.sql:122-127, :191-214`) — that is the *only* current early-warning path.
- The 17-row state and the deferred Phase 23 plan are documented in `docs/CHANGELOG.md:113, :120`.
- `complete_delivery` will create a fresh inventory row with negative qty if no row exists for the product (`:128-136`). That is the most surprising path: a product the warehouse never tracked is now in inventory, at -X.

**Fix direction.**
1. Once `/integrity-cleanup` drains the 17 rows to zero, ship the deferred Phase 23 migration: `CHECK (quantity_available >= 0 OR <admin override flag>)`. Pair it with a per-product flag `allow_negative` on `products` (default false) so that the rare bulk-product where physical-vs-system differences are routine has a documented escape hatch.
2. Add a notification at the moment of *every* path that could produce negative inventory: manual adjust, batch adjust, scheduled-delivery confirm preview. Right now only `complete_delivery` flags it.

**Likely files.** Migration adding the CHECK + admin-override flag, `src/pages/InventoryPage.tsx` (Adjust modal warning), `src/components/inventory/BatchAdjustModal.tsx`, `src/pages/IntegrityCleanup.tsx` if any new state needs surfacing.

---

### P4-7 — `complete_delivery` creates inventory rows for products the warehouse never had

**Business risk.** When a driver completes a delivery for a product that has *no* `inventory` row (perhaps a one-off direct-ship or a product retired before this delivery was scheduled), the function inserts a fresh row with `quantity_available = -<delivered qty>` (`supabase/migrations/20260319200000_complete_delivery_remove_inventory_block.sql:128-136`). That phantom row will now appear on the Inventory page. Mason will see "Why is this product showing up at -3?" with no obvious explanation.

**Evidence.**
- `IF FOUND ... ELSE INSERT INTO inventory ... -v_qty_to_deliver` at `complete_delivery_remove_inventory_block.sql:128-136`.
- The inventory page hides products where `is_active=false` on the product (`InventoryPage.tsx:172`) but does not hide rows with negative qty — they get rendered with red Net Position (`:705-707`).

**Fix direction.** Two options:
- Be explicit: when `complete_delivery` has to manufacture an inventory row from nothing, set `location = 'AUTO-CREATED'` or add a `manufactured_at_delivery boolean` column so the integrity-cleanup page can highlight "this row was manufactured because a delivery completed without prior stock — verify and reconcile."
- Or, less invasively, raise a higher-priority notification specifically for the "no prior record" branch (the current code lumps both negative-from-existing and manufactured-row into the same notification).

**Likely files.** New migration on `complete_delivery`, `src/pages/IntegrityCleanup.tsx`.

---

### P4-8 — Inventory grid does not warn when a manual adjust would cross zero

**Business risk.** The Adjust Inventory modal (`InventoryPage.tsx:1497-1517`) accepts a positive or negative number with no preview of the resulting `quantity_available`. A user typing `-50` against a product with 30 on hand will silently produce `-20` on the floor, and the only signal is the post-hoc admin notification (which `adjust_inventory` likely fires through the standard inventory-warning path — not verified end-to-end here).

**Evidence.**
- The modal has a single "Adjustment Quantity (+ or -)" Input and a Note field. No live preview of the resulting on-hand. (`src/pages/InventoryPage.tsx:1499-1511`)
- The existing manual-hold warning at `:445` shows the right pattern. The Adjust modal should mirror it.

**Fix direction.** Add a live "After this adjustment: X units" line in the modal, and a yellow warning band when the result would go below zero.

**Likely files.** `src/pages/InventoryPage.tsx`, `src/components/inventory/BatchAdjustModal.tsx` for symmetry.

---

### P4-9 — `cancel_order` releases prebooked but `release_holds_on_quote_status_change` doubles-up the safety net

**Business risk.** Low-probability but real: if an order is cancelled *and* the originating quote is independently flipped to `declined`, both `cancel_order` (`supabase/migrations/20260332000000_fix_void_delivery_batch_cancel_prebooked.sql:268-540` final form) and the trigger `release_holds_on_quote_status_change` (`supabase/migrations/20260316100001_inventory_hold_restoration.sql:34-91`) will each add `quantity_available` back. Both check `is_active = true` before acting and `cancel_order` flips `is_active = false` itself, so the trigger should be a no-op when fired second — but if the trigger fires *first* (quote status changed before order cancel), and the holds get deactivated before `cancel_order` runs, `cancel_order` will skip the restore branch (its WHERE filters on `is_active = true`) but will still also run `cancelled_order_release` … wait, actually that path is fine. Reading the latest body, this is OK. **Listed here for completeness as a "verify with a test" finding.**

**Evidence.**
- `cancel_order` filters `WHERE source_id = v_order.quote_id AND is_active = true` before restoring (`:388-405` in 20260332000000).
- Trigger `release_holds_on_quote_status_change` filters the same way.
- Both deactivate after restore. Sequencing should not matter, but a serial test case is worth writing once in `tests/e2e/`.

**Fix direction.** Add an E2E test: create quote (planned), accept-then-cancel-order vs decline-quote-without-converting. Confirm `quantity_available` ends at the same number in both paths. No code change suspected.

**Likely files.** New `tests/e2e/holds-cleanup-paths.spec.ts`.

---

### P4-10 — `complete_delivery` does not check the period-open status

**Business risk.** Other money-touching RPCs call `check_period_open()` before committing (`post_invoice`, `record_invoice_payment`, `issue_return_credit`). `complete_delivery` does not — yet completing a delivery in a closed period is a backdated transaction in spirit (it produces inventory movement, sometimes auto-creates an invoice under Phase 15). After month-end is closed, a driver who marks an old delivery as complete will write inventory transactions dated today but will trigger Phase-15 invoice auto-creation that *should* go through the period gate.

**Evidence.**
- `complete_delivery` body (`supabase/migrations/20260319200000_complete_delivery_remove_inventory_block.sql:46-240`) — no `check_period_open` call.
- `void_delivery` similarly does not check (`supabase/migrations/20260332300000_fix_void_delivery_three_bugs.sql:40-197`). Voiding a delivery reverses inventory and auto-voids draft invoices — equally a backdated ops change.
- Compare to `post_invoice` (skim of any `post_invoice` migration) which does call `check_period_open`.

**Fix direction.** Decide policy with Mason. Probably: completing/voiding a delivery whose `delivery_date` falls in a closed period should require admin override. Inventory movement always logs to today's date (current behavior is correct), but the lifecycle transition should respect the period gate.

**Likely files.** New migration updating `complete_delivery` and `void_delivery` to call `check_period_open(p_delivery_date)` (with admin-override flag).

---

### P4-11 — InventoryPage's missing-product fallback can mask retired products with open POs

**Business risk.** When a product has no `inventory` row but has open PO items, `InventoryPage.tsx` synthesizes a "virtual row" with `id: 'virtual-<product_id>'` (`:302-318`) and shows it in the grid. Combined with the `is_active = false` filter at `:172`, a *retired* product with an open PO will be filtered out of the grid entirely — both before and after the virtual-row pass — because the virtual-row pass only synthesizes for products in `missingProducts`, which were fetched without an `is_active` filter. Net effect: an open PO on a deactivated product becomes invisible on the Inventory page. The PO itself is still visible on `/purchase-orders`, but anyone who works "from the inventory side first" will never see this orphan.

**Evidence.**
- `is_active=false` exclusion at `src/pages/InventoryPage.tsx:172`.
- `missingProducts` fetch does not filter by `is_active`: `:233-239`. So inactive products *can* be synthesized as virtual rows.
- But the `inventoryProductIds` at `:226` is built from `rawRows`, which already excluded inactive — so a retired product that *also* has an inventory row gets dropped at `:172` and never synthesized.

**Fix direction.** Either show retired products with a "Retired — has open PO" badge, or refuse to let a PO line item reference a retired product (server-side check on `save_purchase_order`).

**Likely files.** `src/pages/InventoryPage.tsx`, possibly a server-side guard in the PO save RPC.

---

### P4-12 — Cycle counts: ledger drift fix in place, but cycle count "cancel" is a bare `.update()`

**Business risk.** The Phase-17/18 fix (`supabase/migrations/20260333000000_fix_reverse_cycle_count_search_path_and_idempotency.sql`) correctly added `pg_temp` and idempotency to `reverse_completed_cycle_count`. Good. However, `CycleCounts.tsx:326-329` cancels an in-progress count via `supabase.rpc('cancel_cycle_count', ...)` — I did not verify the RPC body has idempotency. Also the front-end does not pass `p_idempotency_key` (`:326-329` shows only two args). If the RPC accepts one, the front-end is not using it.

**Evidence.**
- `cancel_cycle_count` call at `src/pages/CycleCounts.tsx:326-329` — no `p_idempotency_key`.
- Compare to `complete_cycle_count` at `:289-294` and `reverse_completed_cycle_count` at `:354-359` — both pass keys.

**Fix direction.** Verify `cancel_cycle_count` RPC body — if it lacks idempotency, fix server-side and pass key from the front end.

**Likely files.** Migration update on `cancel_cycle_count`, `src/pages/CycleCounts.tsx:326-329`.

---

### P4-13 — Receiving log lacks per-record reverse-button visibility for non-admin

**Business risk.** Lower-priority UX. A sales rep can receive (`canReceive` includes sales_rep at `PurchaseOrderDetail.tsx:102`) but `reverse_receiving_record` is admin-only. If a sales rep receives the wrong quantity or wrong condition, they cannot fix it themselves; they have to ping Mason. This is the right access policy but the UI does not surface "you need an admin to reverse this" — the button just isn't there. Worth verifying — I read PurchaseOrderDetail through line 270 only.

**Evidence.** `PurchaseOrderDetail.tsx:101-102` defines `isAdmin` and `canReceive`. The reverse-receiving modal state exists at `:96-99`. Did not read deep enough to confirm the button visibility.

**Fix direction.** Confirm the button is hidden for sales_rep, and add a tooltip "Ask an admin to reverse this receive."

**Likely files.** `src/pages/PurchaseOrderDetail.tsx` (the receiving-history table).

---

### P4-14 — `quick_receive` does not surface allocation conflicts cleanly

**Business risk.** `match_quick_receive_items` (`supabase/migrations/20260304200000_quick_receive.sql:15-160+`) has a `v_multiple_costs` flag for "this product has multiple open POs at different unit costs" — that scenario means the system cannot decide which PO to allocate against without user input. I did not read the front-end's handling of that flag end-to-end. If the UI silently picks the oldest PO when costs differ, the receiving cost (and thus cost_history) gets locked to whichever PO came first, even if the actual shipment was priced differently.

**Evidence.** `v_multiple_costs` computed at `quick_receive.sql:62`. Used somewhere later in the function (not read in full). `src/pages/QuickReceive.tsx` was sampled at `:270-310` only — did not confirm UX.

**Fix direction.** Verify QuickReceive shows a "multiple costs detected — confirm which PO" prompt before allocating. If it doesn't, that is a quiet bug.

**Likely files.** `src/pages/QuickReceive.tsx`.

---

## What's Already Working

These are correct and should be preserved:

1. **`complete_delivery` end-to-end logic.** Reads order_items, deducts both `quantity_available` and `quantity_prebooked` (with `LEAST` to avoid going negative on prebooked), creates remainders for partial deliveries, auto-adjusts draft invoices for partial qty, sets order status correctly, notifies admins on negative inventory. Logic is dense but it's right. (`20260319200000_complete_delivery_remove_inventory_block.sql`)

2. **`void_delivery` final form.** Three rounds of bug fixes converged on a correct version: restores both available AND prebooked, deletes remainders, re-evaluates order status with correct column references, voids draft invoices, flags posted invoices for manual review, sets `app.admin_override` to allow the reverse status transition through the state-machine trigger. (`20260332300000_fix_void_delivery_three_bugs.sql`)

3. **`cancel_delivery` prebooked semantics.** The fix for ORD-2026-0176 (`20260331900000`) correctly distinguishes "scheduled or in-progress cancel" (prebooked stays, because order is still active) vs "completed cancel" (prebooked re-incremented to match what `complete_delivery` deducted). Includes a one-time data fix for the 4 affected products.

4. **PO over-receive opt-in (Phase 21 G2).** `PurchaseOrderDetail.tsx:201-238` correctly computes whether any line would over-receive, blocks non-admin, and requires `allowOverReceive + overReceiveReason` for admin. The reason is appended to the per-item notes for the audit trail. `QuickReceive.tsx:286-291` correctly hard-codes `p_allow_over_receive: false` (the bulk path can't reasonably collect a per-line reason).

5. **Hold release on quote-status change.** `release_holds_on_quote_status_change` (`20260316100001`) restores `quantity_available` for declined/expired quotes but NOT for accepted (which would double-count with the conversion's prebook). Correct.

6. **`auto_expire_quotes` belt-and-suspenders.** Both the trigger and the cron job restore inventory before deactivating holds.

7. **`cancel_order` final form.** Releases prebooked using `'released'` transaction type with positive quantity (the `'cancelled_order_release'` string was abandoned correctly), looks up holds via `quote_id` not `order_id`, voids draft invoices, notifies on posted invoices, cancels active deliveries directly to avoid double prebook release. (`20260332000000`)

8. **Phase 22 cleanup tooling.** `/integrity-cleanup` page is the right place to drain the 17 negative rows + 15 over-received PO items + 60 unbilled deliveries. Each action is a dedicated RPC with idempotency.

9. **`inventory_transactions` CHECK is correct after `20260331700000`.** All eleven types in `INVENTORY_RULES.md:74-87` match. (Earlier migrations had drift on this; the current state is consistent.)

10. **`reconcile_negative_inventory` RPC exists** (per CHANGELOG `:90-93`) — admin-only, locks the row, paired `adjusted` transaction. Correct shape.

---

## Open Questions for Mason

1. **Negative inventory policy.** Once `/integrity-cleanup` drains to zero, do you want a hard `CHECK (quantity_available >= 0)` (Phase 23 plan), or per-product opt-in (`products.allow_negative`)? The latter is more flexible for bulk product where small-volume vs. big-tank counts mismatch routinely.

2. **"Net Position" vs "Net Free."** Which name should win? They are subtly different (Position adds On-Order; Free does not). Pick one, and we'll consolidate the page and the docs around it.

3. **Closed-period gate on delivery completion.** If a delivery is marked complete after month-end has closed, should the system block, warn, or quietly proceed? Current behavior: proceeds with no period check.

4. **Receive-then-cancel returns.** Should "received" be a cancellable state, or should we force "Undo Receive" (admin-only) before cancel? The cleaner workflow is the latter.

5. **Manual hold concurrency.** Are you OK with a server-side check that *blocks* a hold from making `(available − prebooked − holds)` go negative without an admin override, or do you want it to keep being a soft warning?

6. **Cycle count adjustments and period-open.** A cycle count completed today but for stock dated last month — should it count against last month's books or today's? Currently transactions are written with `now()`, but the cycle_count's `completed_at` is what shows on the audit trail.

7. **Auto-created inventory rows from delivery.** When `complete_delivery` invents a fresh inventory row at -X, do you want that to be flagged separately on the Integrity Cleanup page? Right now it is lumped in with all other negative rows.

---

## Recommended Fix Order (within Phase 4)

| Order | Item | Why first |
|---|---|---|
| 1 | **P4-4** Returns idempotency + cancel/reject RPCs | Money risk (double credit memo). Lowest blast radius — no schema change. |
| 2 | **P4-5** Reverse-received-return path | Fixes a clear inventory drift path. Same migration as #1. |
| 3 | **P4-3** `create_inventory_hold` RPC | Closes the concurrency window for manual holds. Independent migration. |
| 4 | **P4-1 + P4-2** `get_inventory_position` RPC + UI consolidation | Removes the browser-side math; collapses two formulas into one. |
| 5 | **P4-8** Live preview in adjust modals | UI-only; small win. |
| 6 | **P4-7 + P4-11 + P4-13** Edge-case visibility (auto-rows, retired products, sales-rep tooltips) | UX polish after correctness is back. |
| 7 | **P4-12** `cancel_cycle_count` idempotency check | Verify before fixing — may already be correct. |
| 8 | **P4-14** QuickReceive multi-cost UX verification | Verify before fixing. |
| 9 | **P4-9** Holds cleanup paths E2E test | Test only; no code. |
| 10 | **P4-10** Period-open gate on delivery complete/void | Policy decision needed first. |
| 11 | **P4-6** `CHECK (quantity_available >= 0)` (Phase 23) | Deferred until cleanup drains to zero. |

---

*End of Phase 4. The next phase (Phase 5) covers Customer 360, Fields, and Crop Programs — that audit lives in a separate file.*
