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
the fix only reaches a NEW run from a new event. Confirm by reading the workflow
token's permissions group at the top of the job log rather than assuming.

(That group is named after the Actions token environment variable. This entry
deliberately does not spell that name out — see
`2026-09-02-review-capture-redacts-on-token-names.md` for why writing it here
blinded the review harness.)

**2. The workflow declared `pull-requests: read`, and its labels live on a PR.**

Raising the ceiling was necessary but not sufficient — a fresh run showed
`Issues: write` correctly granted and still 403'd. GitHub gates the
`/issues/{n}/labels` endpoints on the **Pull requests** permission whenever the
target number is a pull request, so `issues: write` alone does not reach them.
`#570` fixed this by moving that scope to `pull-requests: write`.

### Correction — this branch first blamed the wrong scope

Cause 2 was originally recorded here as a missing `administration: read`, needed
by `repos.getCollaboratorPermissionLevel`
(`.github/scripts/coderabbit-final-review.cjs:671`). **That was wrong**, and the
logs say so plainly. Every observed failure — runs `33702506753`, `33701849744`,
`33700442498`, `33700095181`, `33699009201`, `33702436849` — names the label
endpoints, not the collaborator-permission endpoint:

```
workflow label reset failed for ready-for-coderabbit (Resource not accessible by
integration); coderabbit-review-requested (Resource not accessible by integration)
```

`getCollaboratorPermissionLevel` is reached only on the `labeled` event carrying
`ready-for-coderabbit` (`coderabbit-final-review.cjs:648-671`). Every failing run
took the reset/reconcile path and returned before that line, so the call has never
been exercised and has never 403'd. The scope was a prediction reasoned from the
symptom, and the symptom had a different cause.

The speculative grant has been dropped from this branch — see
`2026-09-03-drop-speculative-administration-scope.md`, which also records why the
scope must never be re-added: `administration` is a GitHub *App* permission and is
not a valid key in an Actions `permissions:` block at all, so declaring it makes
the workflow **unloadable** and produces a zero-job run (observed on this branch,
run `33696773987`). The call it was meant to enable needs only Metadata read,
which every workflow token already holds — run `33704559392` reached that check
and returned a real verdict with no such scope.

### Scope note

This fix rides along on PR #563 rather than arriving as its own change: #563
could not land without it. A failing `final-review-gate` leaves
`mergeStateStatus=UNSTABLE`, and `pr-merge-guard.mjs` requires `CLEAN` — so the
guard correctly refused to merge #563 over an unrelated broken workflow, and
weakening that check to get the change in was not an option.
