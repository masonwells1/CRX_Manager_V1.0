## 2026-09-03 — TODO: rebuild "as of a past date" commission reporting (owner-deferred, dated)

Docs only. No code, schema, or live state changed.

Migration `20260831162000` (PR #535) makes `get_commission_balance_report` refuse any as-of date
that is not Chicago-today. That is correct — `commissions` stores only *current* payout status, so
resolving a past date meant summing today's statuses against yesterday's question and returning a
confidently wrong number. But it removes a capability Mason uses. Asked directly on 2026-09-03 he
said "Yes I want to be able to look at historical dates," then deferred the rebuild rather than
dropping it. This records that deferral so it is picked back up rather than rediscovered.

It is dated rather than "someday" because the cheap window is open and will close. Verified live
2026-09-03: 35 commissions (33 pending, 2 cancelled, **0 paid**), 8 `commission_payments` (all
`unposted`), and **0 `commission_payment_items`**. Nothing has ever been paid, so there is no payout
history to reconstruct. Pre-cutover earned-state changes were never recorded, however, so the
correct design must observe the opening state at the real cutover and refuse earlier dates rather
than backdating current rows. Build after a season of payouts and the missing payout interval also
becomes permanently unanswerable. Mason put the first payout at "probably a few months out," which
is the deadline.

The write-up deliberately leads with what already exists, because the obvious failure mode here is
someone scoping a new commission-history subsystem. There is already a dated payment ledger:
`commission_payments` carries `payment_date`, `posted_at` and an `unposted|posted|voided` status,
`commission_payment_items` links payments to individual commissions with amounts, and the
`create_`/`post_`/`void_commission_payment` RPCs plus `src/pages/CommissionPayments.tsx` are live.
The real gaps include two missing dated columns — `commission_payments.voided_at` and
`commissions.cancelled_at` — plus immutable cutover, earned-state, and signed settlement facts;
current payment and commission rows are operational state, not a complete history ledger.

The 2 already-cancelled commissions have `deleted_at` NULL and no cancellation date, so their
timing is already unrecoverable. The spec says to include them as excluded legacy states in the
real opening observation rather than inventing a historical date, and gives the same instruction
for the wider case if the window has closed: refuse dates before the ledger start and name the
boundary, never return a partial answer that reads as complete.

Files: `TODO.md` (dated callout at the top of the engineering section) and
`docs/plans/commission-history-as-of-reporting-spec-2026-09-03.md` (problem, verified live counts,
existing machinery, the four gaps, target behaviour, acceptance criteria including real-path proof,
and the fallback path).

## 2026-09-03 (follow-up) — Mason answered the open question; requirement upgraded

The entry above recorded one question as open: what Mason uses a historical commission balance
*for*. He answered it the same day — "year end, checking what I owed and reconciling payouts — all
of it. It is very important to have this."

That upgrades it from a convenience feature to a financial-reporting requirement, and changes the
design in two concrete ways. Payout reconciliation needs per-payment detail — payment number, date,
and the individual commission lines it settled — not only per-recipient aggregates. And a year-end
figure must return the same answer when re-run a year later, which is exactly what the
current-status implementation cannot promise and the strongest argument for the ledger-backed
rewrite.

Timing is tighter than first recorded: the first payouts land around 2026-11/12, roughly year-end
2026, so the first year-end that needs this is likely the first one with payouts in it.

One finding makes it more tractable than it looked. Verified live: `post_commission_payment` and
`void_commission_payment` are thin wrappers, and the real bodies
(`_post_commission_payment_intent_impl_20260809`, `_void_commission_payment_intent_impl_20260809`)
already write `commission_payment_items` and maintain `commissions.paid_date`. The reconciliation
data remains a useful operational input, but stable historical reporting also requires new immutable
cutover and event-ledger plumbing. The two dated-column gaps (`commission_payments.voided_at`,
`commissions.cancelled_at`) are unchanged.
