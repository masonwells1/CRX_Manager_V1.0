## 2026-09-03 — Actor-binding guard preserves quoted routine identities

Exact-SHA review reproduced a collision in the write-time actor-binding guard:
the syntax mask intentionally blanks quoted identifier contents, so distinct
equal-length schema or routine names could appear identical when a later
`ALTER ... SECURITY INVOKER` was matched to a `SECURITY DEFINER` creation.

The guard now discovers routine syntax through the mask but slices the exact
schema/routine identity from the original source before comparing `CREATE` and
`ALTER` statements. Parameter identity types are likewise read from
comment-blanked source so quoted type names remain distinct.

Regression tests cover equal-length quoted routine-name and schema-name
collisions. Both failed before the repair, pass after it, and fail again when
only the exact-name preservation is deliberately removed. The broader
best-effort actor-analysis cap remains unchanged.
