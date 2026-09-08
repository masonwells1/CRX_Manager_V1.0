## 2026-09-03 - Commission history snapshot contract

- Added a local-candidate read-only RPC that returns commission balances and payment reconciliation detail from one PostgreSQL statement snapshot.
- Added fail-closed replay checks for the exact commission ledger column, primary-key, identity-sequence, and foreign-key catalog contracts.
- Preserved PostgreSQL date-only values when exporting commission CSV files so Chicago business dates cannot shift to the prior day.
- Corrected the generated direct-report types so nullable legacy recipient IDs remain nullable.

The original commission-history migration remains byte-for-byte unchanged and live. The follow-up migration was applied to production on 2026-09-03 under ledger version `20260904040643`.
