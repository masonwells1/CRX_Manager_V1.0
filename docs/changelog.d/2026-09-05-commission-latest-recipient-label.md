## 2026-09-05 - Commission balances use the latest historical recipient label

- Added a parked forward migration that replaces alphabetical
  `MIN(recipient_name)` selection with the latest earned-state label recorded at
  the requested Chicago business-date cutoff.
- Paid-only groups use that same latest earned-state label, with the latest
  settlement label retained only as a fail-safe for incomplete historical data.
- Preserved the existing earned, paid, outstanding, pending, and paid-count
  calculations and the report RPC's signature, admin gate, and grants.
- Expanded the network-isolated PostgreSQL proof with renamed earned and
  paid-only recipient fixtures, replay verification, and an oldest-label
  mutation that must fail.

This migration remains source-only and parked. No live database was queried or
changed, and applying it still requires Mason's separate explicit in-chat approval.
