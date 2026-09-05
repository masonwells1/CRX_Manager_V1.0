## 2026-09-04 - Refuse a blank field-application invoice date before save

- Field-application invoices now show an actionable error when the transaction date is
  cleared instead of sending an empty date string to PostgreSQL and surfacing a raw RPC
  cast failure.
- Added focused coverage proving the save RPC is never called while the date is blank.
