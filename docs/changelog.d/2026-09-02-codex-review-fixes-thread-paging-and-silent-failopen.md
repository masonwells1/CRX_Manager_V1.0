## 2026-09-02 — Codex review round on the App-review gate: page the thread read, end the Codex guard's silent fail-open

Follow-up to `2026-09-02-read-the-codex-github-app-review.md`, from the exact-SHA
`gpt-5.6-sol` proof review of that change (verdict CLEAN, three findings). Two are
fixed here rather than shipped as documented residuals; the third is filed.

**Files:** `.claude/hooks/codex-bot-review-lib.mjs`, `.claude/hooks/codex-bot-review-lib.test.mjs`, `.claude/hooks/pr-merge-guard.mjs`, `.codex/hooks/production-action-guard.mjs`, `scripts/apply-live-testdata-maintenance-20260812.mjs`

### CRX-REV-002 (Low) — fixed: the thread read took one page

100 is GitHub's per-page maximum for `reviewThreads`, so "read more" means paging,
not a bigger number. On a PR with more threads than that, the single unresolved
thread that matters could sit on a page nobody fetched — and the gate would report
"nothing standing" while something was standing. That is the failure mode this
whole feature exists to remove, reintroduced one layer down.

`collectCodexThreads()` now walks up to `CODEX_THREAD_MAX_PAGES` (3 = 300 threads;
the largest PR on this board carries 48), which bounds the worst case to three API
calls inside a hook that has to answer quickly. It stops on `hasNextPage:false`, on
an empty `endCursor`, and on a cursor that repeats — so a server claiming another
page without advancing cannot spin it. A failed page ends the walk while keeping
what was already read; a total failure reads as `none`, never as a block.

### CRX-REV-003 (Low) — fixed: one guard failed open silently

The Codex-side guard failed open **silently** where the Claude side printed a
notice. Silence there is indistinguishable from "the reviewer had nothing to
say" — precisely the confusion being removed. Both guards now print the same three
non-blocking notices, and the test suite pins the notice count on **both** files so
they cannot drift apart again.

### CRX-REV-001 (Medium) — filed, not fixed

With `--auto`, GitHub merges after this gate has already run, so a finding posted
in the interval is never seen. Bounded in practice: `--auto` is already denied
outright for risky diffs. Closing it properly means making the exact-head Codex
review a required GitHub check — separate work, recorded here rather than left
implicit in the code.

### Verification

- 83 unit assertions, up from 62. New coverage: a standing finding on page **two**
  is still found; paging stops on each of the three terminating conditions; a
  partial fetch keeps what it read; a total fetch failure reads as `none`.
- 10/10 mutation tests still caught.
- Live-PR proof re-run after the paging change: #556 and #544 still deny with this
  gate's own message, #361 still emits the `none` notice, #516 is still correctly
  taken by the earlier `CHANGES_REQUESTED` gate.
- `typecheck`, `lint`, `test:correction-guards`, `test:agent-workflows` green.
  Codex guard protected-blob pins re-pinned.
