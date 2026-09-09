## 2026-09-01 - Section 9 gauntlet integration safety

- Reject vendor-bill and payment amounts with more than two decimal places instead of silently truncating money.
- Preserve idempotency keys across modal reopen and rotate them only after success or a proven server binding rejection.
- Bind damaged-receiving notifications to immutable receipt IDs and avoid contradictory success messages for receipts completed elsewhere.
