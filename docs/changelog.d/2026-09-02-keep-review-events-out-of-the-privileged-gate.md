## 2026-09-02 - Keep review events out of the privileged CodeRabbit gate

Mason approved removing the `pull_request_review` trigger from
`.github/workflows/coderabbit-final-review.yml` on 2026-09-02, after the flaw below was proven on
this pull request rather than argued about.

## The defect

The workflow's stated safety property is that it never runs pull-request code: it holds
`issues: write`, and that is only defensible because `pull_request_target` sources the workflow YAML
from the **default branch**. The job's first step checks out the trusted default branch precisely to
honour that.

`pull_request_review` does not behave that way. It sources the YAML from **the pull request's own
ref**. The default-branch checkout does not rescue it, because the step performing that checkout
would itself come from the pull request. A PR editing this workflow could therefore run its own
steps with this job's write token on any submitted review, bypassing the frozen-head, required-check
and one-shot validations the gate exists to enforce.

## Proven, not theorised

`.github/workflows/coderabbit-final-review.yml` did not exist on `main` at all, and a run of it
still appeared and succeeded:

```
event=pull_request_review
head_sha=8ddcd9aeea...                              # this PR's commit
head_branch=codex/coderabbit-ready-label-20260830   # this PR's branch
path=.github/workflows/coderabbit-final-review.yml
conclusion=success
```

A file absent from `main` cannot have come from `main`.

Two automated reviewers disagreed here and the run settled it: the GitHub Codex connector rated it
P1, while the `write-codex-push-proof.mjs` CLI review returned CLEAN — the CLI reviewer verified the
`pull_request_target` path ("executes only trusted default-branch code") and generalised to the
whole workflow.

## Blast radius, stated honestly

Limited in this repository. Only Mason and his agents can push branches here, and anyone who can do
that could already edit labels and comments directly. The fork case was not fully verified. This is
"a security gate whose stated guarantee is false on one path", not a live break-in route — which is
why it was fixed before merge rather than treated as an incident.

## What changed

- The `pull_request_review` trigger is gone; the workflow is `pull_request_target`-only, with a
  header comment recording why and pointing at the proof.
- `run()` now **fails closed** on any other event rather than silently reconciling, so re-adding a
  trigger alone cannot revive the path.
- The unreachable review-authorization code is deleted: `runReviewAuthorization()`,
  `blockCodeRabbitAuthorizationAndReconcile()`, `blockCodeRabbitAuthorizationAndReset()`, the
  `CODERABBIT_BOT_LOGIN` constant, the export, and the 19 tests that covered it. Net −908/+65 lines.
  Git history keeps it if the feature is ever rebuilt behind a default-branch-sourced mechanism.

## Why losing the feature costs little

That path re-validated gate state when a review was submitted — largely policing approvals. Mason
removed the required approving review from `main` earlier the same day (#559), so it was already
close to vestigial.

## Two hard guards, both mutation-tested

Prose would not have caught this, so the rule is encoded twice:

- `no pull-request event other than pull_request_target triggers this privileged workflow` parses the
  workflow's `on:` block and asserts the trigger list is exactly `['pull_request_target']`.
  Re-adding `pull_request_review` to the YAML turns it red.
- `the gate refuses to run on any event other than pull_request_target` drives `run()` with a review
  event and asserts it blocks, names the reason, and touches no labels or comments. Neutering the
  event check turns it red.

Each mutation kills exactly its own test and no other. 86/86 pass.
