## 2026-08-26 — unresolved Section 9 mutations coordinate across tabs and receiving screens

Exact-commit review proved that `sessionStorage` and screen-specific keys left a
duplicate-submit path after a lost response: closing the tab, opening another
tab, or switching receiving screens could mint a new key while the original
payment or inventory receipt may already have committed.

The shared uncertain-mutation hook now mirrors unresolved state in
`localStorage` so it survives a tab or installed-app restart, and uses an
IndexedDB read/write transaction as the authoritative per-actor operation
claim. Two simultaneous tabs cannot both claim a new request. The storage key
no longer contains the React screen or route; an exact canonical RPC payload
may transfer between surfaces under the original key, while any different,
expired, legacy, or malformed payload remains locked for manual reconciliation.
All six AP/receiving callers provide the exact database arguments used for that
comparison and block foreign-screen submissions before the RPC.

Proof: TypeScript, full lint, production build, documentation drift, and diff
hygiene pass; 7 focused files and 34 tests pass, including
PWA/tab reopen, missing-local-mirror recovery, an already-open second tab, a
simultaneous two-tab race, same-payload cross-screen transfer, different-payload
rejection, IndexedDB-unavailable fail-closed behavior, and the active Quick
Receive component. The full suite passes 342 files with 4,819 tests passed and
123 skipped. Exact-commit review remains pending. No live migration or data
mutation was performed.
