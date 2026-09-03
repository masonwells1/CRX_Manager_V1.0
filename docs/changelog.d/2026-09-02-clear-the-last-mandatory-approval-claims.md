## 2026-09-02 - Clear the last "approval is mandatory" claims from the operator guides

Second Codex finding on this branch's exact head, after the `AGENTS.md` fix in the previous commit:
"Several workflow guides still say formal approval is mandatory, contrary to the updated project
policy. This is operationally conservative, not a security bypass."

Correct. Fixing `AGENTS.md` alone left the same false claim in three of the guides an agent actually
reads before merging — and all three are files this branch already edits:

- `.claude/commands/ship.md` — said "formal GitHub approval remains mandatory", ended the landing
  sequence at "verify CodeRabbit's formal exact-head approval → merge", and asserted "GitHub
  requires one current approval, dismisses it after a new commit, and requires approval from
  someone other than the last pusher."
- `.claude/skills/codex-review/SKILL.md` — told the reader to "verify live `main` protection still
  requires current approval with stale-review dismissal" and called CodeRabbit's approval "the
  normal merge-unlock path."
- `.agents/skills/codex-review/SKILL.md` — the generated Codex adapter of the same file.

None of that is true since #559 removed `required_pull_request_reviews` from `main` on 2026-09-02.
The instruction to "verify protection still requires current approval" is worse than merely stale:
it is a check that now fails by design, and the decision log already records two sessions reading
that requirement and drawing the wrong conclusion.

All three now state that an approving review is **not** required and that CI is the merge gate,
while keeping what did not change: `CHANGES_REQUESTED` still blocks, both agent merge gates still
refuse to merge over one, CodeRabbit must still actually review the frozen candidate (a green
status row is not review proof), an approval that does exist must still have `commit_id` equal to
`headRefOid`, and risky diffs still need the exact-SHA `gpt-5.6-sol` proof.

The `.agents/` copy was regenerated with `node scripts/sync-agent-workflows.mjs --write`, not edited
by hand. `npm run test:agent-workflows` passes, including "Codex workflow adapters match Claude
sources - 37 Codex workflow file(s) match."

## Still open, deliberately

Codex's other non-blocking observation stands and is NOT addressed here: the new privileged workflow
pins `actions/checkout@v7` and `actions/github-script@v8` by mutable major-version tags rather than
commit SHAs. Codex rated it Low and the token scope is limited to PR labels/comments plus read
access. Re-pinning a brand-new `pull_request_target` workflow's actions is a change that can break
the workflow on its first real run, so it is tracked as a follow-up rather than bundled into the
candidate this PR is trying to freeze.
