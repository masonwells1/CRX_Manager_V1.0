## 2026-10-07 - Billed-outside-CRX migration: review round 2 tidy-ups

Migration-drift round 2 on `20261007150000_record_deliveries_billed_outside_crx.sql` (still NOT
APPLIED) found no blocker. Applied: the header now lists the dashboard function re-emit, the
rollback note restores `get_dashboard_action_items` from `20260827041300` before anything that the
function reads is removed, the updated_at trigger follows the `set_<table>_updated_at` convention,
the postflight asserts the guard functions are owned by `postgres` and that `metabase_ro` cannot read
the table, and the comments record two accepted behaviours (the invoice_type-change window, and a
later-voided recorded delivery still blocking whole-order billing — fail-closed).
