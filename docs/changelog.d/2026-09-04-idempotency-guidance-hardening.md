## 2026-09-04 - Idempotency guidance hardening

- Removed unsafe guidance that told normal helper-based RPCs to add a file-wide idempotency-check exemption marker.
- Documented that exemptions are limited to genuine delegation or parser limitations and require manual review of every function in the migration.
- Added a deterministic regression check and completed the remaining current pointer and ledger-list reconciliation found by exact-commit review.
