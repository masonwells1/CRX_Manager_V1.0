## 2026-08-28 - Global migration ledger trigger replica-bypass closure

The source-only global migration-order trigger is now enabled in PostgreSQL `ALWAYS` mode and its
catalog verification requires `tgenabled = 'A'`, no `WHEN` condition, and zero trigger arguments.
The bootstrap migration includes a rollback-only probe that attempts an out-of-order ledger insert
with `session_replication_role = replica` and fails unless the guard still blocks it. The automated
batch checks the same catalog invariants both before candidate SQL and immediately before the ledger
insert. A Docker-backed PostgreSQL proof executes the migration, confirms replica mode cannot bypass
the trigger, replaces it with `WHEN (false)`, and confirms the catalog verification fails closed.
