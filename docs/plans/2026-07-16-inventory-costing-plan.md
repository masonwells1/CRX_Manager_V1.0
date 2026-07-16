# True Inventory Costing (On-Hand Average Purchase Cost) — Scoped Plan

**Date:** 2026-07-16
**Status:** SCOPED — **PARKED until supplier-pricing Phases 1a/1b ship and stabilize.** No implementation authorized yet.
**Branch:** `claude/supplier-pricing-strategy-9c6129`
**Advisors:** Claude (grounding + synthesis) + Codex gpt-5.6 "Sol 5.6" at extra-high reasoning (design partner; its five disagreements are folded in)
**Companion plan:** `docs/plans/2026-07-16-supplier-pricing-and-variants-plan.md` (rev 5, in build)

---

## 1. The problem (Mason's ask)

"We don't have a way of tracking our average cost of product based off inventory." Verified true: `inventory`, `inventory_transactions`, and `receiving_records` carry **no cost columns**. The system knows what was paid per PO line but not what the stock on the shelf cost. This plan adds a **fourth price fact** alongside the supplier-pricing plan's three:

| # | Fact | Source |
|---|---|---|
| 1 | Replacement cost (supplier offers) | `supplier_price_observations` (in build) |
| 2 | Selected pricing basis | `products.current_cost` → `product_cost_basis` |
| 3 | Actual paid per purchase | `purchase_order_items` |
| **4** | **On-hand average purchase cost** (NEW) | **this engine** |

**Label honestly:** "on-hand average purchase cost" — NOT "true cost" (v1 has no freight/rebates/container/labor, and opening values are partly owner estimates). It never writes `products.current_cost` (the 2026-03-13 doctrine: pricing basis is an owner decision).

## 2. Verified current state — the warts the design must survive (grounded 2026-07-16)

- **Ledger is unsigned:** `inventory_transactions.quantity` is a magnitude; direction lives in `transaction_type`. Types actually inserted: received(+PO), delivered(−, delivery+order), returned(+, NO FK), adjusted(±), job_applied(− via complete_job with job_id, and via the blend-ticket path WITHOUT job_id), cancelled/void_delivery_reversal(+), prebooked/released/prebook_reconciliation (reservations, no physical movement). `booked`/`transferred` are dead enum values. `job_id` is null on 698/698 rows today.
- **No lot data:** `receiving_records.lot_number` 0/130 populated ever. The B1 lot-capture feature is trace-only; per-lot inventory math was explicitly deferred ("Wave C") — this plan is Wave C, and it deliberately does NOT do lots (see §3).
- **Negative stock is policy** (warn-not-block): 18 products negative now; deliveries/jobs seed phantom rows at negative qty (`manufactured_at_delivery` flag).
- **No unit conversion at receiving:** `receive_po_items` adds the caller's quantity as-is; PO `unit_cost` is implicitly assumed to be per inventory unit. (Consumption side DOES convert via `field_app_priced_quantity`.)
- **Returns defect:** `receive_return` restocks quantity with no cost; `issue_return_credit` reverses revenue but **never COGS** (credit memo has no cost lines). Confirmed defect independent of this project.
- **Custom-fill gap:** bulk and tote are separate product rows with NO repack/transfer event — filling totes from bulk has no data representation.
- **Cost data:** 194/194 PO lines have cost (100%), but the PO/receiving trail stops 2026-06-10 while consumption continues; 13/66 in-stock products have zero PO history (opening-balance gap).
- **A weighted-average auto-update existed and was deliberately removed** (2026-03-13) because it conflated purchase cost with pricing basis. This engine keeps them separate by construction.
- Sell-side margins/commissions all run on snapshots (`order_items.cost_per_unit` → `invoice_items.cost_cents`, U8 commissions) — this engine does NOT touch them in any phase of this plan.

## 3. Architecture (Sol 5.6-hardened)

**Perpetual moving weighted-average pool per product+location, value-in-cents, event-sourced, T0-forward, reporting-only.**

- **Pool math:** state = physical on-hand quantity `Q` + total on-hand purchase value `V` (integer cents). Displayed average = `V ÷ Q` when `Q > 0`, derived at read time. **Never store a rounded average as source of truth** (Sol disagreement #2 — repeated rounding drifts; decimal quantities make fractional-cent averages). Issues remove a proportional share of `V`; an issue that empties the pool removes every remaining cent (no stranded value). Receipts add their exact total receipt cost.
- **Event-sourced:** the physical ledger stays untouched and authoritative for quantity. A parallel append-only `inventory_cost_events` stream carries the money. State is a rebuildable projection — provably reconstructible from openings + events.
- **Companion-event rule (Sol disagreement #3 — "no write-path changes" was unsafe):** every inventory-mutating RPC (receive_po_items, complete_delivery, cancel/void_delivery, receive_return, adjust/retire/reconcile/cycle-count, complete_job, blend-ticket application, manual add) inserts its cost event **in the same transaction** as its ledger row, passing the source facts it already holds (PO line, order line, delivery, reversal target). A **deferred constraint/guard rejects any cost-relevant ledger insert that commits without a matching cost event** — no future write path can silently starve the engine. React UI flows stay unchanged; only RPC bodies gain the companion call.
- **T0-forward only:** no reconstruction of the 698 historical rows (pre-T0 history is too broken: note-only corrections, missing FKs, no purchase trail after June 10). Valuation begins at an owner-approved opening (§5).

### Negative-stock policy (Sol disagreement #1)
Plain-English rule: *"While stock is negative, cost is provisional. Receipts first repair the deficit. A real on-hand average resumes only when stock becomes positive."*
- Issue driving stock negative: uses last valid average as provisional cost; if none ever existed → unresolved event (never silent $0).
- Receipt while negative: covers the deficit first (that part creates no on-hand value; provisional-vs-actual difference recorded as `negative_variance_cents`); only the remainder above zero establishes new value + average. Receipt leaving qty ≤ 0 → still no displayed average.
- Events process in **posting order**; late-posted receipts get flagged (`posted_late`), may create variance, never silently rewrite history.

### Per-event costing policies
| Ledger situation | Cost event policy |
|---|---|
| `received` | Attach exact PO line + receiving record + conversion snapshot; add exact receipt total cents |
| `delivered` / `job_applied` (both paths) | Remove value at current moving average; carry source IDs the RPC already knows |
| Customer return (post-T0) | Restore the cost the engine originally assigned when those goods left — **NOT** `order_items.cost_per_unit` (Sol disagreement #4: that's a pricing snapshot, not inventory cost) |
| Pre-T0 return | Fall back to `cost_at_time_cents`/invoice cost, marked **estimated** |
| Return cancellation | Reverse the exact preceding return event |
| Negative adjustment/shrink | Remove at current average; structured reason required (count loss / damage / shrink / correction) |
| Positive count adjustment | Add at pool average, marked **estimated**; no average exists → explicit admin cost or confirmed pricing-basis fallback |
| Delivery cancel/void reversal | Restore the exact cents the original delivery event removed |
| Receiving reversal | Reverse the exact receipt event (not shrink) |
| Phantom negative seed | Outbound with provisional/unresolved cost; product stays "needs review" until reconciled |
| Reservations (prebooked/released/reconciliation) | No cost event (no physical movement) |
| `booked`/`transferred` | Unsupported in v1 (dead values); future transfers = paired same-cost out/in events |

## 4. Confidence model (replaces naive "stale PO date" nagging)

Per product: **Confirmed** (every remaining cent from linked receipts/exact reversals) / **Estimated** (some value from opening declaration, pricing-basis fallback, pre-T0 return, count gain — tracked as `estimated_value_cents`, removed proportionally on issues) / **Needs review** (negative stock, missing conversion, unresolved cost, unpaired event, state mismatch) / **No stock**. Display: last actual receipt date, last owner confirmation, late-posting count, % of value from actual linked costs. Green stays quiet; yellow/red in one exception list; cost prompts only at actions that create unpriced value.

## 5. Opening valuation (T0) — reuses Phase 1a worksheet machinery, separate workflow

Dedicated **Inventory Valuation Opening** workbook (not the pricing worksheet; same parser/validation/row_version/preview/change-set machinery): frozen export of every inventory row (positive AND negative); suggested cost = most recent **received** PO cost after conversion, else `current_cost` labeled "pricing-basis estimate"; Mason confirms every nonzero row; the 13 no-PO-history products require explicit values; negative products collect a **provisional deficit cost** (not on-hand value). Apply is atomic; any quantity drift since export rejects the workbook (re-export). Same transaction: write `inventory_cost_openings`, initialize state, activate costing at exact T0. Opening values stay marked "owner-established."

## 6. Unit conversion (feeds BACK into supplier-pricing 1b — the one cross-dependency)

- Field is **directional**: `inventory_units_per_supplier_unit` on `product_supplier_links` (Sol: generic "conversion_factor" is too ambiguous for money). Example: 1 tote × 265 = 265 gal.
- Future PO lines **snapshot** (not re-read): link id, supplier unit, inventory unit, the conversion, supplier qty, supplier unit cost cents, exact receipt total cents, normalized inventory quantity. At receipt: inventory qty = supplier qty × conversion; pool receives exact receipt cents.
- Receiving with mismatched units must not finalize without an approved conversion or explicit admin confirmation.
- **Action taken now:** the supplier-pricing plan/handoff is amended so 1b builds the directional field + PO-line snapshot columns — cheap there, expensive rework later.

## 7. Custom-fill / repack (Phase C4 — not silently parked)

Sol disagreement #5: custom-fill rows can't quietly show averages. Until a bulk→tote relationship exists, affected rows display **"Not valued — bulk/custom-fill movement is not recorded."** Minimal design when built: one idempotent `record_inventory_repack(source_product, destination_product, source_qty, destination_qty, location, reason)` RPC — locks both states in stable order, two ledger rows + two correlated cost events, moves exact cents bulk→tote, preserves estimated/confirmed composition, creates no P&L. No container/labor/yield allocation in v1.

## 8. Returns-COGS defect — separate financial lane (NOT this project)

`issue_return_credit` reversing revenue but never COGS corrupts margins today, engine or no engine. Fix separately, prospectively, using the **existing snapshot basis** (mixing the new average into sell-side math would create a mixed accounting basis); historical backfill only after a read-only impact report and Mason's approval. The costing engine independently restores returned inventory at original issue cost regardless.

## 9. Minimal schema (integer cents throughout; full RLS)

- **`inventory_cost_openings`** (immutable): change_set_id, product_id, location, opening_quantity, opening_inventory_value_cents, basis_quantity + basis_value_cents (preserves ratio without fractional cents), source_type, source_purchase_order_item_id, source_as_of, confidence_class, notes, confirmed_by/at.
- **`inventory_cost_events`** (append-only): posting_sequence, product_id, location, inventory_transaction_id (UNIQUE when non-null), event_type, quantity delta/before/after, value delta/before/after cents, estimated_value_delta_cents, assigned_cost_cents, negative_variance_cents, cost_status, source FKs (po_item, receiving_record, return_item, order_item), source/reverses_cost_event_id, correlation_id, effective_at, posted_at, performed_by, notes.
- **`inventory_cost_state`** (rebuildable projection): on_hand_quantity, inventory_value_cents, estimated_value_cents, negative_provisional_value_cents, unresolved_quantity, last_known_basis qty/value, last_event_id, last_actual_receipt_at, late_posting_count, row_version.
- **Security:** RLS on all; no anon; no client DML policies; append-only triggers reject UPDATE/DELETE; costing function private (non-exposed schema or fully revoked); read via admin-role RPC; views `security_invoker = true`.

### UI (Phase C3)
Product page shows the four separated facts (replacement cost / pricing basis / last paid / on-hand average + qty + value + confidence). Negative stock shows "On-hand average unavailable — provisional / needs review." The existing inventory report keeps its number renamed **"Pricing-basis valuation"**; a new **"On-hand purchase-cost valuation"** report sits beside it (never silently change an existing report's meaning).

## 10. Phases (build only after supplier-pricing 1a/1b are live and stable)

- **Gate 0 (now, inside 1b):** directional conversion field + PO-line snapshot columns (§6).
- **C1 — Dark costing foundation:** tables, private cents-pool engine, negative-stock variance, companion events in every active writer RPC, deferred completeness guard, append-only/concurrency/replay/rebuild verification. No UI. **Proof: state reconstructs exactly from openings+events.**
- **C2 — Opening & activation:** frozen valuation workbook → resolve every row → atomic apply → activate at T0 → reconcile every state row to `inventory.quantity_available`; feature stays hidden if any product mismatches unexplained.
- **C3 — Reporting-only UI:** product-page facts, read-only worksheet columns, on-hand valuation report, confidence/exception surfaces. Zero order/invoice/commission/pricing changes.
- **C4 — Custom-fill coverage:** classify variant rows (virtual-from-bulk vs physically stocked), minimal repack RPC, un-exclude those rows only after real-path verification.
- **Separate lane (any time, own review):** returns-COGS prospective fix (§8).

## 11. Explicitly NOT building

FIFO/LIFO/lot depletion; lot-level remaining quantities; pre-T0 reconstruction; retroactive re-costing; automatic writes to `products.current_cost`; margin/invoice/commission/tax changes; GL journal posting; freight/rebate/container/labor landed costs; manufacturing/BOM/yield; multi-warehouse transfer costing (one location exists); AI/OCR; editing historical ledger rows; silent historical return-COGS backfills.

## 12. Owner decisions (when this un-parks)

1. **Green-light C1–C3** after supplier-pricing 1a/1b prove stable (recommended sequencing: yes).
2. **T0 date + the opening workbook session** — Mason personally confirms every opening cost (the engine's honesty depends on it).
3. **Custom-fill classification** — for each tote-variant row: is it physically stocked or filled-from-bulk on demand? (Determines C4 treatment; pairs naturally with the Phase 3 families work.)
4. **Returns-COGS fix** — approve as its own small project (recommended: yes, soon — it distorts margins today).
5. **PO discipline commitment** — the engine only stays "Confirmed" if purchases actually flow through POs + receiving (trail currently stops 2026-06-10). This is a workflow habit, not software.

## 13. Advisory record

Sol 5.6 (xhigh) final verdict: *"Your core direction is right: moving average, T0-forward, derived layer, reporting-only."* Its five loud disagreements (negative-stock rule incomplete; don't store rounded averages; companion events required in write paths; returns must not re-enter at sell-side snapshot cost; custom-fill can't quietly participate) are all folded in above, plus the confidence model, directional conversion naming, openings workbook design, and the safe-vs-unsafe framing: the safe version is an append-only, transactionally maintained purchase-cost projection initialized by an owner-confirmed opening valuation with explicit variance and confidence labeling; the unsafe version is a rounded average reconstructed asynchronously from ambiguous ledger rows and presented as "true."
