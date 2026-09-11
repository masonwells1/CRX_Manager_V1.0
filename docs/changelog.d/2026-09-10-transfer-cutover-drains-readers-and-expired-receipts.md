## 2026-09-10 — Transfer cutover drains readers and clears expired legacy receipts

Sol's exact-SHA review of PR #638 found a replay path in the parked
`20260908130800_bind_transfer_invoice_intent.sql` cutover. A legacy
`transfer_job_to_invoice` call that starts while its receipt is unexpired waits on the
key's advisory lock inside `check_idempotency()` before it touches `idempotency_keys`,
so the cutover's table lock never drains it. If the receipt expires and the cutover
commits before that lock is released, the call's expiry `DELETE` uses its own
transaction-start time and keeps the row, and its `SELECT` returns the unbound receipt
with no actor or job check. The old refusal ignored expired receipts, so it could not
stop this.

The migration now:

- refuses to run at any isolation level except READ COMMITTED. At REPEATABLE READ the
  snapshot is fixed before the lock is granted, so the checks below could miss a
  receipt committed during the wait. Live runs READ COMMITTED with no role override.
- takes `ACCESS EXCLUSIVE` on `idempotency_keys` first, with `lock_timeout` lowered
  from 15 to 5 seconds. It waits for every transaction that has read or written the
  table and keeps new ones out until commit. While it waits, receipt reads and writes
  across the app queue behind it, so the wait stays under the 8-second statement
  timeout live sets for `authenticated`.
- deletes expired, unbound `transfer_job_to_invoice` receipts under that lock. These are
  expired retry-cache rows, not invoices or jobs; `check_idempotency()` deletes the same
  rows the next time their key is used. Together with the existing refusal of unexpired
  and no-expiry receipts, no unbound transfer receipt survives cutover.

Both job-invoice screens (`JobDetail` and `UnbilledApplicationsPanel`) now also refuse a
transfer result whose `job_id` is missing or names another job. They route it through
the existing "could not verify the invoice result" reconciliation: no navigation, no
success message, and the request key is kept until a fresh job read settles what
happened. The live transfer body returns `job_id` on both its single-invoice and split
paths, so this check is safe before the migration is applied.

Because of that delete, the repo's apply guard now classes the file as destructive, so it
can only be applied in an attended session whose approval names the receipt deletion.
The SQL is still parked. No live migration was applied.

Proof observed:

- `scripts/smoke/prove-transfer-invoice-intent-binding.mjs` (disposable PostgreSQL 17,
  no network) runs Sol's race in two sessions. One session holds the key's advisory lock.
  A legacy call waits on it, holding no lock on the receipt table (asserted from
  `pg_locks`). The receipt expires after that call began, the real migration commits,
  and the key lock is released. The held call then fails with
  `TRANSFER_INVOICE_INTENT_CUTOVER_RETRY`, rolls its work back and leaves no receipt.
  Expired receipts for other operations, and bound transfer receipts, survive; an
  expired receipt missing only one binding column is purged. The same instance refuses
  the file at REPEATABLE READ with `TRANSFER_INVOICE_INTENT_ISOLATION` and renames
  nothing.
- A second disposable instance falsifies each new statement. Without the purge, the same
  held call succeeds and returns the expired cached invoice. Without the early lock,
  cutover completes while another transaction has an open read of the table. With the
  lock, that open reader makes the real migration refuse with a lock timeout and rename
  nothing.
- The static proof pins the isolation guard, the lock, its place after `lock_timeout`
  and before every preflight, the purge, and the whole refusal block as its exact
  complement. It reads every ordering from line-anchored statements, so a comment
  that names a statement cannot satisfy it. A copy of the static proof was run
  against seven broken copies of the migration, and each one failed. The copies narrowed
  the refusal to `AND`, moved it to `clock_timestamp()` behind a comment, moved the
  lock below the first preflight behind a comment, reset `lock_timeout`, disabled the
  isolation guard, read the table before the lock, and added a second table lock.
  The unmodified file passed.
- Four new component tests cover a result for another job and a result with no job, on
  both screens. All four failed with the `job_id` comparison disabled.
- `scripts/smoke/prove-commission-migration-plan-order.mjs` still applies the whole
  parked set in its planned order on PostgreSQL 17, with this file sixth
  (`COMMISSION_MIGRATION_PLAN_ORDER_PROOF_PASS`), and `npm run test:correction-guards`
  passes.
- The full Vitest suite passes (374 files; 5,251 passed, 123 skipped), and the live
  `transfer_job_to_invoice` body was read without writing: both of its success results
  carry `job_id`.

Residual: a legacy caller at REPEATABLE READ or SERIALIZABLE whose snapshot predates
cutover could still read a deleted receipt. PostgREST's default is READ COMMITTED.
