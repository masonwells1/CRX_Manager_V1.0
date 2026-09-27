## 2026-09-26 — supersede stale "not applied" status for the 09-14 commission cohort

The Codex GitHub review of PR #799 (P2) found older passages that still described the now-live
`20260914100200`–`20260914100600` commission follow-ups as unapplied candidates:

- `docs/manual/CURRENT_STATE.md`, the six-follow-up paragraph and the PR #592 note ("none is
  applied").
- `docs/manual/KNOWN_ISSUES.md`, the commission-candidate paragraph and its "until … applied" risks.
- `docs/reference/rpc-functions.md`, the `get_commission_balance_report` entry, which called
  `20260914100600` a local candidate.

The historical prose is kept. Each stale passage gains a dated "Superseded 2026-09-26" note naming
what applied live and when (`100100`–`100400` on 2026-09-21, `100500`–`100600` on 2026-09-22,
`100700` on 2026-09-26) and stating that only `20260914100800` and `20260914100900` remain
unapplied. The RPC reference entry now reads APPLIED LIVE 2026-09-22 with ledger version
`20260922020038`.

**Proof observed:** `scripts/check-doc-drift.mjs`, `src/lib/rpcContracts.test.ts` (94 tests), and all
53 top-level hook and script tests passed. `localCandidateMigrationPathsFromHistory()` returns only
the two unapplied files.
