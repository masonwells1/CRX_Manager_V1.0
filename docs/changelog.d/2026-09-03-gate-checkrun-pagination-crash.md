## 2026-09-03 — the CodeRabbit gate crashed the first time any PR reached the review path

`coderabbit-final-review.yml` requested a review for the first time since #516 landed,
and died: `Cannot read properties of undefined (reading 'app')` (PR #563, run
`33707346152`). The gate cleared its labels and posted nothing.

**Files:** `.github/scripts/coderabbit-final-review.cjs`,
`.github/scripts/coderabbit-final-review.test.cjs`

### Cause — a paginate mapFn that reads a property off an array

```js
github.paginate(
  github.rest.checks.listForRef,
  { owner, repo, ref: headSha, filter: 'latest', per_page: 100 },
  (response) => response.data.check_runs,   // ← always undefined
)
```

`checks.listForRef` returns a **namespaced list envelope**, `{ total_count, check_runs }`.
Octokit's paginate normalizes that *before* the mapFn runs:
`normalizePaginatedListResponse` replaces `response.data` with the inner array itself.
So `response.data.check_runs` reads `.check_runs` off an **Array**, yields `undefined` for
every page, and paginate concatenates those into `[undefined, …]`.

The first code to touch an element is `check.app?.id` in
`attachRequiredWorkflowProvenance` — optional chaining protects `app`, not `check` — so
the gate threw on the array's first entry.

**Fix: drop the mapFn.** Paginate already returns the flattened array for this endpoint.

### Why nothing caught it for four days

Two independent reasons, and both matter:

1. **The path had never run.** `collectCheckBlockers` is reached only on the `labeled`
   event carrying `ready-for-coderabbit`. Every earlier run took the reset/reconcile path
   and returned before it. Between #516 landing and today the gate was also failing
   repo-wide on label permissions (fixed by #570), so no candidate ever got far enough to
   request a review. **The CodeRabbit policy had never actually executed end to end.**
2. **The test mock encoded the wrong contract.** The suite's `paginate` handed the mapFn
   the raw envelope, so `response.data.check_runs` looked correct there and returned
   `undefined` in production. A mock that models a contract that does not exist cannot
   catch a bug caused by that contract — this is the failure mode where a test
   rubber-stamps the same misunderstanding that produced the defect.

The mock now models Octokit's real behaviour, `total_count` and normalization included,
and `checks.listForRef` returns the real envelope. Both halves are required: an envelope
without `total_count` would not trip normalization, and the mock would quietly go back to
modelling fiction.

### Proof

**Exact reproduction**, driving a faithful Octokit-normalizing paginate:

```
shipped (no mapFn) -> ["Lint, Type Check, Test, Build"]
buggy   (mapFn)    -> [null]
shipped: OK, 1 candidate(s)
buggy  : THREW -> Cannot read properties of undefined (reading 'app')
```

The mapFn form throws the production error **verbatim**; the shipped form does not.

**Mutation-tested.** Restoring the broken mapFn against the corrected mock fails **27**
tests. The same mutant is what `main` ships today, and `main`'s CI is green — so the
before/after is not a claim, it is observable: 87/87 passing with the old mock, 61/88 with
the new one.

### Not verifiable from this PR

`pull_request_target` loads both the workflow and this script from the **default branch**,
so the fix cannot be exercised by its own pull request. It takes effect on the first
ready-label event after merge. The reproduction above is the substitute, and it is exact
rather than approximate.
