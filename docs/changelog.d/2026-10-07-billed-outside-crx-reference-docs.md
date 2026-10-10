## 2026-10-07 - Reference docs for deliveries billed outside CRX and the reservation release

- `docs/reference/database-schema.md`: new `delivery_external_billings` table (admin read-only,
  written only by migrations) and its access row.
- `docs/reference/rpc-functions.md`: `get_dashboard_action_items` lists all nine categories,
  including `unbilled_deliveries`, which now skips deliveries billed outside CRX.
- `docs/workflows/INVENTORY_RULES.md`: the integrity check skips the five historical prebooked-only
  `adjusted` rows by id, and soft-deleted orders no longer hold reservations (guard since
  2026-07-21; leftovers released by `20261007150200`).
