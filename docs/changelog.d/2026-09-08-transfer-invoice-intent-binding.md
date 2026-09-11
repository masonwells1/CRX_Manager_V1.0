## 2026-09-08 — Bind job-to-invoice retries to the requesting user and job

Delivery: SOURCE/UI-ONLY. Merging PR #638 ships the two job-invoice screens and
repository files; it applies no SQL. The migration files in its diff are all parked
and unapplied:

- `20260908130800_bind_transfer_invoice_intent.sql` is new: the wrapper and cutover.
- `20260908130900_repair_commission_history_label_snapshots.sql` is renamed from
  `20260905210000_repair_commission_history_label_snapshots.sql` so it still runs
  after the wrapper; only its ordering comment changed.
- `20260905200200_refuse_stale_commission_payment_recipient.sql` is edited in place;
  it has never been applied.

The screens' new `job_id` check works with both contracts. Live's installed
`transfer_job_to_invoice` returns `job_id` on its single-invoice and split paths, and
the parked wrapper refuses any result whose `job_id` is not the requested job.

Added a parked, forward-only migration that preserves the current Chicago-date
job-to-invoice implementation as a private routine and exposes only an
actor-bound idempotency wrapper. It refuses unexpired legacy receipts, body or
ACL drift, overload drift, missing receipt bindings, and invalid replay results.
Legacy receipts with no expiry are treated as still live, and cutover also
refuses if receipt-table ownership, RLS, the deny-all policy, browser-role
posture, or client write grants have drifted from the reviewed security state.
An enforced one-transaction cutover installs an owner-only compatibility trigger
that drains receipt writers and rejects a cached pre-cutover body with a retry
signal before it can commit an unbound receipt; the new wrapper marks its own
transaction before calling the preserved implementation. The runtime refusal
tokens are also registered in the shared TypeScript RPC error contract, with
tested plain-English retry and reconciliation guidance in both job-invoice entry
points, including corrupt cached-receipt failures and missing post-mutation
receipts.

An offline static contract proof and a disposable PostgreSQL 17 behavioral proof
cover unsafe-autocommit refusal, stale-body rollback, and replay paths. This entry
does not claim a live migration apply.

Refreshed the existing production rollback smoke for the currently deployed
`transfer_job_to_invoice` behavior so it uses governed Product cost bases,
checks per-owner invoice groups, and proves unsupported split overrides refuse
before invoice creation. The refreshed chain returned `SMOKE_PASS_ROLLBACK` on
the live database; it does not exercise or imply application of the parked
migration.
