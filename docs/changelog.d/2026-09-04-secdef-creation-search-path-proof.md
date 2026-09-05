## 2026-09-04 - SECURITY DEFINER creation search-path proof

- Refuse migration proof generation for every `SECURITY DEFINER` function or procedure creation form unless it declares the fixed `public, pg_temp` search path. ACL revokes alone cannot prevent owner-context object shadowing.
- Expanded the RLS reviewer charter and correction-guard regression tests to cover plain `CREATE FUNCTION`, `CREATE PROCEDURE`, and `CREATE OR REPLACE PROCEDURE` forms, including a widened-path negative case.
- Treat quoted identifiers as data rather than configuration while detecting that path, so a routine signature or output-column name cannot impersonate the required directive.
- Reject duplicate, quoted, and `FROM CURRENT` path settings, so a safe-looking initial path cannot be overridden later in the routine declaration.
- Refuse proof generation on ownership transfers, `REASSIGN OWNED`, or direct PostgreSQL system-catalog writes because source-level ACL evidence cannot safely model their effective privileges.
