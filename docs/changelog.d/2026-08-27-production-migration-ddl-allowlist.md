## 2026-08-27 — Production migration DDL allowlist

Exact-commit adversarial review proved that a migration could define a destructive function and
invoke it through `VALUES`, `CREATE TABLE AS`, or `COPY`, even though direct `SELECT`, `CALL`, and
dynamic SQL were blocked. The automated path now admits only a narrow audited set of
definition-only DDL statements and rejects every unknown or query-executing top-level form.

Regression coverage includes the exact function-plus-`VALUES` deletion exploit, CTAS, `COPY`, a
materialized view, a data-modifying CTE, and `INSERT`. Complex migrations outside this safe subset
remain available only through the separately reviewed manual migration process.
