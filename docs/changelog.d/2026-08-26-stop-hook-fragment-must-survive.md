## 2026-08-26 — a changelog fragment only counts if it still exists

Closing the last open CodeRabbit finding on PR #482's stop hook: the session-wrap ledger
check read added fragments out of the session's `git log`, so a session that ADDED a
`docs/changelog.d/` entry and later deleted or reverted it still passed — the historical
"A" record satisfied the check while no record remained for anyone to read. An added
fragment now also has to exist in the working tree, the state the next session actually
inherits.

Also fixed in the same pass: a duplicated word in the
`2026-08-26-ledger-test-corrupted-the-repo` fragment ("the new new git-spawning test").
The remaining review threads were verified as already addressed by earlier commits on
this branch (malformed-fragment precedence, hidden-file allowlist, heading syntax,
stop-hook ADDED requirement, SAFE_DEVELOPMENT_RULES row) and answered on the PR; the
heavily-edited-rename thread is answered with the boundary rationale rather than code —
a rewrite beyond git's similarity threshold is majority-new content, which is a new
record, and the dated-heading and rename/byte-identity checks still hold.
