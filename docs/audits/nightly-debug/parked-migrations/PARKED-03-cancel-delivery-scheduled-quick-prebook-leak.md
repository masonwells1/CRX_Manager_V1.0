# PARKED-03 — `cancel_delivery` strands prebooked inventory on a scheduled quick-delivery

**Severity:** HIGH · **Status:** VERIFIED real · **needs a design decision from Mason before I draft the migration** (not auto-applied).
Finding key: `delivery:cancel_delivery:scheduled-quick-prebooked-leak` · Nightly Debug cycle 2 · 2026-06-15

## The bug (verified against live `rhyzpcqhnizqbxphqdkr`)
- `create_quick_delivery` creates the delivery in status `scheduled` and, in its item loop, runs
  `UPDATE inventory SET quantity_prebooked = quantity_prebooked + qty` plus a `'prebooked'`
  inventory-transactions row.
- `cancel_delivery` permits cancelling `scheduled` / `in_progress` / `completed`, but its
  inventory-restore block is guarded by `IF v_delivery.status IN ('completed','in_progress')`.
  For a `scheduled` delivery it does **no** inventory adjustment. `void_delivery` only accepts
  `completed`. So a scheduled quick delivery can **only** be cancelled, and cancelling it never
  releases the prebook → `quantity_prebooked` stays inflated → Net Free (available − holds −
  prebooked) is understated indefinitely.
- Tell-tale: `cancel_delivery` declares `v_prebooked_reincremented` and returns it, but never
  increments it — a leftover of the missing release logic.

## Why this needs your decision (not a blind one-line fix)
Prebooking is owned by the **order/booking**, not the delivery. Map of who touches
`quantity_prebooked` (live): increments = `convert_quote_to_order`, `create_direct_order`,
`create_quick_delivery`, `create_rush_order`, `draw_down_quote`; decrements = `cancel_order`,
`complete_delivery`, `complete_job`.

- For a **normal** delivery, the prebook belongs to a separately-managed order, so `cancel_delivery`
  must **not** release it (the order, not the delivery, owns it).
- For a **quick** delivery, the order is auto-created and exists **only** for this delivery. But
  `cancel_delivery` today leaves that auto-order `confirmed` (its items have `quantity_remaining` =
  full, `quantity_delivered` = 0) and only cancels its draft invoice → a **zombie `confirmed` order**
  with a stranded prebook.

So releasing the prebook alone is **not** enough — it would leave a confirmed order with no
reservation backing it. The real question:

> **When a scheduled quick delivery is cancelled, should its auto-created order be cancelled too?**

- **Option A (recommended):** treat cancelling a quick delivery as cancelling the whole quick
  transaction — cancel the auto-created order (which releases its prebook via the normal
  `cancel_order` path) alongside the delivery. Cleanest; no zombie order, no leak, reuses tested
  release logic.
- **Option B:** in `cancel_delivery`, for `is_quick_delivery AND status='scheduled'`, release the
  prebook directly (`quantity_prebooked -= delivery_items.quantity`, emit a `'released'` txn) **and**
  cancel the auto-order so nothing dangles.

Either is a behavior change. **Recommendation: Option A.** It needs your OK on the intended UX:
does cancelling a quick delivery void the underlying sale? (For a quick delivery, almost certainly
yes — the order has no independent existence.)

**Tell me "cancel_delivery: Option A" (or B)** and I'll draft + validate + park the migration in the
next cycle.

---

## ⚠️ IMPLEMENTATION NOTE (2026-06-16, large-RPC pass) — Option A cannot call `cancel_order`

Mason chose **Option A**. But reading the live functions during implementation surfaced a hazard that
changes HOW Option A must be built:

- **`cancel_delivery` is gated to `role IN ('admin','sales_rep')`** (live md5 `c6aba47c51aa83653e153399e84d4981`).
- **`cancel_order` is gated to `role = 'admin'` only** ("Only admins can cancel orders"; live md5
  `a67c6358ec5102d81af5b75ac2b441e8`).

So the literal "reuse `cancel_order`" reading of Option A would make **a sales_rep cancelling a scheduled
quick delivery throw `Only admins can cancel orders`** and abort the whole transaction — a regression
(same class as the cycle-3 QuoteBuilder/`revert_quote_status` admin-only finding). `cancel_order` also
independently cancels deliveries + the invoice, overlapping `cancel_delivery`'s own logic (order-of-ops
hazards).

**Correct build = inline (Option B mechanism, Option A intent).** Inside `cancel_delivery`, for
`v_delivery.is_quick_delivery AND v_delivery.status = 'scheduled'` (status read BEFORE the delivery row is
flipped), within the `app.admin_override` bracket it already sets:
1. Release the prebook: per `delivery_items` row, `UPDATE inventory SET quantity_prebooked =
   GREATEST(quantity_prebooked - di.quantity, 0)` + a `'released'` `inventory_transactions` row (mirror
   `cancel_order`'s release block).
2. Cancel the auto-created order: `UPDATE orders SET status='cancelled'` **instead of** the current
   "set order to confirmed/partially_fulfilled" branch (which is what creates the zombie). Cancel its
   pending commissions (`status='cancelled', commission_amount=0`) to match `cancel_order`.
3. The draft invoice is already cancelled by `cancel_delivery`'s existing invoice loop — leave that as-is
   (do NOT double-handle).
   Guard: only do this when the order has no *other* active deliveries (a quick-delivery order is exclusive,
   but assert it so a hand-linked order isn't wrongly cancelled).

This is an **additive logic change** (not a verbatim-tiny-edit), so it needs a **multi-actor functional
smoke** (admin AND sales_rep cancel a scheduled quick delivery → prebook released, order='cancelled', no
zombie, Net Free restored, no auth error) + **Codex review** before apply. Deferred to a focused pass
(2026-06-16 large-RPC session ran out of safe context budget for a cross-RPC behavior change of this
weight). Do NOT ship the naive `PERFORM cancel_order(...)` version.
