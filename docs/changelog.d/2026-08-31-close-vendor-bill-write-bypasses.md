## 2026-08-31 - Close vendor-bill write bypasses

- Made browser roles read-only on `vendor_bills` so direct PostgREST writes cannot bypass the governed RPC controls for cumulative PO billing, accounting periods, audit records, and idempotency.
- Required explicit confirmation and a reason for any positive cumulative bill attached to a zero-total PO, on both creation and edit.
- Retired rejected receiving replay keys on the Inventory screen so a corrected request can retry deliberately.
- Added static and disposable PostgreSQL proofs for denied direct writes and zero-total PO confirmation.
