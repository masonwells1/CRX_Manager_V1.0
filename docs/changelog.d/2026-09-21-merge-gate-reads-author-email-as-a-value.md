## 2026-09-21 - The merge gate reads `--author-email` as taking a value

The merge reader listed `-A` as value-taking but not its long form,
`--author-email`. So in `gh pr merge 123 --author-email --disable-auto --squash`
it read the value as a cancellation, and the Codex guard stood down: no green-check,
objection, risky-diff or exact-SHA proof check ran for a real merge. The same gap
could promote the address to the PR selector. Main refuses the command.

Both option lists were re-checked in full against gh's manual on 2026-09-21. For
`gh pr merge` the value-taking long options are `--author-email`, `--body`,
`--body-file`, `--match-head-commit`, `--repo` and `--subject`, and the short list
`-A -b -F -t -R` already matched. For `gh api` the lists added earlier the same day
already matched the manual. `gh api` long options are now matched regardless of
case, as the merge reader's already were.

Locked in by assertions in `.claude/hooks/pr-merge-guard.test.mjs` and an
end-to-end test in `.codex/hooks/production-action-guard.test.mjs` proving the
merge reaches the gate.

Found by the `gpt-5.6-sol` exact-SHA review of `7e547a609` (HIGH) on PR #630.
