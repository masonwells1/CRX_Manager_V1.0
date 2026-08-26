## 2026-08-26 — fragment rules move to .claude/hooks/ and the surviving file is validated

Third review round on PR #482, three findings, one batch:

The entry predicate and content rules (ENTRY_RE, isAttemptedEntry, isRealCalendarDate,
entryContentVerdict, isCountableFragmentFile) now live in
`.claude/hooks/changelog-entry-lib.mjs` — the single source of truth for shared guard
logic — instead of `scripts/check-ledger-update.mjs`, which the stop hook had been
importing from in the wrong direction (CodeRabbit Major). The guard re-exports them, so
`scripts/assemble-changelog.mjs` and the test suite import unchanged; all 113 original
assertions passed untouched after the move, proving the delegation is faithful.

Two counted-without-validated holes in the stop hook's session-wrap check — the same
class as the quotePath fail-open — are closed: a DIRECTORY named like a fragment
satisfied the existence check (CodeRabbit, reproduced by its static analysis; now a
real `isFile()` stat), and an added fragment later truncated or emptied still counted
on its historical git-log record (Codex connector, reproduced; the surviving file's
content is now validated with the SAME shared rules the pre-commit guard applies —
heading, date-vs-filename, real calendar date, detail beneath). Stat runs first so a
stat failure and a content failure stay distinguishable diagnoses.

Proof: 120 assertions green; both new behaviors mutation-verified red→green (reverting
the stat to existence-only fails exactly the directory assertion; trusting empty content
fails the guard's own empty-entry assertion, demonstrating one shared code path now
serves both consumers).
