## 2026-08-26 — stale Section 9 retries fail closed before the RPC

Exact-commit review found that a durable browser intent could outlive the
database's 24-hour idempotency receipt. An exact retry after the server deleted
that receipt would execute a payment, bill, or inventory receipt again under the
same key.

Durable intents now record a creation time and a retry deadline 23 hours later,
leaving a one-hour safety margin before the server receipt expires. The shared
hook refuses to return a mutating key at or after that deadline, preserves the
frozen payload and lock, and marks legacy records without a deadline immediately
stale instead of deleting them. All six critical forms disable stale retry
buttons and direct the operator to authoritative/manual reconciliation. The
active Quick Receive component test proves an expired record cannot call
`receive_po_items`; hook tests prove the key remains unavailable and the lock
survives reload.

Proof: TypeScript, full lint, production build, documentation drift, and diff
hygiene pass; 4 focused files and 22 tests pass; the full suite passes 342 files
with 4,811 tests passed and 123 skipped. Exact-commit review remains pending. No
live migration or data mutation was performed.
