## 2026-09-03 — the review gate blocked on its own still-running check

Second defect found in the same never-executed code path, an hour after #573 fixed the
first. The gate refused every request with:

```
CodeRabbit final review was not requested: final-review-gate: in_progress/no conclusion
```

PR #563, run `33716013321`. Labels cleared, nothing posted.

**Files:** `.github/scripts/coderabbit-final-review.cjs`,
`.github/scripts/coderabbit-final-review.test.cjs`

### Cause

`collectCheckBlockers` enumerates every check run on the head commit, and
`evaluateChecks` blocks on anything not `completed`. The gate's **own** check run is
`in_progress` for exactly as long as it is doing the evaluating — so it always saw itself
as an unfinished check and always blocked. A deadlock by construction: the ready-label
path could never succeed, on any pull request, ever.

**Fix:** `collectCheckBlockers` takes `selfRunId` (`context.runId`, threaded through all
four call sites) and drops the check run whose `details_url` resolves to that run.

The exclusion is by **run id, never by name**. A run id identifies exactly one run, so
this cannot quietly excuse a different workflow that happens to share a job name — and a
second, concurrent run of this same workflow keeps its own id and is still treated as a
blocker, which is correct: that one really is a pending check.

The filter sits in `collectCheckBlockers`, not in `evaluateChecks`, so the shape guard
added by #574 still sees the raw list and a malformed entry is still reported rather than
silently filtered away.

### Why this is the second one

`collectCheckBlockers` is reached only on the `labeled` event carrying
`ready-for-coderabbit`. Until #570 the gate died earlier on label permissions; until #573
it crashed on a paginate mapFn. #563 is the first candidate in this repository's history
to get this far, so each fix simply exposes the next thing standing behind it. Expect that
pattern to continue until one request completes end to end.

### Proof

**Regression test with a control.** The new test gives the gate an `in_progress` check
belonging to its own run and requires `status === 'requested'`. The control gives it an
`in_progress` check from a *different* run id with the *same name* and requires that it
still blocks — without that, "ignore anything called final-review-gate" would satisfy the
first test while letting a genuinely unfinished check through.

**Mutation-tested.** Neutralizing only the exclusion (`selfRunId` forced to null):

```
=== MUTANT (self-run exclusion disabled) ===
ℹ pass 93  ℹ fail 1
KILLED — the suite fails with the mutant
…the failing test is the new self-block one.
```

Exactly one test fails and it is the right one — the mutation is detected precisely, not
by collateral damage. Suite: 94 pass.

### Not verifiable from this PR

`pull_request_target` loads the workflow and this script from the **default branch**, so
like #573 this cannot be exercised by its own pull request. It takes effect on the first
ready-label event after merge.
