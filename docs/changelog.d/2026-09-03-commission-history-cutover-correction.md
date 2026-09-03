## 2026-09-03 - Refuse fabricated pre-cutover commission history

- Replaced the rejected order-date backfill with one immutable database cutover and opening
  observation effective at the real cutover time.
- Start exact date-only reporting on the first complete Chicago day after cutover and fail closed
  on the partial cutover day and every earlier date, because earlier earned-state versions were
  never recorded.
- Use wall-clock transition times for runtime earned, posted, voided, and cancellation events;
  keep payment header timestamps identical to their signed settlement events.
- Prevent recipient-group changes after any settlement history, reject payout dates before the
  snapshotted commission order date, reject frozen label rewrites, and count paid-only plus pending
  commissions correctly for a shared recipient.
- Strengthen replay with immutable opening metadata, one-opening-row uniqueness, full current-row
  ledger coverage, and exact function-body pins. The corrected candidate remains unapplied until
  renewed PostgreSQL, exact-SHA, drift/RLS, and Claude reviews are clean.
