## 2026-10-23 — Field functions require field access (To-Do row 11.4, part A)

Part A of the row 11.4 fix plan in `docs/manual/KNOWN_ISSUES.md`. One new migration,
`20261023090000_field_functions_require_field_access.sql`, a checked-in disposable prover
(`scripts/smoke/prove-field-functions-require-field-access-real-schema.mjs`) and its container chain
(`scripts/smoke/smoke-field-functions-require-field-access.sql`). No frontend file changed.

### What was wrong

Eighteen `SECURITY DEFINER` functions (they run with the owner's rights, so row security never applies
inside them) checked nothing, so any signed-in account (applicators, drivers, an `entity_recipient`
profile, a deactivated user with a live token) could read every customer's fields, boundaries and
owner names, field billing splits with price overrides, accounts-receivable balances, credit limits,
the company-wide overdue-invoice list, global search results and every team note on any record.

### What changed

* New `_can_see_field(field_id)`: active office staff see every field; the whole-job applicator sees
  the fields on their job unless it is soft-deleted; a per-field or crew assignee sees only the field
  their own dispatch points at, while it is open or completed within 7 days (never cancelled), on a
  job that is not soft-deleted, with an active profile and (crew) an active crew and membership.
* `get_fields_geojson_by_ids` (Field View, Dispatch Board) and `get_field_geojson` (Job Detail)
  return only fields that pass it.
* Office-only (`require_admin_or_sales_rep()`): `get_fields_with_geojson`, `get_field_polygons`,
  `get_field_dashboard`, `derive_customer_shares_from_fields`, `get_customer_farm_group`, both
  `get_field_billing_splits_for_*`, `get_customer_summary`, `check_customer_credit_limit`,
  `get_dashboard_action_items`. Every screen that calls them is office-only. The review found three
  more unchecked functions of the same kind with no caller anywhere (`_check_credit_limit`,
  `get_customer_delivery_remainders`, `check_duplicate_delivery`); they are office-only too.
* `global_search` returns nothing to anyone but office staff.
* `get_notes_for_entity` runs as the caller and returns notes only for a record the caller can
  already read.
* `operational_dashboard_summary` is re-emitted unchanged so the migration files carry the role check
  live already has.

The migration refuses to run outside one transaction or over any changed live body (md5 pins on all
eighteen), and its closing check confirms every function's new body and unchanged owner, grants,
search_path, volatility and return type, plus the new helper's body and grants.

Office staff see exactly what they saw before (proved by the prover's before/after snapshot).
Parts B (tables) and C (the whole-job applicator's lifecycle window) are still open.
