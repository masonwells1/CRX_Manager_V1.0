## 2026-08-28 - Production migration approval gate final hardening

The automated candidate-SQL path now admits only `COMMENT ON`; candidate-supplied `SET LOCAL`,
`CREATE TYPE`, and `CREATE DOMAIN` are parked for the separately reviewed manual path. The batch
wrapper obtains its migration-ledger table lock before the shared advisory lock, matching ordinary
ledger inserts and avoiding a cross-path deadlock. Workflow dispatch is bound to `main`.

The destructive scanner now treats a lone carriage return as a PostgreSQL line-comment terminator,
with permanent exploit regression coverage. Exact-input/exact-output one-use producers completed the
corresponding protected scanner transition and retained-harness re-pin after fresh exact-head Sol/high
clean reviews; the temporary producers were then removed.
