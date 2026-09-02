## 2026-09-02 - CodeRabbit round: four more mandatory-approval sites, and three records that outlived their code

CodeRabbit reviewed the frozen candidate `7d4c70fe4` and returned `CHANGES_REQUESTED` with three
actionable comments. All were real; all are fixed.

## 1. Approval was still mandatory in four places (Major)

The concept sweep in the two previous commits missed these because none of them use the words the
search matched. They stated the requirement structurally instead:

- `.claude/skills/deploy-check/SKILL.md` — a hard rule reading "NEVER merge without a CodeRabbit
  approval bound to the current candidate commit". Now: never merge over `CHANGES_REQUESTED`;
  approval is not required, but when one exists it must be bound to the candidate.
- `.claude/hooks/pr-merge-guard.mjs` — the `--admin` denial told the operator to "get a real
  approval… and merge only after it approves this head". That is the wrong recovery: with approvals
  removed, a green candidate with no objection merges on the ordinary path. Following the old text
  could strand a landing or buy an unnecessary paid review. The denial itself is unchanged — an
  agent still may never use `--admin`.
- `docs/reference/gotchas.md` — required the `APPROVED` `commit_id` unconditionally.
- `.agents/skills/deploy-check/SKILL.md` — regenerated from the source skill.

**This is the third round of the same miss inside one pull request.** Grepping a phrasing does not
sweep a concept. Recorded again because repetition is the point.

## 2. Two records described code this PR later deleted (Minor)

- `2026-09-02-approval-path-mergeability-and-doc-scope.md` documented a mergeability-polling fix on
  the **approval path** — a path removed later in this same PR along with its named regression test.
  It now carries a superseded-by note pointing at
  `2026-09-02-keep-review-events-out-of-the-privileged-gate.md`, and states what is still live: the
  label path's `getPullRequestWithResolvedMergeability()` polling.
- A comment in `coderabbit-final-review.test.cjs` explaining that same approval-path fix had been
  left stranded above an unrelated-label test. Removed.

## 3. A cross-reference to a test that does not exist (Minor)

The workflow header comment added in the previous commit cited a test named `no review event
triggers this privileged workflow`. No such test exists — the guards are
`no pull-request event other than pull_request_target triggers this privileged workflow` and
`the gate refuses to run on any event other than pull_request_target`. A comment naming a
non-existent test is exactly the "guard comments must not outclaim the tests" failure; both real
names are now cited.

## 4. A reset description that no longer matched the shipped code (Minor)

`2026-09-02-gate-doc-concept-sweep.md` still said a reset deletes the command for the superseded
head and leaves a still-current-head command alone. The shipped `deleteReviewCommands()` scopes
deletion by **authorship, not head** — a base edit, draft conversion, reopen or auto-merge change
invalidates the candidate with the head unchanged. Corrected, including the point that human
comments are left alone.

## Verification

- `node .github/scripts/coderabbit-final-review.test.cjs` — 86/86 pass.
- The reworded `--admin` denial was executed against live PR #516, not asserted: it still returns
  `permissionDecision: "deny"` and now names the ordinary merge path as the recovery.
- `node scripts/sync-agent-workflows.mjs --write` regenerated the `.agents` adapter.
