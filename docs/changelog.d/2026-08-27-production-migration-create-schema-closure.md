## 2026-08-27 — Production migration CREATE SCHEMA closure

Exact-commit adversarial review proved that PostgreSQL `CREATE SCHEMA` can embed grants and trigger
definitions inside one statement, bypassing top-level grant and trigger restrictions. Schema
creation is now excluded entirely from the automated DDL allowlist.

Regression tests cover both an embedded customer-table grant and an embedded trigger. Schema
creation remains available through the separately reviewed manual migration path.
