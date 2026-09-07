## 2026-08-31 - Gauntlet Section 9 receiving and AP safety

- Bound receiving reversals to the authenticated actor and exact receipt/reason intent.
- Blocked reversals in closed periods or after an active PO-linked vendor bill exists.
- Made reversal fail closed when the expected inventory or PO-item row is missing.
- Preserved deleted receiving and photo metadata in the financial audit log.
- Corrected AP aging to use due dates with a distinct 1-30-day overdue bucket.
- Corrected AP dashboard month windows to calendar-month boundaries in Chicago time.
- Removed authenticated `TRUNCATE` access from receiving photos.
- Required a logged admin confirmation when cumulative active bills exceed 105% of a linked PO.
- Made Commission Balance current-state only so later payouts cannot silently rewrite a historical report.
