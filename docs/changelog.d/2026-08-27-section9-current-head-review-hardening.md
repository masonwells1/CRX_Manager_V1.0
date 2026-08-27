## 2026-08-27 — Section 9 current-head review hardening

- Durable AP and receiving failure classification now stays non-throwing and
  fail-closed when browser coordination storage is unavailable, preserving the
  frozen request instead of escaping the caller's mutation error path.
- Receiving idempotency reconciliation now requires at least one committed
  receiving-record identifier, so an empty array cannot be mistaken for proof
  that an earlier receipt completed.
- Vendor-payment and receiving screens now catch durable-intent preparation
  failures before any RPC is called and tell the operator that nothing changed.
- Vendor-bill recovery preserves signed payment-term dates, edit forms use the
  shared exact-cents formatter, and route identity is committed in a layout
  effect rather than mutated during render.
- Regression coverage exercises storage failures, non-empty receipt proof, the
  exact money/date helpers, route identity, and the disabled expired-retry path.
  No live migration or production data change was performed.
- A duplicated browser tab now receives a distinct per-page claim even when it
  inherits the original tab's session storage. Definitive failure cleanup never
  deletes a resolved peer tombstone, and a collision regression proves the
  committed payment/receipt marker survives the copied-tab race.
