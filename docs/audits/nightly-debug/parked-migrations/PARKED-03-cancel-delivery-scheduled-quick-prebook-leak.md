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
