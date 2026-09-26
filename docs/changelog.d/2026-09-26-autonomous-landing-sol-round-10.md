## 2026-09-26 - autonomous landing: a policy with no TO clause is not routine

**Sol HIGH, round 10 on PR #804 (first of two).** PostgreSQL applies a `CREATE POLICY` with no `TO`
clause to PUBLIC, but the access classifier only looked for anon/PUBLIC when a `TO` clause was
present, so `CREATE POLICY ... USING (true)` on a new table passed as routine. A new table's policy
must now name its roles, and only `authenticated`, `service_role` or `postgres`; anything else waits
for Mason.

**Still open (handed to a fresh session):** Sol's second round-10 HIGH — a `CREATE OR REPLACE`d
function or view counts as created by the migration, so re-granting it to `authenticated` passes as
routine even when the existing object had no such grant. The planned fix models each replaced
object's prior grants from the migration history instead of treating it as new.
