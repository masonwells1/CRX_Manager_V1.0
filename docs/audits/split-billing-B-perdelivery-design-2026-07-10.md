# Design — Feature B: per-delivery split billing for partially-delivered allocated orders

**Status:** DESIGN-FIRST (design-review-first sub-protocol). Written 2026-07-10 in the billing-day money loop follow-on (owner: "do both" — A shipped, B is the major redesign). **No code until Codex adversarially reviews this design.**

## Problem (the U7-deferred "larger redesign")
Today, a field/acre-allocated (landlord/tenant) order can only be **split-billed for the whole order at once**: `create_split_invoices_from_order` bills off `order_items.total_price` and explicitly **blocks the partial-delivery-in-progress case** (`20260707090000` lines 106-109: "Order is partially delivered — split invoicing bills the whole order and would bill undelivered product"). Feature A (shipped) auto-creates the whole-order split only when the order becomes **fully** delivered. So an allocated order delivered in **multiple partial shipments** cannot bill each shipment as it goes — the landlord/tenant invoices wait until everything is delivered.

**B's goal:** each completed **partial** delivery of an allocated order bills **its own delivered quantities**, split per owner by acre, penny-exact, tagged to that delivery — and the sum across all deliveries must exactly equal the whole-order split (no double-bill, no drift).

## Verified live-schema facts (2026-07-10)
- `delivery_items(id, delivery_id, order_item_id, product_id, quantity, unit_size, quantity_delivered, tote_number, …)` — **`quantity_delivered` per line per delivery is the per-delivery billing basis.**
- `order_items(price_per_unit, cost_per_unit, actual_rate, rate_unit, acres, total_units_needed, total_price, quantity_delivered, quantity_remaining, unit_size, …)` — unit price = `price_per_unit`.
- `order_item_field_allocations(order_item_id, field_id, acres)` — per-line acre split across fields.
- `field_billing_defaults(field_id, customer_id, split_pct, is_primary, price_override_cents, pricing_note, …)` — per-field owner split. (NB: `price_override_cents` exists; the current whole-order `create_split` does **not** apply it — B should match that behavior or Codex flags it.)
- `invoices` carries **both** `delivery_id` and `invoice_group_id` — so a per-delivery split emits one draft invoice per owner, all with `delivery_id = this delivery` + a shared `invoice_group_id`.
- `calculate_billing_splits(total_cents, pct[])` — largest-remainder penny-exact allocator (used twice by the whole-order engine: acres across fields, then split_pct across owners).

## Proposed approach
A new SECURITY DEFINER RPC **`create_split_invoices_for_delivery(p_delivery_id uuid, p_salesman_id uuid DEFAULT NULL, p_invoice_type text DEFAULT 'chemical_sale', p_idempotency_key text DEFAULT NULL)`**, mirroring `create_split_invoices_from_order`'s two-level acre→owner penny-exact split but keyed on **this delivery's `delivery_items.quantity_delivered`** instead of `order_items.total_price`:
- For each `delivery_item` (its `order_item`, delivered qty `qd`): line value for THIS delivery = `ROUND(qd * order_items.price_per_unit * 100)` cents.
- Split that value across the order line's `order_item_field_allocations` **by acres**, then each field's portion across its `field_billing_defaults` owners **by split_pct** — penny-exact via `calculate_billing_splits` at both levels (identical to the whole-order engine).
- Aggregate per owner across all delivered lines → one **draft** invoice per owner, tagged `delivery_id = p_delivery_id` + a shared `invoice_group_id`, invoice_date = the delivery's completion date (**apply Feature A's lesson: pass/stamp the delivery's effective date, not blind CURRENT_DATE**).
- Wire into `complete_delivery`'s allocated branch: on a **partial** completion of an allocated order (the current ELSE branch that flags needs_split_billing), call this per-delivery engine (same-day guard + EXCEPTION fallback pattern as Feature A). Full-delivery still uses Feature A's whole-order path.

## THE critical landmine — cross-delivery penny reconciliation
The whole-order engine guarantees the per-owner invoices sum **exactly** to the order total. B splits **per delivery**. If each delivery independently rounds (qd × price → cents, then largest-remainder by acre by owner), the **sum of per-delivery per-owner cents can drift from the whole-order per-owner total** by a few cents (independent rounding across N deliveries). For landlord/tenant billing this is a real integrity risk (an owner over/under-billed by pennies across a season; totals that don't reconcile to the order).
- **Candidate mitigations (for Codex to stress):** (a) accept per-delivery rounding, document that per-delivery invoices sum to the delivery value not necessarily the order penny-total; (b) "true-up" the final delivery to the remainder (last delivery bills order-total-minus-already-billed per owner); (c) bill each delivery at qd×price with owner split, and reconcile at order-fully-delivered. Each has trade-offs. **This is the decision the design-review must settle.**

## Other failure modes for the adversarial review
1. **Double-bill vs Feature A / whole-order path.** B (partial) and A (full) must be mutually exclusive per delivery; the `v_existing_active_invoice_count` guard + `delivery_id` scoping must prevent a line being billed by both a per-delivery invoice AND a later whole-order split.
2. **A delivery that delivers qty NOT on an allocated line** (mixed order: some lines allocated, some not) — unallocated lines bill 100% to the order customer (like the whole-order engine).
3. **$0 / discount / net-negative owner** per delivery (whole-order engine rejects `SPLIT_NET_NEGATIVE`; per-delivery may hit it more often on small partials).
4. **Re-delivery / remainder deliveries** (create_followup_delivery) — each follow-up bills its own qd; must not re-bill the parent's already-billed qty.
5. **Voiding a per-delivery split invoice** then re-billing.
6. **Idempotency** on retried complete_delivery.
7. **Price/acre changes between deliveries** (order edited mid-fulfillment).
8. **Which completion path stamps needs_split_billing / clears it** across partial deliveries.

## Build plan (only after design-review clears)
1. New migration: `create_split_invoices_for_delivery` (Codex builds from the whole-order engine as the reference, keyed on delivery_items).
2. Wire into `complete_delivery` partial-allocated branch (another `complete_delivery` re-emit — verbatim + one block, like Feature A).
3. Frontend: the per-delivery split invoices appear in the office queue (draft) — likely no new UI (reuses invoice group display).
4. Full M4/A gate: 5 CRX reviewers + rolled-back smoke + Codex pre-ship + owner apply-OK.

## Codex adversarial design-review — VERDICT: **BLOCKER** (2026-07-10) → B is PARKED
Codex refuted the naive design above with 5 BLOCKERs + 2 HIGH. **Do NOT build the design above — build the corrected one below.**

**Corrected approach (Codex's #1 correction): a RESIDUAL-LEDGER, frozen at first delivery — not per-delivery independent rounding, not an end-of-order true-up.**
- When per-delivery billing FIRST starts for an order, **snapshot** the order's canonical split: price, `order_items.total_price` (the canonical amount — NOT qty×price_per_unit), acres, owner IDs, normalized split_pct, discount treatment. Persist it (new table, e.g. `order_split_billing_plan` + per-owner/per-line residual rows).
- Compute the canonical **whole-order per-owner-per-line target cents ONCE** (the exact whole-order engine result). Persist remaining cents per owner/line.
- Each delivery **consumes** from those residual targets with cumulative rounding (bill = its share of the frozen target, decrementing residuals); the **final** delivery consumes the exact remainder so every residual lands at **zero**. This guarantees the sum of per-delivery invoices == the whole-order split, penny-exact, with no negative final invoice.

**The 5 BLOCKERs the build MUST solve (all from the Codex review):**
1. **Rounding drift/overbill** — solved by the residual-ledger (consume from frozen targets, not independent per-delivery rounding). Example that breaks naive: 1 unit @ $0.01 delivered 0.5+0.5 → naive bills 2¢ vs 1¢.
2. **Full-vs-partial dispatch strands the final delivery** — once an order is in per-delivery mode, **EVERY** subsequent delivery (incl. the final) uses B; Feature A (whole-order) is allowed ONLY when no B billing history exists. One mutually-exclusive `IF/ELSIF` under an **order lock** in `complete_delivery`. (Today's guard would send the final delivery to Feature A → whole-order engine raises on D1's invoices → Feature A catches → order merely flagged → **final delivery unbilled**.)
3. **Canonical amount = `order_items.total_price`** distributed across deliveries (NOT `quantity_delivered × price_per_unit`, which drifts on discounted lines), or reject orders where the two bases don't reconcile.
4. **Snapshot the split at first delivery** (price/total/acres/owners/normalized pct/discount) — later price/acre/owner edits require a versioned adjustment/credit workflow, they must NOT retro-change already-billed deliveries.
5. **Void/rebill ledger-reversal policy** — cancelling a delivery's drafts must atomically restore residuals; a posted/paid per-delivery invoice needs an explicit credit/void settlement before that delivery can be reversed/re-billed (else redelivery = duplicate AR).
6. **HIGH — concurrency**: lock the order + billing-plan rows before deciding partial/full or consuming residuals; DB uniqueness per (delivery, customer, line); stable key derived from `delivery_id` (not just the caller idempotency key).
7. **HIGH — negatives/$0 + queue flag**: define whether a net-negative owner on a partial is carried forward or credit-memo'd; retain $0 qty/acre provenance; replace the single `orders.needs_split_billing` boolean with per-delivery ledger states (pending / billed / failed / cancelled / reconciled).

Full Codex verdict: `scratchpad/featureB-codex-design-review-output.txt` (this session).

## HANDOFF — build B in a FRESH dedicated session
This is a **new-table + state-machine + reversal-policy redesign**, not a quick follow-on — its own project (comparable to the credit-memo build). Recommended for a fresh session:
1. Design the `order_split_billing_plan` residual-ledger table + per-delivery ledger states (owner Mason to confirm the negative-owner + edit-mid-fulfillment policy — those are business calls).
2. Codex builds each migration from this corrected design; Claude orchestrates + verifies; Codex re-reviews (this design-review already burned round 1 — the corrected design starts fresh).
3. Full gate (5 CRX reviewers + rolled-back smoke + Codex pre-ship + owner apply-OK).
**Until then: partial allocated deliveries keep today's behavior** (flag needs_split_billing; office manually creates the whole-order split once fully delivered). Feature A (shipped) already covers the common full-delivery case.
