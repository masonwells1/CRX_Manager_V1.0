## 2026-09-08 — Prevent direct browser mutation of transfer receipts

Hardened the parked transfer-invoice intent migration so anonymous and
authenticated clients cannot directly insert, update, delete, truncate,
reference, or attach triggers to the shared idempotency receipt ledger. The
migration preserves authenticated SELECT for existing schema-capability probes
and leaves the reviewed owner-executed RPC path intact.

The migration now checks effective table and column privileges after the revoke
and again at postflight, so inherited roles, standalone column grants, and PUBLIC
grants fail closed. The disposable PostgreSQL proof mutation-tests a missing
TRUNCATE revoke and a privilege reintroduced before postflight, observes direct
authenticated mutation attempts fail, and confirms SELECT and exact RPC replay
still succeed. The migration remains parked and was not applied live.
