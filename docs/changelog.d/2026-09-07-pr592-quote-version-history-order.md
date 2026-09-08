## 2026-09-07 - Keep quote version history in saved order when a newer version is unreadable

The exact-SHA Codex review of `410440bc4` found a P2 in the version-history list this PR added to
`src/pages/QuoteBuilder.tsx`. `adaptQuoteVersionList` splits the server's single
`version_number`-descending result into two arrays, because a snapshot this build cannot read must
render without an item count or a total and must not be selectable. The page then rendered
`quoteVersions.map(...)` followed by `unreadableQuoteVersions.map(...)`, which puts **every**
unreadable row below **every** readable one. A quote whose newest saved version is unreadable
therefore displayed as v2, v1, v3 — a version history asserting an order the data does not have,
which is the one claim the list exists to make.

`orderedQuoteVersionHistory` in `src/lib/quoteVersionAdapter.ts` merges the two buckets back into a
single newest-first list of discriminated entries, and the page renders that one list, branching on
`entry.readable` for the two row shapes. `sent_at` then `id` break ties only so the order is total
and stable; `version_number` is unique per quote, so those tie-breaks are not expected to decide
anything. The two state arrays stay separate, because restore, the compare view and
`reportUntrustworthyQuoteVersions` must still only ever see the readable ones.

Proven by mutation, not by reading. With the merge reverted to the old concatenation, the new
rendered test fails with `expected [ 'v2', 'v1', 'v3' ] to deeply equal [ 'v3', 'v2', 'v1' ]` — the
exact symptom Codex described — and three `orderedQuoteVersionHistory` unit tests fail with
`[ 2, 1, 3 ]`, `[ true, false ]` and `[ 4, 2, 3, 1 ]`. All six pass with the merge in place.

The rendered test drives the real page against a mocked `quote_versions` read of an unreadable v3
above a readable v2 and v1, and asserts the version labels in DOM order. It also guards its own
fixture: if all three rows landed in one bucket the ordering claim would be vacuous, so it asserts
exactly one row reads "Saved in an older format" before checking the order.

The source-text assertion in `quoteVersionAdapter.test.ts` now pins the page to the merged path
(`orderedVersionHistory.map` present, `unreadableQuoteVersions.map` absent) rather than to the
sequence that caused the defect. `legacyFlatRow` moved to module scope so both suites share it; its
body is unchanged.

Verified: `tsc --noEmit` exit 0, `eslint` clean on all four changed files, full Vitest suite 359
files / 5,122 passed / 123 skipped. No migration applied, no live data changed, no migration SQL
edited.
