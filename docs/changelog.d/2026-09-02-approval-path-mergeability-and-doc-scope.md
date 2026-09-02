## 2026-09-02 — the approval path can no longer destroy a valid approval, and three docs stop describing superseded behaviour

Two Codex findings on the synced head, both real, both inside this PR's own surface.

> **Superseded later in this same PR (2026-09-02).** The approval path described below no longer
> exists. `pull_request_review` was removed as a trigger because it sources the workflow YAML from
> the pull request rather than the default branch, and the unreachable handler
> (`runReviewAuthorization()`, `blockCodeRabbitAuthorizationAndReconcile()`,
> `blockCodeRabbitAuthorizationAndReset()`) plus its 19 tests were deleted — see
> `2026-09-02-keep-review-events-out-of-the-privileged-gate.md`. The named regression test
> `a transient unknown mergeability does not destroy an exact-head approval` went with it. The
> **label** path's `getPullRequestWithResolvedMergeability()` polling, which this entry compares
> against, is still live and still correct. This entry is kept as the record of why the fix was
> made, not as a description of current code.

### A transient mergeability state could destroy an exact-head approval (P2)

The label path resolves mergeability through `getPullRequestWithResolvedMergeability()`, which polls
past GitHub's mid-recalculation window. The **approval** path took a bare `pulls.get`. Catching
GitHub with `mergeable: null` / `mergeable_state: 'unknown'` made `validateAuthorizationState()`
report a blocker — and on that path a blocker runs
`blockCodeRabbitAuthorizationAndReset()`, which **deletes the posted command and both labels**.

So a valid, exact-head CodeRabbit approval could be thrown away by a transient GitHub state, forcing
a second paid review. At a 2-reviews-per-hour org ceiling that is 30 minutes of fleet capacity lost to
a race. The approval path now polls exactly as the label path does; the two paths have to agree about
what a live snapshot is.

Regression test `a transient unknown mergeability does not destroy an exact-head approval`, and it is
mutation-proved: dropping the poll to a single attempt turns it red.

### Three docs still described the head-scoped deletion this PR replaced (P2)

`AGENTS.md`, `.claude/commands/ship.md` and `.claude/skills/deploy-check/SKILL.md` each stated that a
reset deletes the command "for the superseded head" and that a command for the still-current head is
never deleted. That was true of the *first* version of the deletion fix and false of the shipped one:
deletion is unconditional, because a base edit, draft conversion, reopen or auto-merge change
invalidates the candidate with the head **unchanged**, which is precisely why head was the wrong thing
to scope by. Left as written, the guidance would have told an operator a normal command is safe when
it is about to disappear.

All three now say deletion happens whether or not the head moved, and that scoping is by
**authorship** — Actions-authored comments whose body exactly equals the canonical command — so human
comments and a human-typed `@coderabbitai review` are untouched.

**This is the third round of the same failure on this PR**, and worth naming rather than quietly
fixing: I wrote those sentences during the concept sweep that was supposed to catch exactly this, then
changed the behaviour underneath them in the very next commit. The sweep is not a one-time pass — it
has to be re-run against the *final* diff, not the diff as it stood when the sweep was performed.
