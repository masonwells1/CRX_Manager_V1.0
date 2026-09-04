## 2026-09-03 — Actor guard preserves shadowed UUID overload identity

Exact-SHA review reproduced a final-mode mismatch where bare `uuid` resolved to
a user-schema domain during CREATE but to `pg_catalog.uuid` during a later
`SECURITY INVOKER` ALTER. The guard treated both source spellings as the same
routine identity and skipped the unsafe SECURITY DEFINER body.

When the migration can shadow bare UUID resolution, CREATE and ALTER routine
signatures now treat unqualified `uuid` as ambiguous and refuse to use it as
final-mode evidence. Explicit `pg_catalog.uuid` identities remain comparable.

The shadowed-domain overload payload failed before repair and fails again when
only the new ambiguity check is disabled. The restored focused suite passes
553 assertions. The broader actor-analysis cap remains unchanged.
