## 2026-09-11 — PR #646: the migration's role prerequisite is documented and verified

CodeRabbit's remaining Major on PR #646 concerns the postcondition in
`20260908120000_close_pr535_live_gaps.sql`: `EXISTS (SELECT 1 FROM pg_roles …)` and
`has_function_privilege(role_name, …)` are AND siblings, and SQL does not guarantee left-to-right
evaluation. On a database without the named role, the privilege call can run first and raise an
error instead of returning false.

The file is applied live and must stay byte-exact to what ran, so the code is not changed. This
entry records the answer the backlog plan asks for — the prerequisite, and proof that it holds —
instead of calling the finding un-actionable.

**Supported environment.** The Supabase project `rhyzpcqhnizqbxphqdkr`, which provisions `anon`,
`authenticated` and `service_role`. Verified read-only on 2026-09-11: `pg_roles` lists all three.
That is also why the apply on 2026-09-08 evaluated cleanly and committed.

**Unsupported boundary.** A replay target without `anon` or `authenticated`. The consequence there
is an error that aborts the apply transaction and writes no ledger row. The migration refuses to
apply; it cannot report a false pass or weaken a privilege check.

**Forward remedy.** Any future migration using this pattern writes
`CASE WHEN EXISTS (…) THEN has_function_privilege(…) ELSE false END`, and any non-Supabase replay
target provisions the two roles before replaying this file. Recorded in
`docs/reference/migration-history.md` row 923 alongside the applied status, not in the SQL.

The CodeRabbit thread stays open for the reviewer's own disposition; it is not being resolved to
make it disappear.
