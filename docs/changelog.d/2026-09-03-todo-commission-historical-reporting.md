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
`unposted`), and **0 `commission_payment_items`**. Nothing has ever been paid, so there is no back
history to reconstruct and shipping the refusal costs nothing real today. Build the ledger-backed
report after a season of payouts and every date before that point becomes permanently
unanswerable — the data to reconstruct it will never have existed. Mason put the first payout at
"probably a few months out," which is the deadline.

The write-up deliberately leads with what already exists, because the obvious failure mode here is
someone scoping a new commission-history subsystem. There is already a dated payment ledger:
`commission_payments` carries `payment_date`, `posted_at` and an `unposted|posted|voided` status,
`commission_payment_items` links payments to individual commissions with amounts, and the
`create_`/`post_`/`void_commission_payment` RPCs plus `src/pages/CommissionPayments.tsx` are live.
The real gaps are two missing dated columns — `commission_payments.voided_at` and
`commissions.cancelled_at` — and a report that reads current status instead of joining the ledger.

The 2 already-cancelled commissions have `deleted_at` NULL and no cancellation date, so their
timing is already unrecoverable. The spec says to accept that and footnote it rather than invent a
date, and gives the same instruction for the wider case if the window has closed by pickup time:
refuse dates before the ledger start and name the boundary, never return a partial answer that
reads as complete.

Files: `TODO.md` (dated callout at the top of the engineering section) and
`docs/plans/commission-history-as-of-reporting-spec-2026-09-03.md` (problem, verified live counts,
existing machinery, the two gaps, target behaviour, acceptance criteria including real-path proof,
and the fallback path).

One question is recorded as open and unanswered: what Mason uses a historical commission balance
*for*. It decides whether this is a date picker on the existing report or a dated per-recipient
statement, so it is flagged rather than assumed.
