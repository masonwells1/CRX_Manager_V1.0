## 2026-09-05 - Keep the commission date guard compatible with safe apply

- Removed self-managed transaction statements from the source-only commission payment business-date migration.
- The guarded migration apply tool supplies the atomic transaction, so the migration keeps its local lock timeout while remaining eligible for the repository's required apply path.
- A regression test now rejects top-level transaction control in this migration. It remains unapplied and requires fresh approval and apply gates.
