## 2026-09-27 — advance the manuals' ledger "Last verified" stamps to 2026-09-26

Codex's review of PR #820 (P2) found that `docs/manual/CURRENT_STATE.md` and `docs/manual/KNOWN_ISSUES.md`
recorded a verified 2026-09-26 ledger read in their update notes, but their leading `Last verified:` stamps
still said 2026-09-21. `scripts/check-doc-drift.mjs` reads that stamp as each manual's freshness date, so
it kept reporting both files as verified only through `20260921`.

Both stamps are scoped to the migration ledger, and the ledger was re-read on 2026-09-26: 1011 rows,
1004 distinct names, `max(version)` `20260926163005`, with `20260914100700` applied and only
`20260914100800` and `20260914100900` not applied. A 2026-09-27 re-read returned the same three figures.
Each stamp now leads with that read, and the 2026-09-21 figures are kept as history. The KNOWN_ISSUES
stamp's historical clause now says `100500` and `100600` "were then still not" applied, since both
applied on 2026-09-22.

**Proof observed:** `scripts/check-doc-drift.mjs` passes and reports both manual stamps as `20260926`;
`src/lib/rpcContracts.test.ts` (94 tests) passes.
