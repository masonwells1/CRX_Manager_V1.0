## 2026-08-31 — Section 9: durable live-claim lease, guarded payment recovery, CHANGELOG policy

- **A crashed browser could permanently lock a user out of an AP operation.**
  `useUncertainMutationIntent` marked a mounted page's claim live with a static
  `'active'` sentinel that only the `pagehide` listener and effect cleanup ever
  removed — neither of which survives a browser crash, a force quit, or an OS
  kill. The abandoned claim stayed in `claimTabIds` forever, so
  `deleteCoordinatedRecord` could never delete the record, and once the 23-hour
  `SAFE_RETRY_WINDOW_MS` elapsed `getIdempotencyKey()` threw
  `DURABLE_MUTATION_INTENT_RETRY_EXPIRED` on every attempt. Durable storage is
  keyed by `[operation, userId]` only, so one crash locked that user out of
  *every* vendor payment or receiving attempt for that operation, and the retry
  window made it worse rather than self-healing. The marker is now a renewable
  timestamped lease with a 15-minute TTL, refreshed by a 60-second heartbeat
  while the page is mounted, so an abandoned claim ages out in minutes instead of
  never. Failing to **read** a lease still fails closed — an unreadable lease is
  treated as live, because reporting a peer as dead on a storage error would let
  a second request delete the record and mint a new idempotency key while the
  first was still in flight.
- **Comment corrected to match the code.** The release path's comment claimed a
  failed release "keeps reconciliation fail-closed"; with the static marker that
  was really fail-*permanently*-closed — a lockout, not a safety property. The
  comments now state what the lease actually guarantees: a failed release delays
  reconciliation by at most one TTL rather than stranding the record.
- **A committed vendor payment could leave the modal spinning forever.** In
  `VendorBillDetail.handleRecordPayment`'s catch, the recovery path awaited
  `paymentIntent.resolveIntent()` with no guard and `setPaying(false)` sat
  outside any `finally`. `resolveIntent()` reaches `openDurableIntentDb()`, which
  rejects with `DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE` in a private window
  or on a blocked/quota-failed connection — so a payment that had **provably
  committed** produced no toast, no refresh, and a permanently loading button.
  It never permitted a double payment (the key stays locked), so this was an
  availability defect, not a duplication one. Both bookkeeping awaits are now
  individually guarded and reported through the shared Sentry boundary, and
  `setPaying(false)` moved into a `finally`.
- **`docs/CHANGELOG.md` append removed.** The branch appended two sections to the
  15,000-line shared changelog while also adding eight correct `docs/changelog.d/`
  files. The append is deleted; the per-change files stand.
- Regression coverage: three new hook tests pin an abandoned lease expiring after
  its TTL, a mounted claimant surviving past the TTL because its heartbeat
  renews, and an unreadable lease failing closed. A new page test renders
  `VendorBillDetail`, drives the real Record Payment flow against a committed
  idempotency receipt with IndexedDB removed mid-call, and proves the operator
  still gets the warning toast and a closed modal. Every fix was mutation-tested:
  each was deliberately broken and confirmed to turn the new coverage red.
- No live migration was applied and no production data was changed.
