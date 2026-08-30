## 2026-08-28 - Production migration SQL scanner Unicode boundary

- Made the reviewed production-migration scanner fail closed for every non-ASCII character immediately before a dollar sign. This prevents PostgreSQL identifier punctuation from impersonating a dollar-quoted string and concealing destructive SQL.

No production migration, live data, secret, or GitHub environment setting was changed.
