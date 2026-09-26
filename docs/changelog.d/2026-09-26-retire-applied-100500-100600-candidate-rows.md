## 2026-09-26 — mark migration-history rows 920 and 922 as applied

The Codex GitHub review of PR #799 (P2) found that rows 920 (`20260914100500`) and 922
(`20260914100600`) still began **LOCAL CANDIDATE — not applied**, although both applied live on
2026-09-22 (ledger versions `20260922015509` and `20260922020038`, confirmed by name in a read-only
ledger read on 2026-09-26). `localCandidateMigrationPathsFromHistory()` therefore still returned both
SQL files, so `/fleet` and worktree-awareness treated two live migrations as pending.

Both rows now lead with **APPLIED LIVE 2026-09-22**, matching rows 914 and 917–919. The SQL files are
untouched. The helper now returns only `20260914100800` and `20260914100900`, the two migrations
that are really still unapplied.

**Proof observed:** the helper's output before the change listed four paths and after it lists two.
`src/lib/rpcContracts.test.ts` (94 tests), all 53 top-level hook and script tests, and
`scripts/check-doc-drift.mjs` passed.
