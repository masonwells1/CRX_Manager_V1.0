## 2026-09-05 - Refuse stale commission payment recipients

An unposted commission payment batch keeps the recipient selected when the batch is prepared. The
live settlement trigger previously searched history for the newest event matching that old header
recipient. If a commission moved from salesperson A to B before the batch posted, the search found
A's older event and could still credit A.

New forward-only migration `20260905020200_refuse_stale_commission_payment_recipient.sql` removes
that historical-recipient filter. The migration first drains the five commission/payment/ledger
writer tables so no transaction already running the old trigger can commit afterward. Posting then
locks every referenced commission in deterministic id order, takes its event timestamp only after
those locks are held, and compares the batch header with the latest earned-state recipient overall.
A changed or missing recipient raises
`COMMISSION_SETTLEMENT_RECIPIENT_CHANGED`; the operator must discard the stale batch and prepare a
new one for the current recipient.

The lock closes the concurrent version of the same race. If reassignment commits first, posting sees
the new recipient and refuses the old batch. If posting locks first, its signed settlement event is
written before reassignment proceeds, and the existing post-settlement recipient guard then refuses
the reassignment. The original exact-cent posting math and void reversal branch are preserved.

The network-isolated PostgreSQL 17 proof observes stale-A refusal, a valid B post at +1,234 cents,
and its void at -1,234 cents. Eleven mutation guards cover the apply-time writer lock, recipient and
row-lock checks, both recorder bodies/overloads, immutable-ledger helpers and triggers, exact RLS
policies/ACLs, and unconditional trigger shape, so a green proof cannot come from an unused guard.

This migration is source-only and not applied live. It requires a fresh migration apply gate and
Mason's explicit in-chat approval before production changes.
