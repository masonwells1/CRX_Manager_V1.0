## 2026-09-02 — the new final-review gate 403'd on every PR; it was missing one permission scope

`coderabbit-final-review.yml` (PR #516, landed earlier the same day) failed on
**every** pull request in the repo with `Resource not accessible by integration`,
observed on #563 and #561. No review was ever requested, and the gate could not
even remove its own labels afterwards, so each PR was left red with stranded
workflow labels.

**Files:** `.github/workflows/coderabbit-final-review.yml`

### Two separate causes, in order

**1. The repository capped every workflow token at read-only.**

```
GET /repos/masonwells1/CRX_Manager_V1.0/actions/permissions/workflow
{"default_workflow_permissions":"read"}
```

A workflow's `permissions:` block can only narrow from that ceiling, never raise
it, so the workflow's declared `issues: write` was silently downgraded. Mason
approved raising the ceiling to `write` on 2026-09-02;
`can_approve_pull_request_reviews` was deliberately left **false**, so workflows
can manage labels and comments but still cannot approve a pull request.

Note for anyone debugging this class of bug: **re-running a failed run does not
pick up the change.** GitHub fixes a run's token permissions at run creation, so
the fix only reaches a NEW run from a new event. Confirm by reading the job's
"GITHUB_TOKEN Permissions" group in the log rather than assuming.

**2. The workflow never declared `administration: read`.**

Raising the ceiling was necessary but not sufficient — a fresh run showed
`Issues: write` correctly granted and still 403'd. The denied call is
`repos.getCollaboratorPermissionLevel` (`.github/scripts/coderabbit-final-review.cjs:671`),
which the gate uses to verify the actor who applied `ready-for-coderabbit`
actually holds write or admin. That endpoint requires `administration: read`,
which was not in the permissions block, so the gate died on its own security
check before doing any work.

### Why granting it is safe here

`administration: read` is read-only, and although `pull_request_target` is the
privileged trigger, this job checks out **only** the default branch with
`persist-credentials: false` and never fetches or executes the pull request's
code — so no untrusted code runs with the token.

### Scope note

This fix rides along on PR #563 rather than arriving as its own change: #563
could not land without it. A failing `final-review-gate` leaves
`mergeStateStatus=UNSTABLE`, and `pr-merge-guard.mjs` requires `CLEAN` — so the
guard correctly refused to merge #563 over an unrelated broken workflow, and
weakening that check to get the change in was not an option.
