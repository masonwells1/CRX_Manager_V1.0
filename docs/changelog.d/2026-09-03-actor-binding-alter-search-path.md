## 2026-09-03 — Actor-binding guard tracks final routine search path

Exact-SHA review reproduced a forged-actor path where a safe-looking
`SECURITY DEFINER` creation was followed by `ALTER FUNCTION ... SET
search_path = evil, pg_catalog`. The previous guard evaluated UUID equality
operator safety only from CREATE attributes and allowed the later override.

The guard now carries search-path state across matching same-file ALTER
statements. It handles explicit and quoted `SET search_path`, `SET ... FROM
CURRENT`, `RESET search_path`, and `RESET ALL`; unknown inherited state and
rollback-sensitive safe overrides fail closed.

Regression tests cover the reproduced malicious operator path, quoted SET and
RESET forms, both reset forms, FROM CURRENT, and a final safe override. The
exploit failed before the repair, passes after it, and fails again when later
ALTER search-path state is deliberately disabled. The broader best-effort
actor-analysis cap remains unchanged.
