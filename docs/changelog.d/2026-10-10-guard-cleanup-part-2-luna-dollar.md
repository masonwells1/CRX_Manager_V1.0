## 2026-10-10 — guard cleanup, part 2: `$` inside SQL identifiers

Follows `2026-10-10-guard-cleanup-part-2-coderabbit.md`. Luna round on 54c85d141: 1 HIGH fixed, 4 LOW (3 already accepted there; 1 covered by a new test).

**Fixed**

- `live-testdata-lib.mjs`: PostgreSQL identifiers may contain `$`, but the schema and name boundaries used JavaScript's `\w`, which does not. So `x$auth.uid()` matched the `auth.uid()` exemption, `x$pg_catalog.fn()` matched `pg_catalog`, and `my$count(1)` was read as the built-in `count`. `$` now counts as part of an identifier at both boundaries, and those three are refused.
- LOW: the read-only `while read` loop and `i=$(($i+1)); git status` are now asserted to pass the real merge hook in `pr-merge-guard.test.mjs`, not only `expandNestedCommands()`.

**Proof observed**

- `classifySql` on the pushed head 54c85d141 versus this commit: the three `$` shapes go from allow to block; ordinary reads (an invoice query, `aclexplode`/`to_regprocedure`, `pg_get_function_identity_arguments`, `count`/`coalesce`) stay allowed.
- `npm run test:correction-guards` exits 0 (`guards` 197, `pr-merge-guard` 256 assertions).
