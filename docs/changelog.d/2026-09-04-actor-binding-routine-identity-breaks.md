## 2026-09-04 - Keep definer evidence across routine identity breaks

- The actor-binding guard no longer lets an ALTER on a replacement routine clear an earlier
  `SECURITY DEFINER` body after the original routine or schema was renamed, moved, or dropped.
- Failing-first and mutation controls cover rename/recreate, `SET SCHEMA`, routine drop, schema
  rename, and ordinary string-data text that must not be mistaken for executable identity DDL.
- Search-path state follows the same identity-break boundary; the broader best-effort cap remains.
