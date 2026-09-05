## 2026-09-04 - SECURITY DEFINER creation search-path proof

- Refuse migration proof generation for every `SECURITY DEFINER` function or procedure creation form unless it declares the fixed `public, pg_temp` search path. ACL revokes alone cannot prevent owner-context object shadowing.
- Expanded the RLS reviewer charter and correction-guard regression tests to cover plain `CREATE FUNCTION`, `CREATE PROCEDURE`, and `CREATE OR REPLACE PROCEDURE` forms, including a widened-path negative case.
- Treat quoted identifiers as data rather than configuration while detecting that path, so a routine signature or output-column name cannot impersonate the required directive.
- Reject duplicate, quoted, and `FROM CURRENT` path settings, so a safe-looking initial path cannot be overridden later in the routine declaration.
- Refuse proof generation on ownership transfers, `REASSIGN OWNED`, or direct PostgreSQL system-catalog writes because source-level ACL evidence cannot safely model their effective privileges.
- Normalize PostgreSQL-equivalent lower-case quoted routine names and `pg_catalog` built-in argument-type spellings during ACL tracking, so an alternate spelling cannot grant anonymous execution to a tracked owner-privileged routine.
- Refuse proof generation when an executable SECURITY DEFINER body changes `search_path`, resets settings, or calls `set_config` with a search-path or dynamically computed setting name.
- Inspect every executable `DO`, function, and procedure body before it is blanked, and reject role, ownership, or PostgreSQL-catalog mutations there as well as at the migration top level. Quoted catalog identifiers are normalized so `"pg_catalog"."pg_proc"` cannot evade that check.
- Preserve complete named dollar-quoted routine bodies in review history, reject additional system-catalog mutation forms (`MERGE`, `TRUNCATE`, and `COPY`), and literal-escape routine names when finding application RPC callers.
- Refuse source-only proof for SQL-standard inline `RETURN` SECURITY DEFINER bodies until their executable boundary is parser-modeled; fingerprint the RPC caller matcher with reviewer evidence and recognize static whitespace, comment, optional-call, bracket-access, and template-literal RPC call forms.
