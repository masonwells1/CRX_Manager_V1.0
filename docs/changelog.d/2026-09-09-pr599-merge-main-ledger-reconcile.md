## 2026-09-09 - PR #599 merge-main ledger reconciliation

Merged current `origin/main` into PR #599 while preserving both sides of the shared ledger documents. Renumbered only PR #599's colliding ledger rows and reconciled the preview-season migration's stale local-candidate status to the incoming live-ledger record: applied on 2026-09-08 as version `20260908045843`.

The migration SQL body was not changed. Full local verification is recorded with the merge commit; no database access or remote publication occurred in this worktree.
