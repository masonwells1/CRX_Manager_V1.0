## 2026-09-05 - Commission payouts use the Chicago business date

- Commission payment dialogs now generate payout dates from Crop RX's `America/Chicago` business calendar, matching the historical commission report cutoff.
- A source-only migration adds a database guard that refuses commission-payment dates later than the current Chicago business date, including writes that bypass the browser.
- The disposable PostgreSQL proof covers future-date rejection, same-day acceptance, catalog drift, and restricted trigger-function access.
- This migration has not been applied live. A separate current-conversation approval and fresh migration gates are still required before production apply.
