## 2026-09-26 — retire obsolete apply instructions and stale "current boundary" claims

The fourth Codex GitHub review of PR #799 (two P2s) found instructions that still treated finished
work as outstanding. A repository-wide sweep for the same pattern found three more. All are fixed:

- `DEPLOYMENT.md` said the customer-document migration must stay pending behind the Edge Function
  and told operators to apply it after the merge and handle its `PREFLIGHT_OBJECTS` refusal. It now
  says the migration applied live on 2026-09-26 and must not be re-applied, and that the
  `customer-document-files` function must stay deployed because it is the only path for those files.
- `CURRENT_STATE.md` "Last verified" block still called `20260911120000` the current high-water and
  told candidates to sort above it. It is now marked superseded and points to the current
  `20260914100700` boundary. The dated 09-14 re-read note no longer says the 09-20 row "now holds the
  boundary".
- `KNOWN_ISSUES.md`: the resolved customer-document entry's "Still owed" list now records all three
  steps as done. The issue-#617 entry no longer calls `20260911120000` the current high-water or the
  09-14 cohort "clear to apply".

**Proof observed:** `scripts/check-doc-drift.mjs`, `src/lib/rpcContracts.test.ts` (94 tests), and all
53 top-level hook and script tests passed.
