# Shelved: booking-prepay EARMARK engine (#6b) — 2026-06-14

**Status:** SHELVED for a dedicated redesign in the next few days (Mason's call, 2026-06-14).
These three migration files are NOT in `supabase/migrations/` and are NOT part of the
G5 go-live batch. They are preserved here verbatim as the starting point for the
proper "reserved prepay pool" redesign.

## What was shelved
- `20260613240000_booking_prepay_earmark_and_apply.sql` — `set_prepay_credit_booking`
  (earmark a prepay credit to a booking) + `apply_booking_prepay` (FIFO auto-apply a
  booking's earmarked credits to its draw invoices via Mechanism A).
- `20260613250000_auto_apply_booking_prepay_on_post.sql` — AFTER UPDATE OF status
  trigger that fires `apply_booking_prepay` when a draw invoice posts.
- `20260613280000_aggregate_prepay_reserve_earmarked.sql` — `apply_remaining_prepayments`
  rewrite that reserved earmarked credits from the legacy aggregate spend path.

The matching **frontend** was also removed from the branch: the PrepaymentManager
"Assign to booking" earmark control and the OrderDetail "Apply booking prepay" button.

## Why it was shelved (Codex rounds 5–6)
The earmark engine **trusts individual `prepay_credits.balance_cents`** (Mechanism A,
ledger-based), but the existing prepay subsystem has a second spend path —
`apply_remaining_prepayments` / `batch_apply_all_prepayments` (Mechanism B) — that
spends the customer's **aggregate** `customers.prepay_balance_cents` WITHOUT writing
`prepay_applications` or reducing per-credit balances. The two views of the same money
disagree, which produced money-integrity defects:

1. **Double-spend** — run the legacy "Apply all prepayments" (spends the aggregate),
   then earmark that credit to a booking: the credit slip still reads full, so
   `apply_booking_prepay` spends the same cash again. (The round-4 freeze guard only
   checks `prepay_applications`, which Mechanism B never writes — so it can't detect this.)
2. **Funds diverted** — an earmarked credit can still be applied to ANY invoice via
   `PrepayWorkspace` / `batch_apply_prepayments` → `apply_prepay_to_invoice` (the shared
   atom has no earmark guard), pulling reserved booking funds onto an unrelated invoice
   while settlement still attributes it to the booking via `credit.quote_id`.
3. The aggregate-reservation patch (280000) also made `apply_remaining_prepayments`'s
   `remaining_prepay_cents` report only unearmarked funds, which the PrepaymentManager UI
   shows as the customer's total — under-reporting.

The correct fix is **architectural, not a patch**: earmarked prepay must be physically
separated from the spendable aggregate pool — a dedicated reserved balance — so neither
the legacy aggregate path nor the generic apply path can ever touch booking-reserved
funds. That needs guards inside `apply_prepay_to_invoice` (the single most-used billing
function) and a coherent reserved-vs-spendable model, which warrants its own design pass.

## Redesign sketch (for the next-few-days effort)
- Add a `customers.prepay_reserved_cents` (or per-credit "reserved" flag) so earmarked
  funds are subtracted from the spendable pool at earmark time, atomically.
- Make `apply_prepay_to_invoice` reject an earmarked credit unless the target invoice is
  a booking-draw invoice of that same booking (`order.quote_id = credit.quote_id`).
- Exclude earmarked credits from `apply_remaining_prepayments` / `batch_apply_prepayments`
  selection AND keep `remaining_prepay_cents` reporting total available (not unearmarked-only).
- Earmark only a fully-unused, fully-backed credit (SUM(earmarked) <= aggregate).
- Re-add the PrepaymentManager earmark control + OrderDetail "Apply booking prepay" button.
- Full in-house gate + adversarial verify + a Codex pass, same as the rest of the roadmap.

## What stays live now (the read-only foundation)
`20260613230000_prepay_booking_link_and_settlement.sql` (the `prepay_credits.quote_id`
link column + `get_booking_settlement` read RPC) and
`20260613260000_open_booking_rollover.sql` (the `get_open_booking_rollover` read RPC)
**remain in the go-live batch**. They are read-only and safe; their prepay columns simply
read 0 until the engine returns (nothing sets `quote_id` while the engine is shelved), and
the UI auto-hides the prepay sub-rows while they are 0. The booked/drawn/remaining
reporting they provide is useful on its own.
