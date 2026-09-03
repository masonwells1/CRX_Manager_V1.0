## 2026-09-03 — the CodeRabbit final-review gate 403'd on every PR: it was one permission scope short

`coderabbit-final-review.yml` (landed in #516) failed on **every** pull-request
event in `CRX_Manager_V1.0` with:

```
##[warning]CodeRabbit final-review state reset could not clear ready-for-coderabbit
(Resource not accessible by integration); coderabbit-review-requested (Resource not
accessible by integration)
```

The standing CodeRabbit policy in `AGENTS.md` was therefore **silently not
running** — no PR got a review of its frozen candidate. PR #564 merged without
one. The gate is not a required check on `main` (required contexts are `Vercel`,
`Lint, Type Check, Test, Build`, `SQL Migration Validation`), so it went red
without blocking anything, which is why it went unnoticed.

**Files:** `.github/workflows/coderabbit-final-review.yml`,
`.github/scripts/coderabbit-final-review.test.cjs`

### Root cause

The workflow declared `issues: write` but `pull-requests: read`.

Labels are an issues-API resource, so `issues: write` *looks* sufficient — and
that reading is what sent the previous investigation down the wrong path. It is
wrong. GitHub's own permissions reference lists both label endpoints under the
**Pull requests** repository permission:

```
POST   /repos/{owner}/{repo}/issues/{issue_number}/labels          | write | UAT, IAT
DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}   | write | UAT, IAT
```

When the target number is a pull request, the *Pull requests* permission is what
governs. With `pull-requests: read` every `issues.removeLabel` call 403s, and
`removeLabelIfPresent` only swallows `404` — so the gate cannot even discover
that the label it wanted to clear was never there. `resetLabels` re-throws, and
the run dies on the first event it sees. Every event type in the trigger list
hits `resetLabels`, so this failed 100% of the time.

**Fix:** `pull-requests: write`. One line.

### What the previous diagnosis got wrong, and what was already fixed

Two earlier claims about this failure need correcting.

1. **`administration: read` is not required and was not added.** The open PR #563
   adds it, on the theory that the gate 403s earlier on
   `repos.getCollaboratorPermissionLevel`. It does not: GitHub's permissions
   reference lists `GET /repos/{owner}/{repo}/collaborators/{username}/permission`
   under **Metadata** read, which every workflow token holds unconditionally
   (`Metadata: read` is visible in the token group of every run log). The evidence
   also refutes it directly — every failed run's only error is the label write,
   and on `synchronize`/`edited` events the gate never reaches the collaborator
   check at all. That part of #563 can be dropped.

2. **The repository-level token ceiling was already raised.** It really was
   capped (`default_workflow_permissions: "read"`), and a workflow's
   `permissions:` block can only narrow from that ceiling. Mason raised it to
   `write` on 2026-09-02 with `can_approve_pull_request_reviews` left **false**,
   and run logs from 22:14 onward confirm `Issues: write` was actually granted —
   and still 403'd, which is what isolates the cause to the scope split above.

Debugging note for this class of bug: **re-running a failed run does not pick up
a permissions change.** A run's token scopes are fixed at creation, so the fix
only reaches a NEW run from a new event. Read the token permissions group at the
top of the job log rather than assuming.

### The guard

`the gate's own label and comment writes are actually granted` parses the
workflow's `permissions:` block and asserts `pull-requests: write` and
`issues: write`. It also pins the write surface **closed** — exactly those two
scopes and no others — because this job runs on the privileged
`pull_request_target` trigger.

Both halves were mutation-tested: downgrading `pull-requests` back to `read`
fails the test, and adding a stray `contents: write` fails it too.
