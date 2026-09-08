## 2026-08-31 - Close final gauntlet authority bypasses

- Made browser access to `receiving_records` read-only so direct writes and truncation cannot bypass the governed reversal, inventory, accounting-period, audit, evidence, and idempotency controls.
- Revoked and verified inherited `TRUNCATE` access on `vendor_bills` in addition to row-level writes.
- Sequenced cycle-count item intents so an A-to-B-to-A edit cannot replay the first A after B, while an uncertain same-value retry still reuses its receipt.
- Expanded static and disposable PostgreSQL proof coverage for the new authority boundaries.
