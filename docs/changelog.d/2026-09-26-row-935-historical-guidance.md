## 2026-09-26 — label row 935's pre-apply guidance as historical

CodeRabbit's review of PR #806 (Minor) found that migration-history row 935 led with **APPLIED LIVE
2026-09-26** but still read like current instructions further down: the pending-migration coupling,
the deploy order, and the closing "No live apply is authorized; this apply still needs Mason's
separate explicit in-chat approval."

The row's history banner now says everything after it is the pre-apply candidate record and that none
of its steps is pending. "Coupling" and "Deploy order" are labeled historical, and the closing
sentence now reads as historical pre-apply status. The facts are unchanged.

**Proof observed:** `localCandidateMigrationPathsFromHistory()` still returns only `20260914100800` and
`20260914100900`. `src/lib/rpcContracts.test.ts` (94 tests), all 53 top-level hook and script tests,
and `scripts/check-doc-drift.mjs` passed.
