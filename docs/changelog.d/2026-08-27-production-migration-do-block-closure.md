## 2026-08-27 — Production migration DO-block closure

Exact-commit adversarial review proved that a PostgreSQL `DO` block could hide destructive SQL from
the automated production migration classifier. The gate now rejects every top-level `DO` block,
including otherwise read-looking blocks, because their procedural body can invoke mutating
functions or obscure destructive statements from static inspection.

Regression tests cover the reproduced comment-separated `DELETE FROM` bypass, a stored-function
call, dynamic SQL, and a nominally safe block. Migrations that require procedural `DO` logic must use
the separately reviewed manual migration path rather than this automated one-account gate.
