## 2026-08-28 - Production migration SQL scanner boundary

- Prevented the reviewed production-migration batch scanner from treating dollar signs inside PostgreSQL identifiers as dollar-quoted strings. This closes a destructive-SQL hiding path, including a non-ASCII identifier regression case.

No production migration, live data, secret, or GitHub environment setting was changed.
