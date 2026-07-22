# CRX Live Foundation Gauntlet - Section 3 Refresh

Date: 2026-07-22
Section: Inventory, holds, prebooks, Net Free, quote draw-down, deliveries, receiving
Mode: Read-only audit of current repo code plus live Supabase database structure

## Verdict

Section 3 is mostly structurally sound at the database boundary: the audited inventory, hold, delivery, and receiving RPCs each have one live overload, fixed `search_path = public, pg_temp`, active-user role gates, and no anonymous execution except the self-gated read helper noted below. The main production risk is a remaining browser direct-write path that can change `inventory.location` without a stock-transfer transaction. A second UI-only drift can understate Net Position after legitimate PO over-receives because some product pickers rebuild the inventory formula instead of using `get_inventory_position()`.

Existing checkout state at run start: `## docs/port-missing-docs-to-main...origin/docs/port-missing-docs-to-main [gone]`; no uncommitted files were listed by `git status --short --branch`.

Live-catalog limitation: local `supabase db query --linked` failed before connection with `failed to read profile: Unsupported Config Type ""`, but the Supabase MCP connector was available and used for SELECT-only catalog reads against project `rhyzpcqhnizqbxphqdkr`. One row-count probe was run while exploring, but no row-level data finding is included because this automation scope is live structure only.

## Counts

| Severity | Count |
|---|---:|
| BLOCKER | 0 |
| HIGH | 1 |
| MED | 1 |
| LOW | 1 |

## Findings

### HIGH - Inline inventory location edits bypass the transfer ledger

Evidence:

- [InventoryPage.tsx](C:/CRX_Manager/src/pages/InventoryPage.tsx:847) marks the `location` column editable for admins.
- [InventoryPage.tsx](C:/CRX_Manager/src/pages/InventoryPage.tsx:711) saves inline changes with a direct `supabase.from('inventory').update(...)`.
- [INVENTORY_RULES.md](C:/CRX_Manager/docs/workflows/INVENTORY_RULES.md:75) says every inventory change creates an `inventory_transactions` record; [INVENTORY_RULES.md](C:/CRX_Manager/docs/workflows/INVENTORY_RULES.md:84) defines `transferred` as the ledger type for stock moved between warehouses.
- Live catalog: `pg_policies` shows `inventory_update` allows authenticated admins to update `inventory` directly with `qual = is_admin()` / `with_check = is_admin()`.
- Live catalog: triggers on `inventory` include only `trg_inventory_significant_change`, which fires when `quantity_available` changes. No live trigger records or blocks `location` updates.

Business risk: changing an inventory row from `Main Warehouse` to another location moves all on-hand/prebooked/on-order quantities in the system's warehouse view without a paired transfer ledger row. That can make deliveries and receiving screens show stock in the wrong place and destroys the audit trail for where product moved.

Suggested fix: remove `location` from the generic inline edit path, or replace it with a `transfer_inventory_location(...)` RPC that locks the source row, validates target warehouse, writes paired `inventory_transactions` rows of type `transferred`, and returns an idempotent result. Consider a database trigger that blocks direct `inventory.location` changes while `quantity_available`, `quantity_prebooked`, or `quantity_on_order` is nonzero unless an internal RPC sets a scoped override.

Prevention: add a SQL invariant/guard test that fails if application code updates `inventory.location` through PostgREST, and add a live trigger/policy sweep that confirms stock-location moves can only happen through the transfer RPC.

### MED - Product pickers rebuild Net Position without the server clamp for over-received POs

Evidence:

- [INVENTORY_RULES.md](C:/CRX_Manager/docs/workflows/INVENTORY_RULES.md:37) says order-creation warnings read the canonical Net Position from `get_inventory_position()`, and [INVENTORY_RULES.md](C:/CRX_Manager/docs/workflows/INVENTORY_RULES.md:123) says consumers should call that RPC instead of adding a parallel aggregation.
- [NewOrder.tsx](C:/CRX_Manager/src/pages/NewOrder.tsx:173) reads raw `inventory`, [NewOrder.tsx](C:/CRX_Manager/src/pages/NewOrder.tsx:175) reads raw `purchase_order_items`, and [NewOrder.tsx](C:/CRX_Manager/src/pages/NewOrder.tsx:1028) displays `inv.onOrder + inv.available - inv.prebooked`.
- [QuickDeliveryModal.tsx](C:/CRX_Manager/src/components/deliveries/QuickDeliveryModal.tsx:126) reads raw `inventory`, [QuickDeliveryModal.tsx](C:/CRX_Manager/src/components/deliveries/QuickDeliveryModal.tsx:128) reads raw `purchase_order_items`, and [QuickDeliveryModal.tsx](C:/CRX_Manager/src/components/deliveries/QuickDeliveryModal.tsx:693) displays the same local formula.
- [OrderDetail.tsx](C:/CRX_Manager/src/pages/OrderDetail.tsx:292) reads raw products/inventory/PO rows for edit mode, [OrderDetail.tsx](C:/CRX_Manager/src/pages/OrderDetail.tsx:313) sums `quantity_ordered - quantity_received`, and [OrderDetail.tsx](C:/CRX_Manager/src/pages/OrderDetail.tsx:2054) displays the local Net Position formula.
- [20260716120120_gauntlet_inventory_accuracy.sql](C:/CRX_Manager/supabase/migrations/20260716120120_gauntlet_inventory_accuracy.sql:47) defines the canonical live `get_inventory_position()` `on_order` CTE as `SUM(GREATEST(quantity_ordered - quantity_received, 0))`.
- [20260714230000_gauntlet_core_guards.sql](C:/CRX_Manager/supabase/migrations/20260714230000_gauntlet_core_guards.sql:184) allows over-receive only through explicit admin override/reason, so `quantity_received > quantity_ordered` is a legitimate represented state.

Business risk: after an approved over-receive, the server clamps remaining PO quantity at zero, but these React product pickers subtract the overage from Net Position. That can show false short-stock/low-net warnings and push operators away from using product that the canonical inventory RPC would show as available. This appears UI-only because the write RPCs still do their own checks/warnings.

Suggested fix: have product pickers call `get_inventory_position()` for stock preview data, or centralize a shared frontend read helper that exactly mirrors the RPC, including `GREATEST(ordered - received, 0)`.

Prevention: add a regression test fixture with `quantity_received > quantity_ordered` proving product picker Net Position matches `get_inventory_position()` semantics.

### LOW - Quick-receive matcher remains anon-executable despite an in-body gate

Evidence:

- Live catalog: `match_quick_receive_items(jsonb, text)` has one overload, `SECURITY DEFINER`, `search_path = public, pg_temp`, `has_function_privilege('anon', oid, 'EXECUTE') = true`, and `has_function_privilege('authenticated', oid, 'EXECUTE') = true`.
- Live function body: `match_quick_receive_items` immediately checks `profiles.id = auth.uid()` with active `role IN ('admin', 'sales_rep')` before it reads open PO/vendor/cost rows.
- [QuickReceivePanel.tsx](C:/CRX_Manager/src/components/receiving/QuickReceivePanel.tsx:191) is the browser caller and uses `assertRpcResult()` on the result at [QuickReceivePanel.tsx](C:/CRX_Manager/src/components/receiving/QuickReceivePanel.tsx:196).

Business risk: this is not a proven anonymous data leak because `auth.uid()` is null for anon and the in-body gate raises. It is still unnecessary exposure on a SECURITY DEFINER function that returns purchase order numbers, vendors, costs, and allocation candidates to authorized callers.

Suggested fix: revoke `EXECUTE` on `match_quick_receive_items(jsonb,text)` from `PUBLIC` and `anon`; grant only to `authenticated` and `service_role`.

Prevention: extend the live grant sweep for Section 3 RPCs so inventory/receiving SECURITY DEFINER helpers cannot be anon-executable unless they are explicitly documented as public-safe.

## Verified Safe

- Live catalog shows exactly one overload for the audited RPCs: `adjust_inventory`, `cancel_delivery`, `complete_delivery`, `confirm_delivery`, `convert_quote_to_order`, `create_delivery_with_items`, `create_direct_order`, `create_inventory_hold`, `create_planned_holds`, `create_quick_delivery`, `create_rush_order`, `get_inventory_forecast`, `get_inventory_position`, `manual_inventory_add`, `match_quick_receive_items`, `receive_po_items`, `reconcile_negative_inventory`, `release_inventory_hold`, `retire_inventory_item`, `reverse_receiving_record`, `save_quote`, and `void_delivery`.
- Live catalog shows fixed `search_path = public, pg_temp` for those SECURITY DEFINER functions.
- Live catalog shows no anonymous execution for the mutating Section 3 RPCs checked; the only anon-executable audited function was `match_quick_receive_items`, which self-gates before reading PO data.
- [20260714230000_gauntlet_core_guards.sql](C:/CRX_Manager/supabase/migrations/20260714230000_gauntlet_core_guards.sql:112) shows `receive_po_items` is actor-bound, active admin/sales gated, idempotent, row-locks the PO item and parent PO, rejects nonpositive quantities, and writes `inventory_transactions` plus `receiving_records`.
- [NewDelivery.tsx](C:/CRX_Manager/src/pages/NewDelivery.tsx:410) schedules deliveries through `create_delivery_with_items` instead of separate delivery/item inserts, and passes the idempotency key at [NewDelivery.tsx](C:/CRX_Manager/src/pages/NewDelivery.tsx:426).
- [QuoteBuilder.tsx](C:/CRX_Manager/src/pages/QuoteBuilder.tsx:1205) creates planned holds through `create_planned_holds`, while [QuoteBuilder.tsx](C:/CRX_Manager/src/pages/QuoteBuilder.tsx:1218) notes unplanning is synchronized by `save_quote` rather than direct table mutation.

## Next Section

Section 4 is queued next: Quote to order to delivery to invoice to payment lifecycle wiring.
