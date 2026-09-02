## 2026-08-12 — Actor-binding routine modes use exact schema identity

Fresh adversarial review found that a later `ALTER FUNCTION ... SECURITY
INVOKER` could incorrectly demote a same-named unsafe routine in another schema,
and the inverse match could hide an unreadable cross-schema `SECURITY DEFINER`
elevation. Routine mode changes now affect a readable definition only when both
names are fully schema-qualified and exactly equal; unqualified names remain
fail-closed. Three focused regressions cover cross-schema demotion, cross-schema
elevation, and ambiguous unqualified demotion. A separate recommendation to
remove three parked migration exemptions was rejected after the real hook denied
all three files without their reviewed markers; their executable SQL remains
unchanged and unapplied.

