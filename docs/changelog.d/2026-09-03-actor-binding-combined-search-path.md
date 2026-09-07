## 2026-09-03 — Actor guard parses combined quoted search-path lists

Exact-SHA review reproduced a forged-actor path where PostgreSQL interpreted
`SET search_path TO 'evil, pg_catalog'` as two schema entries, while the guard
treated the SQL string as one opaque value and trusted the UUID comparison.

The guard now expands ordinary SQL string constants using PostgreSQL's
comma-list semantics before deciding whether a user schema precedes
`pg_catalog`. CREATE attributes, later ALTER attributes, and top-level state
inherited through `SET search_path FROM CURRENT` share that parser. Nonstandard
escape-string forms fail closed instead of receiving an inferred safe order.

The three exact exploit shapes failed before the repair and the focused suite
passes 544 assertions afterward. Disabling only the combined-list expansion
makes the CREATE exploit fail again; restoring it returns the suite to green.
The broader actor-analysis cap remains unchanged.
