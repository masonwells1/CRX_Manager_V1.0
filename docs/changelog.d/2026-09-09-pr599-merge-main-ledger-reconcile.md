## 2026-09-09 - PR #599 merge-main ledger reconciliation

Merged current `origin/main` into PR #599 (re-done on 2026-09-10 on top of the PR head `542bd84a3` and main `9a648f566`) while preserving both sides of the shared ledger documents. Renumbered only PR #599's colliding ledger rows to 924-926; row 926 carries the PR head's applied-live record for the preview-season migration (applied 2026-09-08 as version `20260908045843`).

The preview-season migration file is kept byte-identical to the bytes applied live (sha256 `3f0860c98a41d857a6af37576140bd4f29aba48d1112d51bf712f934226808c4`). Its `-- STATUS: NOT APPLIED` header is left as-is, matching every other applied migration on main; the ledger row is authoritative. A live read-only `pg_proc` check on 2026-09-10 confirmed the installed function takes five arguments and its body md5 is `83f6600412ced085d0876a3c7339ff12`, equal to the postflight pin.

Local verification on the merged tree: `check:docs`, `test:correction-guards`, `typecheck`, `lint`, `build`, the migration hard-rules check, and `vitest run --coverage` (373/373 files, 5,242 tests) all pass. No database write occurred in this worktree.
