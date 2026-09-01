## 2026-08-31 — Offline Work Review invalidates stale resolution snapshots

Refreshing the Offline Work Review queue now clears any selected item, open confirmation,
explanation, and idempotency key before the newer authoritative response arrives. Resolution
controls also refuse to act while the queue is loading or errored, preventing a permanent
resolution from being submitted against an obsolete queue snapshot.

The focused regression was mutation-proven: with the test retained and the invalidation removed,
the stale confirmation remained actionable and the test failed; restoring the fix made all eight
Offline Work Review tests pass. No database schema or live data changed.
