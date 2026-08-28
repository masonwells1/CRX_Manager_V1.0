## 2026-08-28 - Production migration approval gate final hardening

The automated candidate-SQL path now admits only `COMMENT ON`; candidate-supplied `SET LOCAL`,
`CREATE TYPE`, and `CREATE DOMAIN` are parked for the separately reviewed manual path. The batch
wrapper obtains its migration-ledger table lock before the shared advisory lock, matching ordinary
ledger inserts and avoiding a cross-path deadlock. Workflow dispatch is bound to `main`.

The destructive scanner now treats a lone carriage return as a PostgreSQL line-comment terminator,
with permanent exploit regression coverage. A one-use, exact-input/exact-output producer carries the
corresponding re-pin for the retained protected maintenance harness; it requires a fresh exact-head
Sol/high clean review before it can write and will be removed after that single reviewed transition.
